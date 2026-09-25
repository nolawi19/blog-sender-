import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { buildApp, type GatewayDependencies } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { MemoryIdempotencyStore } from '../../src/gateway/idempotency.js';
import { compileTemplate, compileValue } from '../../src/mapper/template-mapper.js';
import { createLogger, type Logger } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';
import type { EventPublisher } from '../../src/queue/automation.queue.js';
import { hashToken } from '../../src/security/hmac.js';
import type { AutomationJobData, NormalizedEvent, RuntimeEndpoint, RuntimeStep, RuntimeWorkflow } from '../../src/types/workflow.js';
import type { EndpointRegistry, WorkflowSource } from '../../src/workflows/workflow-loader.js';

export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
  ENCRYPTION_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  LOG_LEVEL: 'silent',
};

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

export function silentLogger(): Logger {
  return createLogger({ level: 'silent', service: 'test' });
}

/** Logger that captures every JSON line, for asserting on log output (e.g. redaction). */
export function capturingLogger(level = 'trace'): { logger: Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ level, service: 'test', destination });
  return { logger, lines: () => chunks.join('').split('\n').filter(Boolean) };
}

export const BEARER_TOKEN = 'test-bearer-token-abcdefghijklmnop';
export const BOT_TOKEN = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra';

export function makeEndpoint(overrides: Partial<RuntimeEndpoint> = {}): RuntimeEndpoint {
  return {
    id: randomUUID(),
    slug: 'blog',
    userId: randomUUID(),
    source: 'blog',
    authType: 'BEARER',
    tokenHash: hashToken(BEARER_TOKEN),
    hmacSecret: null,
    defaultEventType: 'post.published',
    idempotencyPath: ['id'],
    dedupeByPayloadHash: true,
    ...overrides,
  };
}

export function makeStep(overrides: Partial<Omit<RuntimeStep, 'config' | 'runIf'>> & { config?: unknown; runIf?: string } = {}): RuntimeStep {
  const { config, runIf, ...rest } = overrides;
  return {
    id: randomUUID(),
    key: 'announce',
    position: 0,
    type: 'test.echo',
    credential: null,
    timeoutMs: null,
    ...rest,
    config: compileValue(config ?? { text: '{{trigger.body.title}}' }),
    runIf: runIf ? compileTemplate(runIf) : null,
  };
}

export function makeWorkflow(endpoint: RuntimeEndpoint, steps: RuntimeStep[], overrides: Partial<RuntimeWorkflow> = {}): RuntimeWorkflow {
  return {
    id: randomUUID(),
    name: 'test workflow',
    userId: endpoint.userId,
    endpointId: endpoint.id,
    triggerEvent: 'post.published',
    version: 1,
    steps,
    ...overrides,
  };
}

/** In-memory EndpointRegistry + WorkflowSource. */
export class InMemoryRegistry implements EndpointRegistry, WorkflowSource {
  readonly endpoints = new Map<string, RuntimeEndpoint>();
  readonly workflows = new Map<string, RuntimeWorkflow>();

  addEndpoint(endpoint: RuntimeEndpoint): this {
    this.endpoints.set(endpoint.slug, endpoint);
    return this;
  }
  addWorkflow(workflow: RuntimeWorkflow): this {
    this.workflows.set(workflow.id, workflow);
    return this;
  }
  getEndpoint(slug: string): RuntimeEndpoint | undefined {
    return this.endpoints.get(slug);
  }
  async resolveEndpoint(slug: string): Promise<RuntimeEndpoint | undefined> {
    return this.endpoints.get(slug);
  }
  workflowsFor(endpointId: string, eventType: string): readonly RuntimeWorkflow[] {
    return [...this.workflows.values()].filter((w) => w.endpointId === endpointId && (w.triggerEvent === eventType || w.triggerEvent === '*'));
  }
  isReady(): boolean {
    return true;
  }
  async resolveWorkflow(id: string): Promise<RuntimeWorkflow | undefined> {
    return this.workflows.get(id);
  }
}

export class CapturingPublisher implements EventPublisher {
  readonly jobs: AutomationJobData[] = [];
  failWith: Error | null = null;
  delayMs = 0;
  async publish(jobs: readonly AutomationJobData[]): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    this.jobs.push(...jobs);
  }
}

export interface TestGateway {
  app: Awaited<ReturnType<typeof buildApp>>;
  registry: InMemoryRegistry;
  publisher: CapturingPublisher;
  idempotency: MemoryIdempotencyStore;
  endpoint: RuntimeEndpoint;
  workflow: RuntimeWorkflow;
  backpressure: { overloaded: boolean; isOverloaded(): boolean };
  shutdown: { value: boolean };
}

export async function buildTestGateway(
  options: { env?: NodeJS.ProcessEnv; endpoint?: Partial<RuntimeEndpoint>; deps?: Partial<GatewayDependencies> } = {},
): Promise<TestGateway> {
  const config = testConfig(options.env);
  const endpoint = makeEndpoint(options.endpoint);
  const workflow = makeWorkflow(endpoint, [makeStep()]);
  const registry = new InMemoryRegistry().addEndpoint(endpoint).addWorkflow(workflow);
  const publisher = new CapturingPublisher();
  const idempotency = new MemoryIdempotencyStore();
  const backpressure = {
    overloaded: false,
    isOverloaded() {
      return this.overloaded;
    },
  };
  const shutdown = { value: false };
  const app = await buildApp({
    config,
    logger: silentLogger(),
    registry,
    idempotency,
    publisher,
    backpressure,
    metrics: new Metrics({ service: 'test', defaultMetrics: false }),
    readiness: async () => ({ ready: true, checks: { redis: true, workflows: true } }),
    isShuttingDown: () => shutdown.value,
    ...options.deps,
  });
  return { app, registry, publisher, idempotency, endpoint, workflow, backpressure, shutdown };
}

export function makeEvent(body: Record<string, unknown> = { title: 'Hello' }, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: randomUUID(),
    source: 'blog',
    type: 'post.published',
    timestamp: new Date().toISOString(),
    headers: { 'content-type': 'application/json' },
    query: {},
    body,
    metadata: { requestId: 'req-1', userAgent: 'vitest', ip: '127.0.0.1', endpoint: 'blog', receivedAt: Date.now() },
    ...overrides,
  };
}

export function makeJobData(workflow: RuntimeWorkflow, event: NormalizedEvent = makeEvent()): AutomationJobData {
  const now = Date.now();
  return {
    executionId: randomUUID(),
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    endpointId: workflow.endpointId,
    idempotencyKey: 'f:post-1',
    event,
    timings: { receivedAt: now - 2, enqueuedAt: now - 1 },
  };
}
