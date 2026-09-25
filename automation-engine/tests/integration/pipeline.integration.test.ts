/**
 * End-to-end pipeline against a real Redis (BullMQ) and a local fake Telegram API:
 * gateway -> Redis/BullMQ -> worker -> engine -> template mapper -> Telegram driver.
 *
 * Runs only when INTEGRATION_REDIS_URL is set (npm run test:integration).
 * PostgreSQL is replaced by in-memory sinks so the queue semantics are tested
 * in isolation.
 */
import { Queue, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { NullExecutionSink } from '../../src/database/execution-recorder.js';
import { RedisIdempotencyStore } from '../../src/gateway/idempotency.js';
import { DriverRegistry } from '../../src/integrations/integration-driver.js';
import { createTelegramDriver, TelegramClient } from '../../src/integrations/telegram/telegram-driver.js';
import { Metrics } from '../../src/observability/metrics.js';
import { AUTOMATION_QUEUE_NAME, BullMqEventPublisher, buildJobOptions, createAutomationQueue, type AutomationQueue } from '../../src/queue/automation.queue.js';
import { closeRedis, createRedisConnection, waitForRedis } from '../../src/queue/connection.js';
import type { ProcessorResult } from '../../src/workers/automation.worker.js';
import { createAutomationProcessor, createAutomationWorker } from '../../src/workers/automation.worker.js';
import { MemoryDeadLetterSink } from '../../src/workers/dead-letter.js';
import { WorkflowEngine } from '../../src/workflows/workflow-engine.js';
import type { AutomationJobData } from '../../src/types/workflow.js';
import { BEARER_TOKEN, BOT_TOKEN, InMemoryRegistry, makeEndpoint, makeStep, makeWorkflow, silentLogger, testConfig } from '../helpers/fixtures.js';
import { json, startTestServer, telegramOk, type TestServer } from '../helpers/http-server.js';

const redisUrl = process.env['INTEGRATION_REDIS_URL'];

describe.skipIf(!redisUrl)('pipeline integration (real Redis + BullMQ)', () => {
  const logger = silentLogger();
  let producer: Redis;
  let workerConn: Redis;
  let queue: AutomationQueue;
  let worker: Worker<AutomationJobData, ProcessorResult>;
  let telegram: TestServer;
  let tgClient: TelegramClient;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const sink = new NullExecutionSink();
  const deadLetters = new MemoryDeadLetterSink();
  const metrics = new Metrics({ service: 'integration', defaultMetrics: false });
  let failuresLeft = 0;
  let permanentFailure = false;

  const endpoint = makeEndpoint({ slug: `it-${Date.now()}` });
  const workflow = makeWorkflow(endpoint, [
    makeStep({
      key: 'announce',
      type: 'telegram.sendPhoto',
      config: { chatId: '{{trigger.body.telegram_chat_id}}', photo: '{{trigger.body.image}}', caption: '{{trigger.body.title}}' },
    }),
  ]);
  const registry = new InMemoryRegistry().addEndpoint(endpoint).addWorkflow(workflow);

  beforeAll(async () => {
    const url = redisUrl as string;
    producer = createRedisConnection(url, 'producer', logger);
    workerConn = createRedisConnection(url, 'worker', logger);
    await Promise.all([waitForRedis(producer), waitForRedis(workerConn)]);
    await new Queue(AUTOMATION_QUEUE_NAME, { connection: workerConn }).obliterate({ force: true });

    telegram = await startTestServer((req, res) => {
      if (permanentFailure) return json(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
      if (failuresLeft > 0) {
        failuresLeft--;
        return json(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
      }
      telegramOk(res, req.json?.['chat_id'] as number);
    });
    tgClient = new TelegramClient({
      baseUrl: telegram.url,
      timeoutMs: 2_000,
      connections: 8,
      keepAliveTimeoutMs: 30_000,
      inlineRetries: 0,
      // Low per-chat limit so the burst test below exercises client-side throttling.
      rateLimit: { globalPerSec: 10_000, perChatPerSec: 20, perChatBurst: 5, maxWaitMs: 20 },
      warmupConnections: 2,
      keepWarmIntervalMs: 0,
      logger,
    });
    const drivers = new DriverRegistry().register(createTelegramDriver(tgClient, { defaultBotToken: BOT_TOKEN }));
    await drivers.initAll();

    queue = createAutomationQueue(producer, 2);
    const processor = createAutomationProcessor({
      workflows: registry,
      engine: new WorkflowEngine({ registry: drivers, logger, metrics, defaultStepTimeoutMs: 2_000 }),
      sink,
      deadLetters,
      logger,
      metrics,
      jobTimeoutMs: 5_000,
      storeTriggerPayload: false,
      idempotencyTtlSec: 60,
    });
    worker = createAutomationWorker({ connection: workerConn, concurrency: 10, processor, backoff: { baseDelayMs: 50, maxDelayMs: 100 }, logger });
    void worker.run();

    app = await buildApp({
      config: testConfig(),
      logger,
      registry,
      idempotency: new RedisIdempotencyStore(producer, `it:${Date.now()}`),
      publisher: new BullMqEventPublisher(queue),
      backpressure: { isOverloaded: () => false },
      metrics,
      readiness: async () => ({ ready: true, checks: {} }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await queue?.close();
    await tgClient?.close();
    await telegram?.close();
    if (producer) await closeRedis(producer);
    if (workerConn) await closeRedis(workerConn);
  });

  beforeEach(() => {
    failuresLeft = 0;
    permanentFailure = false;
    telegram.requests.length = 0;
  });

  let chat = 5000;
  const send = (id: string, chatId: number = chat++) =>
    app.inject({
      method: 'POST',
      url: `/webhooks/${endpoint.slug}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, 'content-type': 'application/json' },
      payload: { id, title: `Post ${id}`, image: 'https://example.com/cover.jpg', telegram_chat_id: chatId },
    });

  async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('delivers a webhook to Telegram asynchronously', async () => {
    const res = await send(`p-${Date.now()}`);
    expect(res.statusCode).toBe(202);
    const request = await waitFor(() => telegram.requests.find((r) => r.url.endsWith('/sendPhoto')));
    expect(request.json).toEqual({ chat_id: expect.any(Number), photo: 'https://example.com/cover.jpg', caption: expect.stringMatching(/^Post p-/) });
    const { executionId } = res.json().executions[0];
    const done = await waitFor(() => sink.executions.find((e) => e.id === executionId && e.status === 'SUCCEEDED'));
    expect(done.outboundStartLatencyMs).toBeGreaterThan(0);
  });

  it('ignores duplicate deliveries (Redis idempotency)', async () => {
    const id = `dup-${Date.now()}`;
    const [a, b, c] = await Promise.all([send(id, 1), send(id, 1), send(id, 1)]);
    const statuses = [a.statusCode, b.statusCode, c.statusCode].sort();
    expect(statuses).toEqual([200, 200, 202]);
    await waitFor(() => telegram.requests.find((r) => String(r.json?.['caption']).endsWith(id)));
    await new Promise((r) => setTimeout(r, 200));
    expect(telegram.requests.filter((r) => String(r.json?.['caption']).endsWith(id))).toHaveLength(1);
  });

  it('retries transient Telegram failures with backoff, then succeeds', async () => {
    failuresLeft = 2;
    const res = await send(`retry-${Date.now()}`);
    const { executionId } = res.json().executions[0];
    const done = await waitFor(() => sink.executions.find((e) => e.id === executionId && e.status === 'SUCCEEDED'));
    expect(done.attempts).toBe(3);
    expect(telegram.requests.filter((r) => r.url.endsWith('/sendPhoto'))).toHaveLength(3);
    expect(sink.executions.filter((e) => e.id === executionId && e.status === 'RETRYING')).toHaveLength(2);
  });

  it('dead-letters after the retry budget is exhausted', async () => {
    failuresLeft = 100;
    const res = await send(`dlq-${Date.now()}`);
    const { executionId } = res.json().executions[0];
    const entry = await waitFor(() => deadLetters.entries.find((e) => e.executionId === executionId));
    expect(entry.attempts).toBe(buildJobOptions(2).attempts);
    const job = await queue.getJob(`exec-${executionId}`);
    expect(await job?.getState()).toBe('failed');
  });

  it('throttles a burst to one chat without dead-lettering anything', async () => {
    const tag = `burst-${Date.now()}`;
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => send(`${tag}-${i}`, 777)));
    const ids = responses.map((r) => r.json().executions[0].executionId as string);
    await waitFor(() => (ids.every((id) => sink.executions.some((e) => e.id === id && e.status === 'SUCCEEDED')) ? true : undefined), 10_000);
    expect(deadLetters.entries.filter((e) => ids.includes(e.executionId ?? ''))).toHaveLength(0);
    expect(telegram.requests.filter((r) => String(r.json?.['caption']).includes(tag))).toHaveLength(30);
  });

  it('dead-letters permanent failures without retrying', async () => {
    permanentFailure = true;
    const res = await send(`perm-${Date.now()}`);
    const { executionId } = res.json().executions[0];
    const entry = await waitFor(() => deadLetters.entries.find((e) => e.executionId === executionId));
    expect(entry.attempts).toBe(1);
    expect(entry.error.code).toBe('TELEGRAM_BAD_REQUEST');
    expect(telegram.requests).toHaveLength(1);
  });
});
