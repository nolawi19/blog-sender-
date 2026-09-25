import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { SerializedError } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import { DEAD_LETTER_JOB_NAME } from '../queue/automation.queue.js';
import type { AutomationJobData } from '../types/workflow.js';

export interface DeadLetterRecord {
  executionId: string | null;
  jobId: string;
  queueName: string;
  workflowId: string | null;
  eventId: string | null;
  payload: AutomationJobData | Record<string, unknown>;
  error: SerializedError;
  attempts: number;
}

export interface DeadLetterSink {
  record(entry: DeadLetterRecord): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null): string | null => (v && UUID.test(v) ? v : null);

/**
 * Persists permanently failed jobs to PostgreSQL (for querying and safe
 * requeueing) and mirrors them into a BullMQ dead-letter queue (for tooling
 * such as Bull Board). Either write may fail independently; both are attempted.
 */
export class PrismaDeadLetterSink implements DeadLetterSink {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: Queue | null,
    private readonly logger: Logger,
  ) {}

  async record(entry: DeadLetterRecord): Promise<void> {
    let deadLetterId: string | null = null;
    try {
      const row = await this.prisma.deadLetterJob.create({
        data: {
          executionId: uuidOrNull(entry.executionId),
          jobId: entry.jobId,
          queueName: entry.queueName,
          workflowId: uuidOrNull(entry.workflowId),
          eventId: uuidOrNull(entry.eventId),
          payload: JSON.parse(JSON.stringify(entry.payload)) as Prisma.InputJsonValue,
          error: JSON.parse(JSON.stringify(entry.error)) as Prisma.InputJsonValue,
          errorCategory: entry.error.category,
          attempts: entry.attempts,
        },
        select: { id: true },
      });
      deadLetterId = row.id;
    } catch (err) {
      this.logger.error({ err, jobId: entry.jobId, executionId: entry.executionId }, 'failed to persist dead-letter record');
    }
    if (!this.queue) return;
    try {
      await this.queue.add(DEAD_LETTER_JOB_NAME, { ...entry, deadLetterId }, { jobId: `dlq-${entry.jobId}-${entry.attempts}` });
    } catch (err) {
      this.logger.error({ err, jobId: entry.jobId }, 'failed to publish to dead-letter queue');
    }
  }
}

/** In-memory sink for tests and database-less runs. */
export class MemoryDeadLetterSink implements DeadLetterSink {
  readonly entries: DeadLetterRecord[] = [];
  async record(entry: DeadLetterRecord): Promise<void> {
    this.entries.push(entry);
  }
}
