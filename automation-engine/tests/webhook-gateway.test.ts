import { afterEach, describe, expect, it } from 'vitest';
import { RedisError } from '../src/errors.js';
import { signPayload } from '../src/security/hmac.js';
import { normalizedEventSchema } from '../src/types/workflow.js';
import { BEARER_TOKEN, buildTestGateway, type TestGateway } from './helpers/fixtures.js';

const auth = { authorization: `Bearer ${BEARER_TOKEN}`, 'content-type': 'application/json' };
const post = { id: 'post-1', title: 'Hello', image: 'https://example.com/a.jpg', author: { name: 'Alex' }, telegram_chat_id: '42' };

let gw: TestGateway | null = null;
afterEach(async () => {
  await gw?.app.close();
  gw = null;
});

describe('webhook gateway: acceptance and normalization', () => {
  it('accepts a valid webhook with 202 and enqueues one job per matching workflow', async () => {
    gw = await buildTestGateway();
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog?ref=rss', headers: { ...auth, 'user-agent': 'blog/1.0' }, payload: post });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.duplicate).toBe(false);
    expect(body.eventType).toBe('post.published');
    expect(body.executions).toHaveLength(1);
    expect(res.headers['server-timing']).toMatch(/gateway;dur=/);
    expect(res.headers['x-request-id']).toBe(body.requestId);

    expect(gw.publisher.jobs).toHaveLength(1);
    const job = gw.publisher.jobs[0]!;
    expect(job.workflowId).toBe(gw.workflow.id);
    expect(job.executionId).toBe(body.executions[0].executionId);
    expect(job.idempotencyKey).toBe('f:post-1');
    expect(job.timings.enqueuedAt).toBeGreaterThanOrEqual(job.timings.receivedAt);
  });

  it('produces the documented normalized event shape', async () => {
    gw = await buildTestGateway();
    await gw.app.inject({ method: 'POST', url: '/webhooks/blog?ref=rss', headers: { ...auth, 'user-agent': 'blog/1.0', 'x-request-id': 'req-abc' }, payload: post });
    const event = gw.publisher.jobs[0]!.event;

    expect(normalizedEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      source: 'blog',
      type: 'post.published',
      query: { ref: 'rss' },
      body: post,
      metadata: { requestId: 'req-abc', userAgent: 'blog/1.0', endpoint: 'blog' },
    });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(event.timestamp).toString()).not.toBe('Invalid Date');
    // Credentials presented to the gateway are not forwarded to workflows by default.
    expect(event.headers['authorization']).toBe('[REDACTED]');
    expect(event.headers['user-agent']).toBe('blog/1.0');
  });

  it('forwards sensitive headers only when explicitly enabled', async () => {
    gw = await buildTestGateway({ env: { WEBHOOK_FORWARD_SENSITIVE_HEADERS: 'true' } });
    await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    expect(gw.publisher.jobs[0]!.event.headers['authorization']).toBe(`Bearer ${BEARER_TOKEN}`);
  });

  it('takes the event type from X-Event-Type, then body.type/event, then the endpoint default', async () => {
    gw = await buildTestGateway();
    const fromHeader = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, 'x-event-type': 'post.updated' }, payload: { id: 'a' } });
    expect(fromHeader.json().eventType).toBe('post.updated');
    expect(fromHeader.json().executions).toHaveLength(0); // no workflow listens to post.updated

    const fromBody = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { id: 'b', event: 'post.deleted' } });
    expect(fromBody.json().eventType).toBe('post.deleted');

    const fromDefault = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { id: 'c' } });
    expect(fromDefault.json().eventType).toBe('post.published');
  });

  it('never waits for downstream integrations (only the enqueue is awaited)', async () => {
    gw = await buildTestGateway();
    const started = performance.now();
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    expect(res.statusCode).toBe(202);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('webhook gateway: validation and HTTP errors', () => {
  it('rejects non-object JSON payloads with 400', async () => {
    gw = await buildTestGateway();
    for (const payload of ['[1,2,3]', '"text"', '42', 'null']) {
      const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    expect(gw.publisher.jobs).toHaveLength(0);
  });

  it('rejects malformed JSON with 400', async () => {
    gw = await buildTestGateway();
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: '{"title": ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('rejects invalid event types and idempotency keys with 400', async () => {
    gw = await buildTestGateway();
    const badType = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, 'x-event-type': 'bad type!' }, payload: post });
    expect(badType.statusCode).toBe(400);
    const badKey = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, 'idempotency-key': 'x'.repeat(300) }, payload: post });
    expect(badKey.statusCode).toBe(400);
  });

  it('enforces the payload size limit with 413', async () => {
    gw = await buildTestGateway({ env: { WEBHOOK_BODY_LIMIT_BYTES: '2048' } });
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { title: 'x'.repeat(5000) } });
    expect(res.statusCode).toBe(413);
  });

  it('rejects non-JSON content types with 415', async () => {
    gw = await buildTestGateway();
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { authorization: auth.authorization, 'content-type': 'text/plain' }, payload: 'hello' });
    expect(res.statusCode).toBe(415);
  });

  it('returns 404 for unknown or malformed endpoints', async () => {
    gw = await buildTestGateway();
    expect((await gw.app.inject({ method: 'POST', url: '/webhooks/unknown', headers: auth, payload: post })).statusCode).toBe(404);
    expect((await gw.app.inject({ method: 'POST', url: '/webhooks/..%2Fetc', headers: auth, payload: post })).statusCode).toBe(404);
    expect((await gw.app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
  });
});

describe('webhook gateway: authentication', () => {
  it('rejects missing or wrong bearer tokens with 401 before reading the body', async () => {
    gw = await buildTestGateway();
    const missing = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { 'content-type': 'application/json' }, payload: post });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('UNAUTHORIZED');
    const wrong = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, authorization: 'Bearer nope' }, payload: post });
    expect(wrong.statusCode).toBe(401);
    // Even a malformed body is not parsed for unauthenticated requests: auth fails first.
    const unparsed = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { 'content-type': 'application/json' }, payload: '{bad json' });
    expect(unparsed.statusCode).toBe(401);
    expect(gw.publisher.jobs).toHaveLength(0);
  });

  it('accepts X-Webhook-Token as an alternative header', async () => {
    gw = await buildTestGateway();
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { 'content-type': 'application/json', 'x-webhook-token': BEARER_TOKEN }, payload: post });
    expect(res.statusCode).toBe(202);
  });

  it('verifies HMAC signatures over the raw body', async () => {
    gw = await buildTestGateway({ endpoint: { authType: 'HMAC', tokenHash: null } });
    const raw = JSON.stringify(post);
    const ts = Math.floor(Date.now() / 1000);
    const secret = 'test-webhook-secret-0123456789'; // WEBHOOK_SECRET fallback
    const headers = { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signPayload(secret, ts, raw) };

    const ok = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers, payload: raw });
    expect(ok.statusCode).toBe(202);

    const tampered = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers, payload: raw.replace('Hello', 'Hacked') });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error.details.reason).toBe('signature_mismatch');

    const unsigned = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { 'content-type': 'application/json' }, payload: raw });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.details.reason).toBe('missing_signature');

    const stale = await gw.app.inject({
      method: 'POST',
      url: '/webhooks/blog',
      headers: { ...headers, 'x-webhook-timestamp': String(ts - 3600), 'x-webhook-signature': signPayload(secret, ts - 3600, raw) },
      payload: raw,
    });
    expect(stale.json().error.details.reason).toBe('timestamp_out_of_tolerance');
  });

  it('uses the per-endpoint HMAC secret when configured', async () => {
    gw = await buildTestGateway({ endpoint: { authType: 'HMAC', tokenHash: null, hmacSecret: 'endpoint-specific-secret' } });
    const raw = JSON.stringify(post);
    const ts = Math.floor(Date.now() / 1000);
    const good = await gw.app.inject({
      method: 'POST',
      url: '/webhooks/blog',
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signPayload('endpoint-specific-secret', ts, raw) },
      payload: raw,
    });
    expect(good.statusCode).toBe(202);
    const globalSecret = await gw.app.inject({
      method: 'POST',
      url: '/webhooks/blog',
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(ts), 'x-webhook-signature': signPayload('test-webhook-secret-0123456789', ts, raw) },
      payload: raw,
    });
    expect(globalSecret.statusCode).toBe(401);
  });
});

describe('webhook gateway: idempotency', () => {
  it('deduplicates by the configured body field and returns the original event id', async () => {
    gw = await buildTestGateway();
    const first = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    const second = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { ...post, title: 'edited' } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: true, duplicate: true, eventId: first.json().eventId });
    expect(gw.publisher.jobs).toHaveLength(1);
  });

  it('prefers the Idempotency-Key header', async () => {
    gw = await buildTestGateway();
    const a = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, 'idempotency-key': 'delivery-1' }, payload: { id: 'x' } });
    const b = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, 'idempotency-key': 'delivery-2' }, payload: { id: 'x' } });
    const c = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: { ...auth, 'idempotency-key': 'delivery-1' }, payload: { id: 'y' } });
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([202, 202, 200]);
    expect(gw.publisher.jobs[0]!.idempotencyKey).toBe('h:delivery-1');
  });

  it('falls back to a payload hash when no key is available', async () => {
    gw = await buildTestGateway({ endpoint: { idempotencyPath: null } });
    const a = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { title: 'same' } });
    const b = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { title: 'same' } });
    const c = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { title: 'different' } });
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([202, 200, 202]);
    expect(gw.publisher.jobs[0]!.idempotencyKey).toMatch(/^p:[0-9a-f]{64}$/);
  });

  it('does not deduplicate when disabled and no key is present', async () => {
    gw = await buildTestGateway({ endpoint: { idempotencyPath: null, dedupeByPayloadHash: false } });
    const a = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { title: 'same' } });
    const b = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { title: 'same' } });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
  });

  it('releases the idempotency claim when enqueueing fails, so the sender can retry', async () => {
    gw = await buildTestGateway();
    gw.publisher.failWith = new RedisError('redis down');
    const failed = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.code).toBe('REDIS_UNAVAILABLE');

    gw.publisher.failWith = null;
    const retried = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    expect(retried.statusCode).toBe(202);
    expect(gw.publisher.jobs).toHaveLength(1);
  });
});

describe('webhook gateway: rate limiting and backpressure', () => {
  it('returns 429 with Retry-After when the per-endpoint rate limit is exceeded', async () => {
    gw = await buildTestGateway({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: { id: `p-${i}` } });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    expect(last!.json().error.code).toBe('RATE_LIMITED');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies one per-IP bucket to unknown endpoints so random slugs cannot bypass the limit', async () => {
    gw = await buildTestGateway({ env: { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await gw.app.inject({ method: 'POST', url: `/webhooks/random-${i}`, headers: auth, payload: post })).statusCode);
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
    // The real endpoint keeps its own bucket.
    expect((await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post })).statusCode).toBe(202);
  });

  it('returns 503 with Retry-After when the queue is saturated', async () => {
    gw = await buildTestGateway();
    gw.backpressure.overloaded = true;
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('QUEUE_SATURATED');
    expect(res.headers['retry-after']).toBe('1');
    expect(gw.publisher.jobs).toHaveLength(0);
  });
});

describe('webhook gateway: health, readiness, metrics and shutdown', () => {
  it('exposes /health, /ready and /metrics', async () => {
    gw = await buildTestGateway();
    expect((await gw.app.inject({ method: 'GET', url: '/health' })).json().status).toBe('ok');
    expect((await gw.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    const metrics = await gw.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('automation_webhook_requests_total{outcome="accepted"');
    expect(metrics.body).toContain('automation_webhook_ack_latency_ms_quantiles{quantile="0.999"');
    const latency = (await gw.app.inject({ method: 'GET', url: '/metrics/latency' })).json();
    expect(latency.webhook_ack.count).toBe(1);
    expect(latency.webhook_ack).toHaveProperty('p99.9');
  });

  it('reports not ready and rejects new webhooks while shutting down', async () => {
    gw = await buildTestGateway();
    gw.shutdown.value = true;
    expect((await gw.app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    const res = await gw.app.inject({ method: 'POST', url: '/webhooks/blog', headers: auth, payload: post });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SHUTTING_DOWN');
  });

  it('drains in-flight requests on close (graceful shutdown)', async () => {
    gw = await buildTestGateway();
    gw.publisher.delayMs = 150;
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const address = gw.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const inFlight = fetch(`http://127.0.0.1:${port}/webhooks/blog`, { method: 'POST', headers: auth, body: JSON.stringify(post) });
    await new Promise((r) => setTimeout(r, 30));
    const closing = gw.app.close();
    const res = await inFlight;
    await closing;
    expect(res.status).toBe(202);
    expect(gw.publisher.jobs).toHaveLength(1);
    gw = null;
  });
});
