import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NullExecutionSink } from '../src/database/execution-recorder.js';
import { ExternalApiError, RateLimitError, ValidationError } from '../src/errors.js';
import { defineAction, DriverRegistry } from '../src/integrations/integration-driver.js';
import { Metrics } from '../src/observability/metrics.js';
import { BACKOFF_TYPE } from '../src/queue/automation.queue.js';
import type { AutomationJobData, RuntimeWorkflow } from '../src/types/workflow.js';
import { createAutomationProcessor, createBackoffStrategy, rateLimitDelay, type WorkerJob } from '../src/workers/automation.worker.js';
import { MemoryDeadLetterSink } from '../src/workers/dead-letter.js';
import { WorkflowEngine } from '../src/workflows/workflow-engine.js';
import { InMemoryRegistry, makeEndpoint, makeJobData, makeStep, makeWorkflow, silentLogger } from './helpers/fixtures.js';

class FakeJob implements WorkerJob {
  id = 'exec-job-1';
  name = 'workflow.execute';
  updates: AutomationJobData[] = [];
  constructor(
    public data: AutomationJobData,
    public attemptsMade = 0,
    public opts: { attempts?: number } = { attempts: 3 },
  ) {}
  delayedUntil: number | null = null;
  async updateData(data: AutomationJobData): Promise<void> {
    this.updates.push(data);
    this.data = data;
  }
  async moveToDelayed(timestamp: number): Promise<void> {
    this.delayedUntil = timestamp;
  }
}

interface Harness {
  workflow: RuntimeWorkflow;
  sink: NullExecutionSink;
  deadLetters: MemoryDeadLetterSink;
  metrics: Metrics;
  sent: string[];
  process: (job: WorkerJob, token?: string) => ReturnType<ReturnType<typeof createAutomationProcessor>>;
}

function harness(options: { failures?: Record<string, Error | undefined>; steps?: number } = {}): Harness {
  const sent: string[] = [];
  const action = defineAction({
    type: 'test.send',
    configSchema: z.object({ text: z.string() }),
    async execute(config, context) {
      context.markRequestStart();
      const failure = options.failures?.[context.stepKey];
      if (failure) throw failure;
      sent.push(`${context.stepKey}:${config.text}`);
      context.markResponse();
      return { output: { ok: true, step: context.stepKey } };
    },
  });
  const registry = new DriverRegistry().register({ name: 'test', actions: [action] });
  const endpoint = makeEndpoint();
  const steps = Array.from({ length: options.steps ?? 1 }, (_, i) => makeStep({ key: `s${i + 1}`, position: i, type: 'test.send', config: { text: '{{trigger.body.title}}' } }));
  const workflow = makeWorkflow(endpoint, steps);
  const workflows = new InMemoryRegistry().addEndpoint(endpoint).addWorkflow(workflow);
  const sink = new NullExecutionSink();
  const deadLetters = new MemoryDeadLetterSink();
  const metrics = new Metrics({ service: 'test', defaultMetrics: false });
  const process = createAutomationProcessor({
    workflows,
    engine: new WorkflowEngine({ registry, logger: silentLogger(), metrics, defaultStepTimeoutMs: 1_000 }),
    sink,
    deadLetters,
    logger: silentLogger(),
    metrics,
    jobTimeoutMs: 5_000,
    storeTriggerPayload: true,
    idempotencyTtlSec: 3_600,
  });
  return { workflow, sink, deadLetters, metrics, sent, process };
}

describe('automation worker processor', () => {
  it('executes the workflow and records RUNNING then SUCCEEDED with latency fields', async () => {
    const h = harness();
    const job = new FakeJob(makeJobData(h.workflow));
    const result = await h.process(job);

    expect(result.status).toBe('SUCCEEDED');
    expect(h.sent).toEqual(['s1:Hello']);
    expect(h.sink.executions.map((e) => e.status)).toEqual(['RUNNING', 'SUCCEEDED']);
    const done = h.sink.executions[1]!;
    expect(done.outboundStartLatencyMs).toBeGreaterThanOrEqual(0);
    expect(done.totalLatencyMs).toBeGreaterThanOrEqual(done.outboundStartLatencyMs!);
    expect(h.sink.executions[0]!.queueLatencyMs).toBeGreaterThanOrEqual(0);
    expect(h.sink.idempotencyKeys).toHaveLength(1);
    expect(h.sink.logs[0]).toMatchObject({ stepKey: 's1', level: 'INFO', message: 'step succeeded' });
    const snapshot = await h.metrics.latencySnapshot();
    for (const name of ['queue', 'worker_pre_dispatch', 'template_render', 'outbound_request_start', 'external_api', 'execution_duration', 'total_execution']) {
      expect(snapshot[name]?.['count'], name).toBe(1);
    }
  });

  it('rethrows retryable failures while attempts remain (no dead-letter)', async () => {
    const h = harness({ failures: { s1: new ExternalApiError('telegram 502', 502) } });
    const job = new FakeJob(makeJobData(h.workflow), 0, { attempts: 3 });
    const err = await h.process(job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(h.deadLetters.entries).toHaveLength(0);
    expect(h.sink.executions.at(-1)!.status).toBe('RETRYING');
  });

  it('dead-letters retryable failures once attempts are exhausted', async () => {
    const h = harness({ failures: { s1: new ExternalApiError('telegram 502', 502) } });
    const job = new FakeJob(makeJobData(h.workflow), 2, { attempts: 3 });
    const err = await h.process(job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalApiError);
    expect(h.deadLetters.entries).toHaveLength(1);
    expect(h.deadLetters.entries[0]).toMatchObject({ attempts: 3, workflowId: h.workflow.id, error: { category: 'EXTERNAL_API', retryable: true } });
    expect(h.sink.executions.at(-1)!.status).toBe('DEAD_LETTERED');
  });

  it('dead-letters non-retryable failures immediately and stops BullMQ retries', async () => {
    const h = harness({ failures: { s1: new ValidationError('bad chat id') } });
    const job = new FakeJob(makeJobData(h.workflow), 0, { attempts: 5 });
    const err = await h.process(job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('bad chat id');
    expect(h.deadLetters.entries).toHaveLength(1);
    expect(h.deadLetters.entries[0]!.error.category).toBe('VALIDATION');
  });

  it('dead-letters jobs whose workflow no longer exists', async () => {
    const h = harness();
    const data = { ...makeJobData(h.workflow), workflowId: '00000000-0000-4000-8000-000000000000' };
    const err = await h.process(new FakeJob(data)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(h.deadLetters.entries[0]!.error.code).toBe('WORKFLOW_UNAVAILABLE');
  });

  it('dead-letters malformed job payloads', async () => {
    const h = harness();
    const err = await h.process(new FakeJob({ nonsense: true } as unknown as AutomationJobData)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(h.deadLetters.entries[0]!.error.category).toBe('VALIDATION');
  });

  it('postpones rate-limited jobs without consuming a retry attempt or dead-lettering', async () => {
    const h = harness({ failures: { s1: new RateLimitError('429 from Telegram', 3_000) } });
    const job = new FakeJob(makeJobData(h.workflow), 4, { attempts: 5 }); // last attempt
    const before = Date.now();
    const err = await h.process(job, 'lock-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DelayedError);
    expect(job.delayedUntil).toBeGreaterThanOrEqual(before + 3_000);
    expect(job.data.rateLimitDeferrals).toBe(1);
    expect(h.deadLetters.entries).toHaveLength(0);
  });

  it('falls back to normal retries once the rate-limit deferral window is over', async () => {
    const h = harness({ failures: { s1: new RateLimitError('429', 1_000) } });
    const data = makeJobData(h.workflow);
    data.timings.receivedAt = Date.now() - 2 * 3_600_000;
    const err = await h.process(new FakeJob(data, 0, { attempts: 3 }), 'lock-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('persists step progress so a retry does not repeat completed steps', async () => {
    const failing = harness({ steps: 2, failures: { s2: new ExternalApiError('503', 503) } });
    const job = new FakeJob(makeJobData(failing.workflow), 0, { attempts: 3 });
    await failing.process(job).catch(() => undefined);
    expect(failing.sent).toEqual(['s1:Hello']);
    expect(job.data.resume?.completedSteps['s1']).toBeDefined();

    // Next attempt: same job data (as BullMQ would reload it), s2 now succeeds.
    const recovered = harness({ steps: 2 });
    const retryData = { ...job.data, workflowId: recovered.workflow.id, endpointId: recovered.workflow.endpointId };
    const result = await recovered.process(new FakeJob(retryData, 1, { attempts: 3 }));
    expect(recovered.sent).toEqual(['s2:Hello']);
    expect(result.steps).toEqual([
      { key: 's1', status: 'resumed' },
      { key: 's2', status: 'succeeded' },
    ]);
  });

  it('stores resume state with dead-lettered jobs for safe requeueing', async () => {
    const h = harness({ steps: 2, failures: { s2: new ValidationError('bad') } });
    await h.process(new FakeJob(makeJobData(h.workflow))).catch(() => undefined);
    const payload = h.deadLetters.entries[0]!.payload as AutomationJobData;
    expect(Object.keys(payload.resume!.completedSteps)).toEqual(['s1']);
  });
});

describe('rate-limit postponement delay', () => {
  it('adds bounded jitter on top of Retry-After', () => {
    expect(rateLimitDelay(2_000, () => 0)).toBe(2_000);
    expect(rateLimitDelay(2_000, () => 1)).toBe(3_000);
    expect(rateLimitDelay(50, () => 1)).toBe(150);
    expect(rateLimitDelay(undefined, () => 0)).toBe(1_000);
  });
});

describe('backoff strategy', () => {
  const strategy = createBackoffStrategy({ baseDelayMs: 1_000, maxDelayMs: 60_000 });

  it('honours Retry-After from rate-limit errors', () => {
    expect(strategy(1, BACKOFF_TYPE, new RateLimitError('429', 7_000))).toBe(7_000);
  });

  it('grows exponentially with jitter and is capped', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = strategy(attempt, BACKOFF_TYPE, new ExternalApiError('x', 500)) as number;
      const ceiling = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('ignores other backoff types', () => {
    expect(strategy(1, 'fixed', new Error('x'))).toBe(0);
  });
});
