/**
 * Webhook gateway entrypoint.
 * External App -> Fastify gateway -> Redis/BullMQ (acknowledged immediately).
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrismaClient } from './database/prisma.js';
import { RedisIdempotencyStore } from './gateway/idempotency.js';
import { ShutdownManager } from './lib/shutdown.js';
import { createLogger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { BullMqEventPublisher, createAutomationQueue, QueueDepthMonitor } from './queue/automation.queue.js';
import { closeRedis, createRedisConnection, waitForRedis } from './queue/connection.js';
import { CredentialCipher } from './security/credentials.js';
import { PrismaWorkflowRepository, WorkflowLoader } from './workflows/workflow-loader.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, service: 'gateway', pretty: config.LOG_PRETTY });
  const shutdown = new ShutdownManager({ logger, timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
  shutdown.listen();

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolSize: config.DATABASE_POOL_SIZE, logger });
  shutdown.register('postgres', () => prisma.$disconnect());

  const redis = createRedisConnection(config.REDIS_URL, 'producer', logger);
  shutdown.register('redis', () => closeRedis(redis));
  const subscriber = createRedisConnection(config.REDIS_URL, 'subscriber', logger);
  shutdown.register('redis-subscriber', () => closeRedis(subscriber));
  await Promise.all([waitForRedis(redis), waitForRedis(subscriber)]);

  const cipher = new CredentialCipher(config.encryptionKey, config.ENCRYPTION_KEY_ID);
  const loader = new WorkflowLoader({
    repository: new PrismaWorkflowRepository(prisma),
    cipher,
    logger,
    refreshIntervalMs: config.CACHE_REFRESH_INTERVAL_MS,
    decryptStepCredentials: false,
  });
  await loader.start();
  await loader.subscribe(subscriber);
  shutdown.register('workflow-loader', () => loader.stop());

  const queue = createAutomationQueue(redis, config.MAX_RETRIES);
  shutdown.register('queue', () => queue.close());
  const monitor = new QueueDepthMonitor(queue, config.QUEUE_BACKPRESSURE_THRESHOLD, logger);
  monitor.start();
  shutdown.register('queue-monitor', () => monitor.stop());

  const metrics = new Metrics({ service: 'gateway', queue });
  const app = await buildApp({
    config,
    logger,
    registry: loader,
    idempotency: new RedisIdempotencyStore(redis),
    publisher: new BullMqEventPublisher(queue),
    backpressure: monitor,
    metrics,
    isShuttingDown: () => shutdown.isShuttingDown,
    readiness: async () => {
      const checks = { redis: redis.status === 'ready', workflows: loader.isReady(), queueBelowThreshold: !monitor.isOverloaded() };
      return { ready: Object.values(checks).every(Boolean), checks };
    },
  });
  // Registered last so it stops first: stop accepting, drain in-flight requests.
  shutdown.register('http', () => app.close());

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, ...loader.stats }, 'gateway ready');
}

main().catch((err: unknown) => {
  // Logger may not exist yet (e.g. invalid configuration).
  process.stderr.write(`gateway failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
