import { describe, expect, it, vi } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import {
  AppError,
  classifyError,
  DatabaseError,
  ExternalApiError,
  NetworkError,
  RateLimitError,
  RedisError,
  serializeError,
  TimeoutError,
  UnknownError,
  ValidationError,
} from '../src/errors.js';
import { BufferedExecutionRecorder, type ExecutionBatch, type ExecutionUpdate } from '../src/database/execution-recorder.js';
import { TokenBucketLimiter } from '../src/lib/rate-limiter.js';
import { computeBackoffDelay, retryAsync, sleep } from '../src/lib/retry.js';
import { ShutdownManager } from '../src/lib/shutdown.js';
import { BOT_TOKEN, silentLogger, TEST_ENV } from './helpers/fixtures.js';

describe('error classification', () => {
  const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

  it('classifies network, timeout, database, redis and unknown errors', () => {
    expect(classifyError(withCode('ECONNREFUSED'))).toBeInstanceOf(NetworkError);
    expect(classifyError(withCode('UND_ERR_SOCKET'))).toBeInstanceOf(NetworkError);
    expect(classifyError(withCode('UND_ERR_HEADERS_TIMEOUT'))).toBeInstanceOf(TimeoutError);
    expect(classifyError(new DOMException('The operation timed out', 'TimeoutError'))).toBeInstanceOf(TimeoutError);
    expect(classifyError(Object.assign(new Error('pool timeout'), { name: 'PrismaClientKnownRequestError', code: 'P2024' }))).toMatchObject({ category: 'DATABASE', retryable: true });
    expect(classifyError(Object.assign(new Error('unique'), { name: 'PrismaClientKnownRequestError', code: 'P2002' }))).toMatchObject({ category: 'DATABASE', retryable: false });
    expect(classifyError(Object.assign(new Error('READONLY'), { name: 'ReplyError' }))).toBeInstanceOf(RedisError);
    expect(classifyError(new TypeError('x is undefined'))).toBeInstanceOf(UnknownError);
    expect(classifyError('a string')).toBeInstanceOf(UnknownError);
  });

  it('only marks temporary failures as retryable', () => {
    expect(new NetworkError('x').retryable).toBe(true);
    expect(new TimeoutError('x').retryable).toBe(true);
    expect(new RateLimitError('x', 1000).retryable).toBe(true);
    expect(new RedisError('x').retryable).toBe(true);
    expect(new DatabaseError('x').retryable).toBe(true);
    expect(new ExternalApiError('x', 503).retryable).toBe(true);
    expect(new ExternalApiError('x', 400).retryable).toBe(false);
    expect(new ValidationError('x').retryable).toBe(false);
    expect(new UnknownError('x').retryable).toBe(false);
  });

  it('serializes errors without secrets', () => {
    const serialized = serializeError(new ExternalApiError(`failed calling /bot${BOT_TOKEN}/sendMessage`, 500, { details: { token: BOT_TOKEN } }));
    expect(JSON.stringify(serialized)).not.toContain(BOT_TOKEN);
    expect(serialized).toMatchObject({ category: 'EXTERNAL_API', retryable: true });
  });
});

describe('configuration', () => {
  it('loads defaults and validates required values', () => {
    const config = loadConfig(TEST_ENV);
    expect(config.PORT).toBe(3000);
    expect(config.WORKER_CONCURRENCY).toBe(50);
    expect(config.MAX_RETRIES).toBe(5);
    expect(config.encryptionKey).toHaveLength(32);
    expect(() => loadConfig({ ...TEST_ENV, WEBHOOK_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...TEST_ENV, ENCRYPTION_KEY: 'nope' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...TEST_ENV, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
});

describe('retries with exponential backoff and jitter', () => {
  it('computes bounded delays', () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000 };
    expect(computeBackoffDelay(1, policy, () => 0)).toBe(50);
    expect(computeBackoffDelay(1, policy, () => 1)).toBe(100);
    expect(computeBackoffDelay(3, policy, () => 1)).toBe(400);
    expect(computeBackoffDelay(10, policy, () => 1)).toBe(1_000);
  });

  it('retries retryable errors and stops on success', async () => {
    let calls = 0;
    const result = await retryAsync(
      async () => {
        calls++;
        if (calls < 3) throw new NetworkError('flaky');
        return 'ok';
      },
      { retries: 3, policy: { baseDelayMs: 1, maxDelayMs: 2 }, shouldRetry: () => true },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      retryAsync(
        async () => {
          calls++;
          throw new ValidationError('bad');
        },
        { retries: 5, policy: { baseDelayMs: 1, maxDelayMs: 2 }, shouldRetry: () => true },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toBe(1);
  });

  it('honours retryAfterMs and aborts sleeping on signal', async () => {
    const delays: number[] = [];
    await retryAsync(
      async (attempt) => {
        if (attempt === 1) throw new RateLimitError('429', 30);
        return 'ok';
      },
      { retries: 1, policy: { baseDelayMs: 1, maxDelayMs: 2 }, shouldRetry: () => true, onRetry: (_e, _n, d) => delays.push(d) },
    );
    expect(delays).toEqual([30]);
    await expect(sleep(1_000, AbortSignal.timeout(10))).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('token bucket rate limiter', () => {
  it('allows bursts, then asks callers to wait or reschedule', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ ratePerSec: 10, burst: 2, now: () => now });
    expect(limiter.reserve('k', 0)).toEqual({ ok: true, waitMs: 0 });
    expect(limiter.reserve('k', 0)).toEqual({ ok: true, waitMs: 0 });
    expect(limiter.reserve('k', 50)).toEqual({ ok: false, retryAfterMs: 100 });
    expect(limiter.reserve('k', 100)).toEqual({ ok: true, waitMs: 100 });
    now = 1_000;
    expect(limiter.reserve('k', 0)).toEqual({ ok: true, waitMs: 0 });
  });

  it('keeps keys independent and evicts idle keys beyond maxKeys', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ ratePerSec: 1, burst: 1, maxKeys: 2, now: () => now });
    limiter.reserve('a', 0);
    limiter.reserve('b', 0);
    now = 10_000;
    limiter.reserve('c', 0);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});

describe('graceful shutdown manager', () => {
  it('runs handlers in reverse order and exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const manager = new ShutdownManager({ logger: silentLogger(), timeoutMs: 1_000, exit });
    manager.register('database', () => {
      order.push('database');
    });
    manager.register('queue', async () => {
      await sleep(10);
      order.push('queue');
    });
    manager.register('http', () => {
      order.push('http');
    });
    await manager.shutdown('test');
    expect(order).toEqual(['http', 'queue', 'database']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(manager.isShuttingDown).toBe(true);
  });

  it('is idempotent and keeps going when a handler fails', async () => {
    const exit = vi.fn();
    const ran: string[] = [];
    const manager = new ShutdownManager({ logger: silentLogger(), timeoutMs: 1_000, exit });
    manager.register('a', () => {
      ran.push('a');
    });
    manager.register('b', () => {
      throw new Error('boom');
    });
    const first = manager.shutdown('one');
    const second = manager.shutdown('two');
    expect(first).toBe(second);
    await first;
    expect(ran).toEqual(['a']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit(1) when handlers exceed the timeout', async () => {
    const exit = vi.fn();
    const manager = new ShutdownManager({ logger: silentLogger(), timeoutMs: 50, exit });
    manager.register('stuck', () => new Promise(() => undefined));
    await manager.shutdown('test');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('buffered execution recorder', () => {
  const update = (id: string, status: ExecutionUpdate['status'], extra: Partial<ExecutionUpdate> = {}): ExecutionUpdate => ({
    id,
    workflowId: 'w',
    workflowVersion: 1,
    endpointId: 'e',
    eventId: 'ev',
    eventType: 'post.published',
    jobId: `job-${id}`,
    status,
    attempts: 1,
    receivedAt: 1,
    enqueuedAt: 2,
    ...extra,
  });

  it('coalesces updates for the same execution into one row write', async () => {
    const batches: ExecutionBatch[] = [];
    const recorder = new BufferedExecutionRecorder({ writer: { write: async (b) => void batches.push(b) }, logger: silentLogger(), flushIntervalMs: 60_000, maxBuffer: 100 });
    recorder.recordExecution(update('x', 'RUNNING', { startedAt: 10 }));
    recorder.recordExecution(update('x', 'SUCCEEDED', { finishedAt: 20 }));
    recorder.appendLog({ executionId: 'x', attempt: 1, level: 'INFO', message: 'step succeeded', createdAt: 20 });
    await recorder.close();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.executions).toHaveLength(1);
    expect(batches[0]!.executions[0]).toMatchObject({ status: 'SUCCEEDED', startedAt: 10, finishedAt: 20 });
    expect(batches[0]!.logs).toHaveLength(1);
  });

  it('requeues batches when the database is temporarily unavailable', async () => {
    let fail = true;
    const written: ExecutionBatch[] = [];
    const recorder = new BufferedExecutionRecorder({
      writer: {
        write: async (b) => {
          if (fail) throw new DatabaseError('connection refused');
          written.push(b);
        },
      },
      logger: silentLogger(),
      flushIntervalMs: 60_000,
      maxBuffer: 100,
    });
    recorder.recordExecution(update('y', 'SUCCEEDED'));
    await recorder.flush();
    expect(written).toHaveLength(0);
    fail = false;
    await recorder.flush();
    expect(written[0]!.executions[0]!.id).toBe('y');
    await recorder.close();
  });

  it('isolates rows that can never be written instead of blocking the batch', async () => {
    const written: string[] = [];
    const recorder = new BufferedExecutionRecorder({
      writer: {
        write: async (b) => {
          if (b.executions.some((e) => e.id === 'bad')) throw new AppError('DATABASE', 'fk violation', { retryable: false });
          written.push(...b.executions.map((e) => e.id));
        },
      },
      logger: silentLogger(),
      flushIntervalMs: 60_000,
      maxBuffer: 100,
    });
    recorder.recordExecution(update('good', 'SUCCEEDED'));
    recorder.recordExecution(update('bad', 'SUCCEEDED'));
    await recorder.flush();
    expect(written).toEqual(['good']);
  });

  it('drops (and counts) entries when the buffer is full instead of blocking', async () => {
    const recorder = new BufferedExecutionRecorder({ writer: { write: async () => undefined }, logger: silentLogger(), flushIntervalMs: 60_000, maxBuffer: 2 });
    recorder.recordExecution(update('a', 'RUNNING'));
    recorder.recordExecution(update('b', 'RUNNING'));
    recorder.recordExecution(update('c', 'RUNNING'));
    recorder.recordExecution(update('a', 'SUCCEEDED')); // coalesced, not dropped
    await recorder.close();
  });
});
