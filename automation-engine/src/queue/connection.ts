import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '../observability/logger.js';

export type RedisRole = 'producer' | 'worker' | 'client' | 'subscriber';

/**
 * Creates an ioredis connection tuned for its role.
 *
 * - producer (gateway): fail fast. `enableOfflineQueue: false` and a bounded
 *   `maxRetriesPerRequest` mean a Redis outage turns into an immediate 503
 *   instead of webhook requests hanging.
 * - worker: BullMQ requires `maxRetriesPerRequest: null` for blocking commands,
 *   and the worker should wait for Redis to come back rather than crash.
 * - client / subscriber: general purpose (idempotency, pub/sub cache invalidation).
 */
export function createRedisConnection(url: string, role: RedisRole, logger: Logger): Redis {
  const common: RedisOptions = {
    connectionName: `automation-${role}`,
    lazyConnect: false,
    enableReadyCheck: true,
    keepAlive: 30_000,
    noDelay: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    reconnectOnError: (err) => err.message.includes('READONLY'),
  };

  const roleOptions: Record<RedisRole, RedisOptions> = {
    producer: { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 },
    worker: { maxRetriesPerRequest: null, enableOfflineQueue: true, connectTimeout: 10_000 },
    client: { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 },
    subscriber: { maxRetriesPerRequest: null, enableOfflineQueue: true, connectTimeout: 10_000 },
  };

  const redis = new Redis(url, { ...common, ...roleOptions[role] });
  let lastErrorLog = 0;
  redis.on('error', (err: Error) => {
    // Rate-limit error logs: ioredis emits one per reconnect attempt.
    const now = Date.now();
    if (now - lastErrorLog > 5_000) {
      lastErrorLog = now;
      logger.error({ err, role }, 'redis connection error');
    }
  });
  redis.on('ready', () => logger.info({ role }, 'redis connection ready'));
  return redis;
}

/** Resolves once the connection is ready, or rejects after `timeoutMs`. */
export async function waitForRedis(redis: Redis, timeoutMs = 10_000): Promise<void> {
  if (redis.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis not ready after ${timeoutMs} ms`));
    }, timeoutMs);
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      redis.off('ready', onReady);
    };
    redis.on('ready', onReady);
  });
}

export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'end') return;
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
