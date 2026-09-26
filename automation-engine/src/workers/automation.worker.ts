import { DelayedError, UnrecoverableError, Worker, type BackoffStrategy } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ExecutionSink, ExecutionUpdate } from '../database/execution-recorder.js';
import { AppError, classifyError, ConfigurationError, serializeError, ValidationError } from '../errors.js';
import { retryDelayFor, type BackoffPolicy } from '../lib/retry.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { nowMs, roundMs, type Clock } from '../observability/timing.js';
import { AUTOMATION_QUEUE_NAME, BACKOFF_TYPE } from '../queue/automation.queue.js';
import { automationJobDataSchema, type AutomationJobData, type StepExecutionRecord, type StepResumeRecord } from '../types/workflow.js';
import { StepFailedError, type WorkflowEngine } from '../workflows/workflow-engine.js';
import type { WorkflowSource } from '../workflows/workflow-loader.js';
import type { DeadLetterSink } from './dead-letter.js';

/** The subset of a BullMQ Job the processor uses (keeps it unit-testable). */
export interface WorkerJob {
  id?: string | undefined;
  name: string;
  data: AutomationJobData;
  attemptsMade: number;
  opts: { attempts?: number | undefined };
  updateData(data: AutomationJobData): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export interface ProcessorResult {
  executionId: string;
  status: 'SUCCEEDED';
  steps: Array<{ key: string; status: string }>;
  outboundStartLatencyMs?: number;
}

export interface ProcessorDeps {
  workflows: WorkflowSource;
  engine: WorkflowEngine;
  sink: ExecutionSink;
  deadLetters: DeadLetterSink;
  logger: Logger;
  metrics?: Metrics;
  clock?: Clock;
  jobTimeoutMs: number;
  storeTriggerPayload: boolean;
  idempotencyTtlSec: number;
  /** How long a job may keep being postponed by rate limits before normal retries apply. */
  rateLimitMaxDeferMs?: number;
  queueName?: string;
}

/** Retry-After plus jitter, so jobs postponed together do not all wake at once. */
export function rateLimitDelay(retryAfterMs: number | undefined, random: () => number = Math.random): number {
  const base = Math.max(retryAfterMs ?? 1_000, 10);
  return Math.round(base + random() * Math.min(Math.max(base, 100), 1_000));
}

function unwrap(err: unknown): { error: AppError; steps: StepExecutionRecord[]; failedStep: StepExecutionRecord | undefined } {
  if (err instanceof StepFailedError) return { error: err.error, steps: err.steps, failedStep: err.failedStep };
  return { error: classifyError(err), steps: [], failedStep: undefined };
}

/**
 * Builds the BullMQ processor. Responsibilities:
 *  - validate the job, resolve the workflow from the in-memory snapshot;
 *  - run the engine with a job-level timeout and step-level resume state;
 *  - record execution rows and step logs asynchronously (never blocking);
 *  - decide retry vs. dead-letter from the classified error:
 *      non-retryable            -> dead-letter + UnrecoverableError (no retries)
 *      retryable, attempts left -> rethrow (BullMQ retries with our backoff)
 *      retryable, exhausted     -> dead-letter + rethrow (job marked failed)
 */
export function createAutomationProcessor(deps: ProcessorDeps): (job: WorkerJob, token?: string) => Promise<ProcessorResult> {
  const clock = deps.clock ?? nowMs;
  const queueName = deps.queueName ?? AUTOMATION_QUEUE_NAME;
  const rateLimitMaxDeferMs = deps.rateLimitMaxDeferMs ?? 3_600_000;

  return async function processAutomationJob(job: WorkerJob, token?: string): Promise<ProcessorResult> {
    const startedAt = clock();
    const attempt = job.attemptsMade + 1;
    const maxAttempts = Math.max(1, job.opts.attempts ?? 1);
    const jobId = job.id ?? 'unknown';

    const parsed = automationJobDataSchema.safeParse(job.data);
    if (!parsed.success) {
      const error = new ValidationError('Malformed job payload', {
        details: { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
      deps.logger.error({ jobId, err: error }, 'dropping malformed job to dead-letter store');
      await deps.deadLetters.record({
        executionId: null,
        jobId,
        queueName,
        workflowId: null,
        eventId: null,
        payload: (job.data ?? {}) as Record<string, unknown>,
        error: serializeError(error),
        attempts: attempt,
      });
      deps.metrics?.deadLetters.inc({ category: error.category });
      throw new UnrecoverableError(error.message);
    }

    const data = parsed.data;
    const log = deps.logger.child({
      executionId: data.executionId,
      eventId: data.event.id,
      workflowId: data.workflowId,
      requestId: data.event.metadata.requestId,
      jobId,
      attempt,
    });
    // Latency metrics only describe the first pickup; retries, rate-limit
    // postponements and manual requeues would otherwise inflate them.
    const isFirstDelivery = attempt === 1 && !data.requeuedFrom && !data.rateLimitDeferrals;
    const queueLatencyMs = roundMs(startedAt - data.timings.enqueuedAt);
    if (isFirstDelivery) deps.metrics?.observe('queue', queueLatencyMs);

    const base: Omit<ExecutionUpdate, 'status'> = {
      id: data.executionId,
      workflowId: data.workflowId,
      workflowVersion: data.workflowVersion,
      endpointId: data.endpointId,
      eventId: data.event.id,
      eventType: data.event.type,
      jobId,
      requestId: data.event.metadata.requestId,
      attempts: attempt,
      receivedAt: data.timings.receivedAt,
      enqueuedAt: data.timings.enqueuedAt,
    };
    const running: ExecutionUpdate = { ...base, status: 'RUNNING', startedAt };
    if (isFirstDelivery) running.queueLatencyMs = queueLatencyMs;
    if (deps.storeTriggerPayload) running.triggerPayload = data.event;
    deps.sink.recordExecution(running);
    if (attempt === 1 && data.idempotencyKey) {
      deps.sink.recordIdempotencyKey({
        endpointId: data.endpointId,
        key: data.idempotencyKey,
        eventId: data.event.id,
        expiresAt: data.timings.receivedAt + deps.idempotencyTtlSec * 1000,
      });
    }

    const completedSteps: Record<string, StepResumeRecord> = { ...(data.resume?.completedSteps ?? {}) };
    const writeStepLogs = (steps: StepExecutionRecord[]): void => {
      for (const step of steps) {
        deps.sink.appendLog({
          executionId: data.executionId,
          stepId: step.stepId,
          stepKey: step.stepKey,
          attempt,
          level: step.status === 'failed' ? 'ERROR' : 'INFO',
          message: `step ${step.status}`,
          data: {
            type: step.type,
            templateMs: step.templateMs,
            outboundStartLatencyMs: step.outboundStartLatencyMs,
            externalLatencyMs: step.externalLatencyMs,
            output: step.output,
            error: step.error,
          },
          durationMs: step.durationMs,
          createdAt: step.finishedAt,
        });
      }
    };

    try {
      const workflow = await deps.workflows.resolveWorkflow(data.workflowId, data.workflowVersion);
      if (!workflow) {
        throw new ConfigurationError(`Workflow ${data.workflowId} is not found or not active`, { code: 'WORKFLOW_UNAVAILABLE' });
      }

      const outcome = await deps.engine.execute({
        workflow,
        event: data.event,
        executionId: data.executionId,
        attempt,
        receivedAt: data.timings.receivedAt,
        completedSteps,
        signal: AbortSignal.timeout(deps.jobTimeoutMs),
        onStepCompleted: async (stepKey, record) => {
          completedSteps[stepKey] = record;
          await job.updateData({ ...data, resume: { completedSteps } });
        },
      });

      const finishedAt = clock();
      const executionDurationMs = roundMs(finishedAt - startedAt);
      const totalLatencyMs = roundMs(finishedAt - data.timings.receivedAt);
      const outboundStartLatencyMs =
        outcome.firstRequestStartedAt === undefined ? undefined : roundMs(outcome.firstRequestStartedAt - data.timings.receivedAt);
      if (outcome.firstRequestStartedAt !== undefined) {
        deps.metrics?.observe('worker_pre_dispatch', outcome.firstRequestStartedAt - startedAt);
      }
      deps.metrics?.observe('execution_duration', executionDurationMs);
      if (isFirstDelivery) deps.metrics?.observe('total_execution', totalLatencyMs);
      deps.metrics?.jobsProcessed.inc({ status: 'succeeded' });

      const succeeded: ExecutionUpdate = { ...base, status: 'SUCCEEDED', finishedAt, executionDurationMs, totalLatencyMs, error: null };
      if (outboundStartLatencyMs !== undefined) succeeded.outboundStartLatencyMs = outboundStartLatencyMs;
      deps.sink.recordExecution(succeeded);
      writeStepLogs(outcome.steps);

      log.info(
        {
          queueLatencyMs,
          outboundStartLatencyMs,
          executionDurationMs,
          totalLatencyMs,
          steps: outcome.steps.map((s) => ({ key: s.stepKey, status: s.status, ms: s.durationMs, externalMs: s.externalLatencyMs })),
        },
        'execution succeeded',
      );

      const result: ProcessorResult = {
        executionId: data.executionId,
        status: 'SUCCEEDED',
        steps: outcome.steps.map((s) => ({ key: s.stepKey, status: s.status })),
      };
      if (outboundStartLatencyMs !== undefined) result.outboundStartLatencyMs = outboundStartLatencyMs;
      return result;
    } catch (raw) {
      const { error, steps, failedStep } = unwrap(raw);
      const finishedAt = clock();
      const serialized = serializeError(error);
      if (failedStep) {
        serialized.failedStep = failedStep.stepKey;
        serialized.failedStepType = failedStep.type;
      }
      // Everything an operator needs to diagnose the failure, on one log line.
      const failure = {
        err: error,
        failedStep: failedStep?.stepKey,
        failedStepType: failedStep?.type,
        category: error.category,
        code: error.code,
        hint: error.details?.['hint'],
      };

      // Rate limits are not failures: postpone the job without spending a retry
      // attempt (BullMQ DelayedError), up to rateLimitMaxDeferMs after receipt.
      if (error.category === 'RATE_LIMIT' && token !== undefined && finishedAt - data.timings.receivedAt < rateLimitMaxDeferMs) {
        const delayMs = rateLimitDelay(error.retryAfterMs);
        const deferrals = (data.rateLimitDeferrals ?? 0) + 1;
        await job.updateData({ ...data, resume: { completedSteps }, rateLimitDeferrals: deferrals });
        await job.moveToDelayed(Date.now() + delayMs, token);
        writeStepLogs(steps);
        serialized.retryStatus = 'postponed_rate_limit';
        deps.sink.recordExecution({ ...base, status: 'RETRYING', finishedAt, error: serialized });
        deps.metrics?.jobsProcessed.inc({ status: 'rate_limited' });
        log.info({ ...failure, err: undefined, retryStatus: serialized.retryStatus, delayMs, deferrals }, 'rate limited; job postponed without consuming a retry');
        throw new DelayedError();
      }

      const exhausted = attempt >= maxAttempts;
      const final = !error.retryable || exhausted;
      writeStepLogs(steps);
      deps.metrics?.jobFailures.inc({ category: error.category });

      if (final) {
        serialized.retryStatus = 'dead_lettered';
        await deps.deadLetters.record({
          executionId: data.executionId,
          jobId,
          queueName,
          workflowId: data.workflowId,
          eventId: data.event.id,
          payload: { ...data, resume: { completedSteps } },
          error: serialized,
          attempts: attempt,
        });
        deps.sink.recordExecution({ ...base, status: 'DEAD_LETTERED', finishedAt, error: serialized });
        deps.metrics?.deadLetters.inc({ category: error.category });
        deps.metrics?.jobsProcessed.inc({ status: 'dead_lettered' });
        log.error({ ...failure, retryStatus: serialized.retryStatus, retryable: error.retryable, exhausted }, 'execution failed permanently; moved to dead-letter store');
        if (!error.retryable) throw new UnrecoverableError(`[${error.code}] ${serialized.message}`);
        throw error;
      }

      serialized.retryStatus = 'retry_scheduled';
      deps.sink.recordExecution({ ...base, status: 'RETRYING', finishedAt, error: serialized });
      deps.metrics?.jobRetries.inc({ category: error.category });
      deps.metrics?.jobsProcessed.inc({ status: 'retrying' });
      log.warn(
        { ...failure, retryStatus: serialized.retryStatus, nextAttempt: attempt + 1, maxAttempts, retryAfterMs: error.retryAfterMs },
        'execution failed; retry scheduled',
      );
      throw error;
    }
  };
}

/** BullMQ custom backoff: honours Retry-After from the error, else exponential + jitter. */
export function createBackoffStrategy(policy: BackoffPolicy): BackoffStrategy {
  return (attemptsMade, type, err) => {
    if (type !== BACKOFF_TYPE) return 0;
    return retryDelayFor(err, attemptsMade, policy);
  };
}

export interface AutomationWorkerOptions {
  connection: Redis;
  concurrency: number;
  processor: (job: WorkerJob, token?: string) => Promise<ProcessorResult>;
  backoff: BackoffPolicy;
  logger: Logger;
  lockDurationMs?: number;
}

export function createAutomationWorker(options: AutomationWorkerOptions): Worker<AutomationJobData, ProcessorResult> {
  const worker = new Worker<AutomationJobData, ProcessorResult>(AUTOMATION_QUEUE_NAME, (job, token) => options.processor(job, token), {
    connection: options.connection,
    concurrency: options.concurrency,
    autorun: false,
    // Locks are renewed automatically while a job runs; a crashed worker's jobs
    // become "stalled" after lockDuration and are moved back to waiting.
    lockDuration: options.lockDurationMs ?? 30_000,
    stalledInterval: 15_000,
    maxStalledCount: 2,
    settings: { backoffStrategy: createBackoffStrategy(options.backoff) },
  });
  worker.on('error', (err) => options.logger.error({ err }, 'worker error'));
  worker.on('stalled', (jobId) => options.logger.warn({ jobId }, 'job stalled (worker crashed or event loop blocked); it will be retried'));
  return worker;
}
