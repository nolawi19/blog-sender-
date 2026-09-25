import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { RedisError } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { AutomationJobData } from '../types/workflow.js';

export const AUTOMATION_QUEUE_NAME = 'automation';
export const DEAD_LETTER_QUEUE_NAME = 'automation-dead-letter';
export const EXECUTE_JOB_NAME = 'workflow.execute';
export const DEAD_LETTER_JOB_NAME = 'dead-letter';
/** Backoff type resolved by the worker's custom backoff strategy. */
export const BACKOFF_TYPE = 'automation-backoff';
/** Redis pub/sub channel used to tell gateways and workers to reload workflows. */
export const CACHE_INVALIDATION_CHANNEL = 'automation:cache:invalidate';

export type AutomationQueue = Queue<AutomationJobData, unknown, string>;

/** BullMQ custom job ids must not contain ':' and must not be plain integers. */
export function jobIdFor(executionId: string): string {
  return `exec-${executionId}`;
}

export function buildJobOptions(maxRetries: number): JobsOptions {
  return {
    attempts: maxRetries + 1,
    backoff: { type: BACKOFF_TYPE },
    // Keep recent history for inspection without letting Redis grow unbounded.
    removeOnComplete: { age: 3_600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3_600, count: 50_000 },
  };
}

export function createAutomationQueue(connection: Redis, maxRetries: number): AutomationQueue {
  return new Queue<AutomationJobData, unknown, string>(AUTOMATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: buildJobOptions(maxRetries),
  });
}

export function createDeadLetterQueue(connection: Redis): Queue {
  return new Queue(DEAD_LETTER_QUEUE_NAME, {
    connection,
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });
}

/** Abstraction the gateway depends on, so tests can capture jobs without Redis. */
export interface EventPublisher {
  publish(jobs: readonly AutomationJobData[]): Promise<void>;
}

export class BullMqEventPublisher implements EventPublisher {
  constructor(private readonly queue: AutomationQueue) {}

  async publish(jobs: readonly AutomationJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    try {
      if (jobs.length === 1) {
        const job = jobs[0] as AutomationJobData;
        await this.queue.add(EXECUTE_JOB_NAME, job, { jobId: jobIdFor(job.executionId) });
        return;
      }
      // addBulk sends all jobs in one MULTI round trip.
      await this.queue.addBulk(jobs.map((data) => ({ name: EXECUTE_JOB_NAME, data, opts: { jobId: jobIdFor(data.executionId) } })));
    } catch (err) {
      throw new RedisError(`Failed to enqueue ${jobs.length} job(s)`, { cause: err });
    }
  }
}

/**
 * Polls the queue's waiting count in the background so the gateway can apply
 * backpressure without an extra Redis round trip per request.
 */
export class QueueDepthMonitor {
  private waiting = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: Pick<AutomationQueue, 'getWaitingCount'>,
    private readonly threshold: number,
    private readonly logger: Logger,
    private readonly intervalMs = 1_000,
  ) {}

  start(): void {
    if (this.timer) return;
    const poll = async (): Promise<void> => {
      try {
        this.waiting = await this.queue.getWaitingCount();
      } catch (err) {
        this.logger.debug({ err }, 'queue depth poll failed');
      }
    };
    void poll();
    this.timer = setInterval(() => void poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get depth(): number {
    return this.waiting;
  }

  isOverloaded(): boolean {
    return this.waiting >= this.threshold;
  }
}
