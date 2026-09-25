import { randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { IdempotencyStore } from './gateway/idempotency.js';
import { registerWebhookRoutes, type WebhookConfig } from './gateway/webhook.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';
import { nowMs, type Clock } from './observability/timing.js';
import type { EventPublisher } from './queue/automation.queue.js';
import type { EndpointRegistry } from './workflows/workflow-loader.js';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, boolean>;
}

export interface GatewayDependencies {
  config: WebhookConfig & Pick<Config, 'WEBHOOK_BODY_LIMIT_BYTES' | 'TRUST_PROXY'>;
  logger: Logger;
  registry: EndpointRegistry;
  idempotency: IdempotencyStore;
  publisher: EventPublisher;
  backpressure: { isOverloaded(): boolean };
  metrics: Metrics;
  readiness: () => Promise<ReadinessReport>;
  isShuttingDown?: () => boolean;
  clock?: Clock;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface ErrorBody {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

function isFastifyError(err: unknown): err is FastifyError {
  return err instanceof Error && typeof (err as Partial<FastifyError>).statusCode === 'number';
}

export async function buildApp(deps: GatewayDependencies): Promise<FastifyInstance> {
  const clock = deps.clock ?? nowMs;
  const isShuttingDown = deps.isShuttingDown ?? (() => false);

  const app = Fastify({
    // Widen to Fastify's logger interface so the instance keeps the default generic.
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Per-request "incoming/completed" lines are replaced by one structured line
    // per accepted webhook, which halves logging work on the hot path.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    bodyLimit: deps.config.WEBHOOK_BODY_LIMIT_BYTES,
    trustProxy: deps.config.TRUST_PROXY,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    },
    // Longer than typical load-balancer idle timeouts (60 s) to avoid races on reuse.
    keepAliveTimeout: 72_000,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  app.decorateRequest('receivedAt', 0);
  app.decorateRequest('rawBody', null);
  app.decorateRequest('webhookEndpoint', null);

  // First hook: stamp receipt time before anything else runs.
  app.addHook('onRequest', async (request, reply) => {
    request.receivedAt = clock();
    reply.header('x-request-id', request.id);
  });

  // During shutdown, tell keep-alive clients to reconnect elsewhere. Without this,
  // a connection that finishes an in-flight request after close() started would
  // sit idle until keepAliveTimeout and delay the shutdown.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (closing || isShuttingDown()) reply.header('connection', 'close');
    return payload;
  });

  // Only JSON is accepted. The raw bytes are kept for HMAC verification; parsing
  // reuses Fastify's hardened parser (prototype-poisoning protection).
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    request.rawBody = raw;
    jsonParser(request, raw.toString('utf8'), done);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    let status = 500;
    const body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id };

    if (error instanceof AppError) {
      status = error.statusCode;
      body.code = error.code;
      body.message = error.message;
      if (error.details && status < 500) body.details = error.details;
      if (error.retryAfterMs !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    } else if (isFastifyError(error) && (error.statusCode ?? 500) < 500) {
      status = error.statusCode ?? 400;
      body.code = error.code ?? 'BAD_REQUEST';
      body.message = error.message;
    }

    if (status >= 500) request.log.error({ err: error, requestId: request.id }, 'request failed');
    else request.log.debug({ err: error, requestId: request.id, status }, 'request rejected');
    return reply.code(status).send({ error: body });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } });
  });

  await app.register(rateLimit, { global: false });

  await registerWebhookRoutes(app, {
    config: deps.config,
    registry: deps.registry,
    idempotency: deps.idempotency,
    publisher: deps.publisher,
    backpressure: deps.backpressure,
    metrics: deps.metrics,
    clock,
    isShuttingDown,
  });

  app.get('/health', async () => ({ status: 'ok', uptimeSec: Math.round(process.uptime()) }));

  app.get('/ready', async (_request, reply) => {
    const report = await deps.readiness();
    const ready = report.ready && !isShuttingDown();
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: { ...report.checks, accepting: !isShuttingDown() } });
  });

  app.get('/metrics', async (_request, reply) => {
    return reply.header('content-type', deps.metrics.contentType).send(await deps.metrics.prometheus());
  });

  app.get('/metrics/latency', async () => deps.metrics.latencySnapshot());

  return app;
}
