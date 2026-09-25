/**
 * Worker entrypoint.
 * Redis/BullMQ -> worker pool -> workflow engine -> template mapper -> drivers.
 */
import { loadConfig } from './config.js';
import { BufferedExecutionRecorder, PrismaExecutionWriter } from './database/execution-recorder.js';
import { createPrismaClient } from './database/prisma.js';
import { createDefaultRegistry } from './integrations/index.js';
import { ShutdownManager } from './lib/shutdown.js';
import { startHealthServer } from './observability/health-server.js';
import { createLogger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { createAutomationQueue, createDeadLetterQueue } from './queue/automation.queue.js';
import { closeRedis, createRedisConnection, waitForRedis } from './queue/connection.js';
import { CredentialCipher } from './security/credentials.js';
import { createAutomationProcessor, createAutomationWorker } from './workers/automation.worker.js';
import { PrismaDeadLetterSink } from './workers/dead-letter.js';
import { WorkflowEngine } from './workflows/workflow-engine.js';
import { PrismaWorkflowRepository, WorkflowLoader } from './workflows/workflow-loader.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, service: 'worker', pretty: config.LOG_PRETTY });
  const shutdown = new ShutdownManager({ logger, timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
  shutdown.listen();

  const prisma = createPrismaClient({ databaseUrl: config.DATABASE_URL, poolSize: config.DATABASE_POOL_SIZE, logger });
  shutdown.register('postgres', () => prisma.$disconnect());

  const redis = createRedisConnection(config.REDIS_URL, 'worker', logger);
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
    decryptStepCredentials: true,
  });
  await loader.start();
  await loader.subscribe(subscriber);
  shutdown.register('workflow-loader', () => loader.stop());

  const automationQueue = createAutomationQueue(redis, config.MAX_RETRIES);
  const deadLetterQueue = createDeadLetterQueue(redis);
  shutdown.register('queues', async () => {
    await Promise.all([automationQueue.close(), deadLetterQueue.close()]);
  });

  const metrics = new Metrics({ service: 'worker', queue: automationQueue });

  const registry = createDefaultRegistry(config, logger);
  await registry.initAll(); // warms Telegram keep-alive connections before taking jobs
  shutdown.register('integrations', () => registry.closeAll());

  const recorder = new BufferedExecutionRecorder({
    writer: new PrismaExecutionWriter(prisma),
    logger,
    metrics,
    flushIntervalMs: config.RECORDER_FLUSH_INTERVAL_MS,
    maxBuffer: config.RECORDER_MAX_BUFFER,
  });
  shutdown.register('execution-recorder', () => recorder.close());

  const engine = new WorkflowEngine({ registry, logger, metrics, defaultStepTimeoutMs: config.STEP_TIMEOUT_MS });
  const processor = createAutomationProcessor({
    workflows: loader,
    engine,
    sink: recorder,
    deadLetters: new PrismaDeadLetterSink(prisma, deadLetterQueue, logger),
    logger,
    metrics,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
    storeTriggerPayload: config.STORE_TRIGGER_PAYLOAD,
    idempotencyTtlSec: config.IDEMPOTENCY_TTL_SEC,
    rateLimitMaxDeferMs: config.JOB_RATE_LIMIT_MAX_DEFER_MS,
  });

  const worker = createAutomationWorker({
    connection: redis,
    concurrency: config.WORKER_CONCURRENCY,
    processor,
    backoff: { baseDelayMs: config.RETRY_BASE_DELAY_MS, maxDelayMs: config.RETRY_MAX_DELAY_MS },
    logger,
  });

  const health = config.WORKER_METRICS_PORT > 0
    ? await startHealthServer({
        port: config.WORKER_METRICS_PORT,
        host: config.HOST,
        metrics,
        logger,
        readiness: async () => {
          const checks = { redis: redis.status === 'ready', workflows: loader.isReady(), worker: worker.isRunning() && !shutdown.isShuttingDown };
          return { ready: Object.values(checks).every(Boolean), checks };
        },
      })
    : null;
  if (health) shutdown.register('health-server', () => health.close());

  // Registered last so it stops first: stop fetching jobs, wait for active ones.
  shutdown.register('bullmq-worker', () => worker.close());

  worker.run().catch((err: unknown) => {
    logger.fatal({ err }, 'worker loop crashed');
    void shutdown.shutdown('worker-crash', 1);
  });
  logger.info({ concurrency: config.WORKER_CONCURRENCY, actions: registry.listActionTypes(), ...loader.stats }, 'worker ready');
}

main().catch((err: unknown) => {
  process.stderr.write(`worker failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
