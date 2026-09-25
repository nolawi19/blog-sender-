import { Prisma, type PrismaClient } from '@prisma/client';
import { classifyError, type SerializedError } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';

export type ExecutionStatus = 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTERED';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface ExecutionUpdate {
  id: string;
  workflowId: string;
  workflowVersion: number;
  endpointId: string;
  eventId: string;
  eventType: string;
  jobId: string;
  requestId?: string | null;
  status: ExecutionStatus;
  attempts: number;
  triggerPayload?: unknown;
  error?: SerializedError | null;
  receivedAt: number;
  enqueuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  queueLatencyMs?: number;
  outboundStartLatencyMs?: number;
  executionDurationMs?: number;
  totalLatencyMs?: number;
}

export interface ExecutionLogEntry {
  executionId: string;
  stepId?: string | null;
  stepKey?: string | null;
  attempt: number;
  level: LogLevel;
  message: string;
  data?: unknown;
  durationMs?: number | null;
  createdAt: number;
}

export interface IdempotencyRecord {
  endpointId: string;
  key: string;
  eventId: string;
  expiresAt: number;
}

export interface ExecutionBatch {
  executions: ExecutionUpdate[];
  logs: ExecutionLogEntry[];
  idempotencyKeys: IdempotencyRecord[];
}

export interface ExecutionWriter {
  write(batch: ExecutionBatch): Promise<void>;
}

/** Fire-and-forget persistence API used by the worker. Never blocks job processing. */
export interface ExecutionSink {
  recordExecution(update: ExecutionUpdate): void;
  appendLog(entry: ExecutionLogEntry): void;
  recordIdempotencyKey(record: IdempotencyRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

function mergeUpdate(prev: ExecutionUpdate, next: ExecutionUpdate): ExecutionUpdate {
  const merged: ExecutionUpdate = { ...prev };
  for (const [key, value] of Object.entries(next) as Array<[keyof ExecutionUpdate, unknown]>) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export interface BufferedRecorderOptions {
  writer: ExecutionWriter;
  logger: Logger;
  metrics?: Metrics;
  flushIntervalMs: number;
  maxBuffer: number;
}

/**
 * Buffers execution rows and logs in memory and writes them in batches.
 * Updates for the same execution are coalesced (RUNNING then SUCCEEDED becomes
 * one row write). When the buffer is full, new entries are dropped and counted
 * rather than applying backpressure to job processing.
 */
export class BufferedExecutionRecorder implements ExecutionSink {
  private executions = new Map<string, ExecutionUpdate>();
  private logs: ExecutionLogEntry[] = [];
  private idempotencyKeys = new Map<string, IdempotencyRecord>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: BufferedRecorderOptions) {
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs);
    this.timer.unref();
  }

  private get size(): number {
    return this.executions.size + this.logs.length + this.idempotencyKeys.size;
  }

  private drop(kind: string): void {
    this.options.metrics?.recorderDropped.inc({ kind });
  }

  recordExecution(update: ExecutionUpdate): void {
    const prev = this.executions.get(update.id);
    if (prev) {
      this.executions.set(update.id, mergeUpdate(prev, update));
      return;
    }
    if (this.closed || this.size >= this.options.maxBuffer) return this.drop('execution');
    this.executions.set(update.id, update);
  }

  appendLog(entry: ExecutionLogEntry): void {
    if (this.closed || this.size >= this.options.maxBuffer) return this.drop('log');
    this.logs.push(entry);
  }

  recordIdempotencyKey(record: IdempotencyRecord): void {
    if (this.closed || this.size >= this.options.maxBuffer) return this.drop('idempotency');
    this.idempotencyKeys.set(`${record.endpointId}|${record.key}`, record);
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.size === 0) return Promise.resolve();
    const batch: ExecutionBatch = {
      executions: [...this.executions.values()],
      logs: this.logs,
      idempotencyKeys: [...this.idempotencyKeys.values()],
    };
    this.executions = new Map();
    this.logs = [];
    this.idempotencyKeys = new Map();

    this.flushing = this.writeBatch(batch).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async writeBatch(batch: ExecutionBatch): Promise<void> {
    try {
      await this.options.writer.write(batch);
      return;
    } catch (err) {
      const classified = classifyError(err);
      if (classified.retryable) {
        this.options.logger.warn({ err, executions: batch.executions.length, logs: batch.logs.length }, 'execution batch write failed, will retry');
        this.requeue(batch);
        return;
      }
      this.options.logger.warn({ err }, 'execution batch rejected, isolating rows');
    }
    // A non-transient failure (e.g. a row referencing a deleted workflow) must
    // not poison the whole batch: write rows one by one and drop the bad ones.
    for (const execution of batch.executions) {
      const logs = batch.logs.filter((l) => l.executionId === execution.id);
      try {
        await this.options.writer.write({ executions: [execution], logs, idempotencyKeys: [] });
      } catch (err) {
        this.drop('execution');
        this.options.logger.error({ err, executionId: execution.id }, 'dropping execution record that cannot be written');
      }
    }
    const orphanLogs = batch.logs.filter((l) => !batch.executions.some((e) => e.id === l.executionId));
    for (const record of [...batch.idempotencyKeys.map((k) => ({ k })), ...orphanLogs.map((l) => ({ l }))]) {
      try {
        await this.options.writer.write({
          executions: [],
          logs: 'l' in record ? [record.l] : [],
          idempotencyKeys: 'k' in record ? [record.k] : [],
        });
      } catch {
        this.drop('k' in record ? 'idempotency' : 'log');
      }
    }
  }

  private requeue(batch: ExecutionBatch): void {
    for (const execution of batch.executions) {
      const newer = this.executions.get(execution.id);
      this.executions.set(execution.id, newer ? mergeUpdate(execution, newer) : execution);
    }
    const room = Math.max(0, this.options.maxBuffer - this.size);
    const keptLogs = batch.logs.slice(-room);
    for (let i = 0; i < batch.logs.length - keptLogs.length; i++) this.drop('log');
    this.logs = [...keptLogs, ...this.logs];
    for (const record of batch.idempotencyKeys) {
      const key = `${record.endpointId}|${record.key}`;
      if (!this.idempotencyKeys.has(key)) this.idempotencyKeys.set(key, record);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (let attempt = 0; attempt < 3 && (this.size > 0 || this.flushing); attempt++) {
      if (this.flushing) await this.flushing;
      await this.flush();
    }
    if (this.size > 0) this.options.logger.error({ pending: this.size }, 'execution records lost at shutdown');
  }
}

const EXECUTION_CHUNK_ROWS = 500;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | undefined): string | null => (ms === undefined ? null : iso(ms));
const jsonOrNull = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));

export class PrismaExecutionWriter implements ExecutionWriter {
  constructor(private readonly prisma: PrismaClient) {}

  async write(batch: ExecutionBatch): Promise<void> {
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    // 22 bind parameters per row; chunk to stay far below PostgreSQL's 65,535 limit.
    for (let i = 0; i < batch.executions.length; i += EXECUTION_CHUNK_ROWS) {
      operations.push(this.prisma.$executeRaw(this.upsertExecutionsSql(batch.executions.slice(i, i + EXECUTION_CHUNK_ROWS))));
    }
    if (batch.logs.length > 0) {
      operations.push(
        this.prisma.executionLog.createMany({
          data: batch.logs.map((l) => ({
            executionId: l.executionId,
            stepId: l.stepId ?? null,
            stepKey: l.stepKey ?? null,
            attempt: l.attempt,
            level: l.level,
            message: l.message,
            data: l.data === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(l.data)) as Prisma.InputJsonValue),
            durationMs: l.durationMs ?? null,
            createdAt: new Date(l.createdAt),
          })),
        }),
      );
    }
    if (batch.idempotencyKeys.length > 0) {
      operations.push(
        this.prisma.idempotencyKey.createMany({
          data: batch.idempotencyKeys.map((k) => ({ endpointId: k.endpointId, key: k.key, eventId: k.eventId, expiresAt: new Date(k.expiresAt) })),
          skipDuplicates: true,
        }),
      );
    }
    if (operations.length > 0) await this.prisma.$transaction(operations);
  }

  /** One multi-row INSERT ... ON CONFLICT per flush instead of N upserts. */
  private upsertExecutionsSql(rows: ExecutionUpdate[]): Prisma.Sql {
    const values = rows.map(
      (e) => Prisma.sql`(
        ${e.id}::uuid, ${e.workflowId}::uuid, ${e.workflowVersion}::int, ${e.endpointId}::uuid, ${e.eventId}::uuid,
        ${e.eventType}, ${e.jobId}, ${e.requestId ?? null}, ${e.status}::"ExecutionStatus", ${e.attempts}::int,
        ${jsonOrNull(e.triggerPayload)}::jsonb, ${jsonOrNull(e.error)}::jsonb,
        ${iso(e.receivedAt)}::timestamptz, ${iso(e.enqueuedAt)}::timestamptz,
        ${isoOrNull(e.startedAt)}::timestamptz, ${isoOrNull(e.finishedAt)}::timestamptz,
        ${e.queueLatencyMs ?? null}::float8, ${e.outboundStartLatencyMs ?? null}::float8,
        ${e.executionDurationMs ?? null}::float8, ${e.totalLatencyMs ?? null}::float8, now(), now()
      )`,
    );
    return Prisma.sql`
      INSERT INTO "executions" (
        "id", "workflow_id", "workflow_version", "endpoint_id", "event_id",
        "event_type", "job_id", "request_id", "status", "attempts",
        "trigger_payload", "error", "received_at", "enqueued_at", "started_at", "finished_at",
        "queue_latency_ms", "outbound_start_latency_ms", "execution_duration_ms", "total_latency_ms",
        "created_at", "updated_at"
      ) VALUES ${Prisma.join(values)}
      ON CONFLICT ("id") DO UPDATE SET
        "status" = EXCLUDED."status",
        "attempts" = GREATEST("executions"."attempts", EXCLUDED."attempts"),
        "trigger_payload" = COALESCE("executions"."trigger_payload", EXCLUDED."trigger_payload"),
        "error" = EXCLUDED."error",
        "request_id" = COALESCE("executions"."request_id", EXCLUDED."request_id"),
        "started_at" = COALESCE(EXCLUDED."started_at", "executions"."started_at"),
        "finished_at" = COALESCE(EXCLUDED."finished_at", "executions"."finished_at"),
        "queue_latency_ms" = COALESCE(EXCLUDED."queue_latency_ms", "executions"."queue_latency_ms"),
        "outbound_start_latency_ms" = COALESCE(EXCLUDED."outbound_start_latency_ms", "executions"."outbound_start_latency_ms"),
        "execution_duration_ms" = COALESCE(EXCLUDED."execution_duration_ms", "executions"."execution_duration_ms"),
        "total_latency_ms" = COALESCE(EXCLUDED."total_latency_ms", "executions"."total_latency_ms"),
        "updated_at" = now()`;
  }
}

/** No-op sink for tests and for running without PostgreSQL. */
export class NullExecutionSink implements ExecutionSink {
  readonly executions: ExecutionUpdate[] = [];
  readonly logs: ExecutionLogEntry[] = [];
  readonly idempotencyKeys: IdempotencyRecord[] = [];
  recordExecution(update: ExecutionUpdate): void {
    this.executions.push(update);
  }
  appendLog(entry: ExecutionLogEntry): void {
    this.logs.push(entry);
  }
  recordIdempotencyKey(record: IdempotencyRecord): void {
    this.idempotencyKeys.push(record);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}
