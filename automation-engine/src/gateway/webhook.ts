import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { AppError, AuthenticationError, RateLimitError, RedisError, ValidationError } from '../errors.js';
import type { Metrics } from '../observability/metrics.js';
import type { Clock } from '../observability/timing.js';
import type { EventPublisher } from '../queue/automation.queue.js';
import { extractBearerToken, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature, verifyToken } from '../security/hmac.js';
import { REDACTED, SENSITIVE_HEADERS } from '../security/redact.js';
import type { AutomationJobData, NormalizedEvent, RuntimeEndpoint } from '../types/workflow.js';
import type { EndpointRegistry } from '../workflows/workflow-loader.js';
import type { IdempotencyStore } from './idempotency.js';
import { acceptedResponseJsonSchema, errorResponseJsonSchema, eventTypeSchema, webhookBodySchema, webhookHeadersSchema, webhookParamsSchema } from './schemas.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** High-resolution epoch ms stamped in the first onRequest hook. */
    receivedAt: number;
    /** Exact request bytes, kept for HMAC verification and payload hashing. */
    rawBody: Buffer | null;
    webhookEndpoint: RuntimeEndpoint | null;
  }
  interface FastifyContextConfig {
    webhook?: boolean;
  }
}

export type WebhookConfig = Pick<
  Config,
  | 'WEBHOOK_SECRET'
  | 'WEBHOOK_HMAC_TOLERANCE_SEC'
  | 'WEBHOOK_FORWARD_SENSITIVE_HEADERS'
  | 'IDEMPOTENCY_TTL_SEC'
  | 'RATE_LIMIT_ENABLED'
  | 'RATE_LIMIT_MAX'
  | 'RATE_LIMIT_WINDOW_MS'
>;

export interface WebhookRouteDeps {
  config: WebhookConfig;
  registry: EndpointRegistry;
  idempotency: IdempotencyStore;
  publisher: EventPublisher;
  backpressure: { isOverloaded(): boolean };
  metrics: Metrics;
  clock: Clock;
  isShuttingDown: () => boolean;
}

class EndpointNotFoundError extends AppError {
  constructor() {
    super('VALIDATION', 'Unknown or inactive webhook endpoint', { statusCode: 404, code: 'ENDPOINT_NOT_FOUND' });
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message: string, code: string) {
    super('REDIS', message, { statusCode: 503, code, retryable: true, retryAfterMs: 1_000 });
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeHeaders(raw: FastifyRequest['headers'], forwardSensitive: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name] = !forwardSensitive && SENSITIVE_HEADERS.has(name) ? REDACTED : Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function normalizeQuery(raw: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String);
    else if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function resolveEventType(headerType: string | undefined, body: Record<string, unknown>, endpoint: RuntimeEndpoint): string {
  const candidate =
    headerType ??
    (typeof body['type'] === 'string' ? body['type'] : undefined) ??
    (typeof body['event'] === 'string' ? body['event'] : undefined) ??
    endpoint.defaultEventType ??
    'webhook.received';
  const parsed = eventTypeSchema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError('Invalid event type', { details: { eventType: candidate.slice(0, 128) } });
  return parsed.data;
}

function bodyPathValue(body: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = body;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'string' && current.length > 0 && current.length <= 255) return current;
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  return undefined;
}

/**
 * Idempotency key precedence: Idempotency-Key header, X-Event-Id header, the
 * endpoint's configured body field, then (optionally) a SHA-256 of the raw body.
 */
export function idempotencyKeyFor(
  headers: { 'idempotency-key'?: string | undefined; 'x-event-id'?: string | undefined },
  body: Record<string, unknown>,
  endpoint: RuntimeEndpoint,
  rawBody: Buffer | null,
): string | null {
  const header = headers['idempotency-key'] ?? headers['x-event-id'];
  if (header) return `h:${header}`;
  if (endpoint.idempotencyPath) {
    const value = bodyPathValue(body, endpoint.idempotencyPath);
    if (value !== undefined) return `f:${value}`;
  }
  if (endpoint.dedupeByPayloadHash && rawBody && rawBody.length > 0) {
    return `p:${createHash('sha256').update(rawBody).digest('hex')}`;
  }
  return null;
}

const OUTCOME_BY_STATUS: Record<number, string> = {
  200: 'duplicate',
  202: 'accepted',
  400: 'invalid',
  401: 'unauthorized',
  404: 'not_found',
  413: 'too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'unavailable',
};

export async function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): Promise<void> {
  const { config, registry, idempotency, publisher, metrics, clock } = deps;

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.routeOptions.config.webhook) return;
    metrics.webhookRequests.inc({ outcome: OUTCOME_BY_STATUS[reply.statusCode] ?? (reply.statusCode >= 500 ? 'error' : 'other') });
    metrics.observe('webhook_ack', clock() - request.receivedAt);
  });

  app.post<{ Params: { endpoint: string } }>(
    '/webhooks/:endpoint',
    {
      config: {
        webhook: true,
        rateLimit: config.RATE_LIMIT_ENABLED
          ? {
              max: config.RATE_LIMIT_MAX,
              timeWindow: config.RATE_LIMIT_WINDOW_MS,
              // Known endpoints get a bucket per endpoint+IP; unknown slugs share one
              // bucket per IP, so random slugs cannot sidestep the limit.
              keyGenerator: (req: FastifyRequest) => {
                const slug = (req.params as { endpoint?: string }).endpoint ?? '';
                return registry.getEndpoint(slug) ? `${slug}|${req.ip}` : `?|${req.ip}`;
              },
              errorResponseBuilder: (_req, ctx) => new RateLimitError(`Rate limit exceeded, retry in ${ctx.after}`, ctx.ttl),
            }
          : false,
      },
      schema: {
        response: {
          200: acceptedResponseJsonSchema,
          202: acceptedResponseJsonSchema,
          '4xx': errorResponseJsonSchema,
          '5xx': errorResponseJsonSchema,
        },
      },
      // Resolve the endpoint and check bearer tokens before the body is read, so
      // unauthenticated payloads are never buffered or parsed. preParsing (not
      // onRequest) so the rate limiter, an onRequest hook, always runs first.
      preParsing: async (request, _reply, payload) => {
        const params = webhookParamsSchema.safeParse(request.params);
        if (!params.success) throw new EndpointNotFoundError();
        const slug = params.data.endpoint;
        const endpoint = registry.getEndpoint(slug) ?? (await registry.resolveEndpoint(slug));
        if (!endpoint) throw new EndpointNotFoundError();
        request.webhookEndpoint = endpoint;
        if (endpoint.authType === 'BEARER' && !verifyToken(extractBearerToken(request.headers), endpoint.tokenHash)) {
          throw new AuthenticationError('Missing or invalid webhook token');
        }
        return payload;
      },
    },
    async (request, reply) => {
      const endpoint = request.webhookEndpoint;
      if (!endpoint) throw new EndpointNotFoundError();
      if (deps.isShuttingDown()) throw new ServiceUnavailableError('Gateway is shutting down', 'SHUTTING_DOWN');
      const receivedAt = request.receivedAt;

      if (endpoint.authType === 'HMAC') {
        const check = verifySignature({
          secret: endpoint.hmacSecret ?? config.WEBHOOK_SECRET,
          rawBody: request.rawBody ?? Buffer.alloc(0),
          signatureHeader: headerValue(request, SIGNATURE_HEADER),
          timestampHeader: headerValue(request, TIMESTAMP_HEADER),
          toleranceSec: config.WEBHOOK_HMAC_TOLERANCE_SEC,
        });
        if (!check.ok) throw new AuthenticationError('Invalid webhook signature', { details: { reason: check.reason } });
      }

      const body = webhookBodySchema.safeParse(request.body);
      if (!body.success) throw new ValidationError('Webhook payload must be a JSON object');
      const headers = webhookHeadersSchema.safeParse(request.headers);
      if (!headers.success) {
        throw new ValidationError('Invalid webhook headers', {
          details: { issues: headers.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        });
      }
      const eventType = resolveEventType(headers.data['x-event-type'], body.data, endpoint);

      const eventId = randomUUID();
      const event: NormalizedEvent = {
        id: eventId,
        source: endpoint.source,
        type: eventType,
        timestamp: new Date(receivedAt).toISOString(),
        headers: normalizeHeaders(request.headers, config.WEBHOOK_FORWARD_SENSITIVE_HEADERS),
        query: normalizeQuery(request.query),
        body: body.data,
        metadata: {
          requestId: request.id,
          userAgent: headerValue(request, 'user-agent') ?? null,
          ip: request.ip ?? null,
          endpoint: endpoint.slug,
          receivedAt,
        },
      };

      if (deps.backpressure.isOverloaded()) {
        throw new ServiceUnavailableError('Queue is saturated, retry later', 'QUEUE_SATURATED');
      }

      const idemKey = idempotencyKeyFor(headers.data, body.data, endpoint, request.rawBody);
      if (idemKey) {
        const claim = await idempotency.claim(endpoint.id, idemKey, eventId, config.IDEMPOTENCY_TTL_SEC);
        if (!claim.claimed) {
          metrics.idempotencyDuplicates.inc();
          request.log.info({ requestId: request.id, eventId: claim.existingEventId, endpoint: endpoint.slug }, 'duplicate webhook ignored');
          return reply.code(200).send({ accepted: true, duplicate: true, eventId: claim.existingEventId, requestId: request.id, eventType, executions: [] });
        }
      }

      const workflows = registry.workflowsFor(endpoint.id, eventType);
      const enqueuedAt = clock();
      const jobs: AutomationJobData[] = workflows.map((workflow) => ({
        executionId: randomUUID(),
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        endpointId: endpoint.id,
        idempotencyKey: idemKey,
        event,
        timings: { receivedAt, enqueuedAt },
      }));

      try {
        await publisher.publish(jobs);
      } catch (err) {
        if (idemKey) await idempotency.release(endpoint.id, idemKey, eventId);
        throw err instanceof AppError ? err : new RedisError('Failed to enqueue event', { cause: err });
      }
      const doneAt = clock();
      metrics.observe('webhook_enqueue', doneAt - enqueuedAt);

      request.log.info(
        {
          requestId: request.id,
          eventId,
          endpoint: endpoint.slug,
          eventType,
          executions: jobs.map((j) => ({ executionId: j.executionId, workflowId: j.workflowId })),
          gatewayMs: Math.round((doneAt - receivedAt) * 1000) / 1000,
        },
        'webhook accepted',
      );
      reply.header('server-timing', `gateway;dur=${(doneAt - receivedAt).toFixed(3)}, enqueue;dur=${(doneAt - enqueuedAt).toFixed(3)}`);
      return reply.code(202).send({
        accepted: true,
        duplicate: false,
        eventId,
        requestId: request.id,
        eventType,
        executions: jobs.map((j) => ({ executionId: j.executionId, workflowId: j.workflowId })),
      });
    },
  );
}
