import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExternalApiError } from '../src/errors.js';
import { defineAction, DriverRegistry, type ActionContext } from '../src/integrations/integration-driver.js';
import { Metrics } from '../src/observability/metrics.js';
import { StepFailedError, WorkflowEngine } from '../src/workflows/workflow-engine.js';
import { makeEndpoint, makeEvent, makeStep, makeWorkflow, silentLogger } from './helpers/fixtures.js';

interface Call {
  type: string;
  config: unknown;
  context: ActionContext;
}

function testRegistry(calls: Call[], behaviour: { failWith?: Error; delayMs?: number } = {}): DriverRegistry {
  const record = (type: string) =>
    defineAction({
      type,
      configSchema: z.record(z.string(), z.unknown()),
      credentialProvider: 'test',
      async execute(config, context) {
        context.markRequestStart();
        calls.push({ type, config, context });
        if (behaviour.delayMs) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, behaviour.delayMs);
            context.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(context.signal.reason);
            });
          });
        }
        if (behaviour.failWith) throw behaviour.failWith;
        context.markResponse();
        return { output: { echoed: config, n: calls.length } };
      },
    });
  return new DriverRegistry().register({ name: 'test', actions: [record('test.echo'), record('test.other')] });
}

function engineWith(registry: DriverRegistry, metrics?: Metrics): WorkflowEngine {
  return new WorkflowEngine({ registry, logger: silentLogger(), defaultStepTimeoutMs: 1_000, ...(metrics ? { metrics } : {}) });
}

describe('WorkflowEngine', () => {
  it('runs steps in order, rendering templates from the trigger and earlier step outputs', async () => {
    const calls: Call[] = [];
    const endpoint = makeEndpoint();
    const workflow = makeWorkflow(endpoint, [
      makeStep({ key: 'first', type: 'test.echo', config: { chatId: '{{trigger.body.telegram_chat_id}}', caption: '{{trigger.body.title}} by {{trigger.body.author.name}}' } }),
      makeStep({ key: 'second', type: 'test.other', position: 1, config: { replyTo: '{{steps.first.output.n}}', workflow: '{{workflow.name}}' } }),
    ]);
    const event = makeEvent({ title: 'Post', author: { name: 'Alex' }, telegram_chat_id: 42 });
    const outcome = await engineWith(testRegistry(calls)).execute({ workflow, event, executionId: 'exec-1', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) });

    expect(calls.map((c) => c.type)).toEqual(['test.echo', 'test.other']);
    expect(calls[0]!.config).toEqual({ chatId: 42, caption: 'Post by Alex' });
    expect(calls[1]!.config).toEqual({ replyTo: 1, workflow: 'test workflow' });
    expect(outcome.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(outcome.firstRequestStartedAt).toBeDefined();
    expect(outcome.steps[0]!.outboundStartLatencyMs).toBeGreaterThanOrEqual(0);
    expect(outcome.steps[0]!.externalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('skips steps whose runIf is falsy', async () => {
    const calls: Call[] = [];
    const endpoint = makeEndpoint();
    const workflow = makeWorkflow(endpoint, [
      makeStep({ key: 'photo', runIf: '{{trigger.body.image}}' }),
      makeStep({ key: 'text', position: 1, runIf: '{{trigger.body.image | not}}' }),
    ]);
    const outcome = await engineWith(testRegistry(calls)).execute({ workflow, event: makeEvent({ title: 'no image' }), executionId: 'e', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) });
    expect(outcome.steps.map((s) => [s.stepKey, s.status])).toEqual([
      ['photo', 'skipped'],
      ['text', 'succeeded'],
    ]);
    expect(calls).toHaveLength(1);
  });

  it('resumes after a retry without re-running completed steps', async () => {
    const calls: Call[] = [];
    const endpoint = makeEndpoint();
    const workflow = makeWorkflow(endpoint, [
      makeStep({ key: 'first' }),
      makeStep({ key: 'second', position: 1, config: { from: '{{steps.first.output.messageId}}' } }),
    ]);
    const outcome = await engineWith(testRegistry(calls)).execute({
      workflow,
      event: makeEvent(),
      executionId: 'e',
      attempt: 2,
      receivedAt: Date.now(),
      signal: AbortSignal.timeout(5_000),
      completedSteps: { first: { output: { messageId: 77 }, completedAt: Date.now() } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config).toEqual({ from: 77 });
    expect(outcome.steps.map((s) => s.status)).toEqual(['resumed', 'succeeded']);
  });

  it('persists resume state after every step except the last', async () => {
    const calls: Call[] = [];
    const persisted: string[] = [];
    const workflow = makeWorkflow(makeEndpoint(), [makeStep({ key: 'a' }), makeStep({ key: 'b', position: 1 }), makeStep({ key: 'c', position: 2 })]);
    await engineWith(testRegistry(calls)).execute({
      workflow,
      event: makeEvent(),
      executionId: 'e',
      attempt: 1,
      receivedAt: Date.now(),
      signal: AbortSignal.timeout(5_000),
      onStepCompleted: async (key) => {
        persisted.push(key);
      },
    });
    expect(persisted).toEqual(['a', 'b']);
  });

  it('wraps driver failures with the failing step and the classified error', async () => {
    const workflow = makeWorkflow(makeEndpoint(), [makeStep({ key: 'announce' })]);
    const failure = new ExternalApiError('telegram down', 503);
    const err = await engineWith(testRegistry([], { failWith: failure }))
      .execute({ workflow, event: makeEvent(), executionId: 'e', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as StepFailedError).error).toBe(failure);
    expect((err as StepFailedError).failedStep.stepKey).toBe('announce');
    expect((err as StepFailedError).failedStep.status).toBe('failed');
  });

  it('enforces per-step timeouts as retryable TimeoutErrors', async () => {
    const workflow = makeWorkflow(makeEndpoint(), [makeStep({ key: 'slow', timeoutMs: 50 })]);
    const err = (await engineWith(testRegistry([], { delayMs: 1_000 }))
      .execute({ workflow, event: makeEvent(), executionId: 'e', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e)) as StepFailedError;
    expect(err.error.category).toBe('TIMEOUT');
    expect(err.error.retryable).toBe(true);
  });

  it('fails unknown step types and strict template errors without retry', async () => {
    const unknownType = makeWorkflow(makeEndpoint(), [makeStep({ type: 'slack.postMessage' })]);
    const e1 = (await engineWith(testRegistry([]))
      .execute({ workflow: unknownType, event: makeEvent(), executionId: 'e', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e)) as StepFailedError;
    expect(e1.error.code).toBe('UNKNOWN_STEP_TYPE');
    expect(e1.error.retryable).toBe(false);
  });

  it('rejects credentials from another provider', async () => {
    const workflow = makeWorkflow(makeEndpoint(), [makeStep({ credential: { id: 'c', name: 'x', provider: 'telegram', data: {} } })]);
    const err = (await engineWith(testRegistry([]))
      .execute({ workflow, event: makeEvent(), executionId: 'e', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e)) as StepFailedError;
    expect(err.error.code).toBe('CREDENTIAL_MISMATCH');
  });

  it('records template, outbound-start and external latencies', async () => {
    const metrics = new Metrics({ service: 'test', defaultMetrics: false });
    const workflow = makeWorkflow(makeEndpoint(), [makeStep()]);
    await engineWith(testRegistry([]), metrics).execute({ workflow, event: makeEvent(), executionId: 'e', attempt: 1, receivedAt: Date.now(), signal: AbortSignal.timeout(5_000) });
    const snapshot = await metrics.latencySnapshot();
    expect(snapshot['template_render']?.['count']).toBe(1);
    expect(snapshot['outbound_request_start']?.['count']).toBe(1);
    expect(snapshot['external_api']?.['count']).toBe(1);
  });
});
