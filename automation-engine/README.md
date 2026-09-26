# Automation Engine

A lightweight, self-hosted alternative to Zapier / Make.com focused on one job: **receive a webhook and asynchronously run the actions of a stored workflow** — for example, post a Telegram photo when a blog post is published.

Stack: Node.js 22 · TypeScript (strict) · Fastify 5 · BullMQ 5 + Redis · PostgreSQL + Prisma 6 · undici (keep-alive pools) · Pino · Zod 4 · Vitest · Docker Compose.

```
External app ──POST /webhooks/:endpoint──▶ Gateway (Fastify)
                                             1. endpoint lookup          (in-memory snapshot, no DB)
                                             2. bearer token / HMAC      (before the body is parsed for bearer)
                                             3. validate + normalize     (Zod, size limit, rate limit)
                                             4. idempotency claim        (Redis Lua SET NX, 1 round trip)
                                             5. enqueue 1 job/workflow   (BullMQ)
                        ◀── 202 Accepted ──── never waits for Telegram
                                             │
                                  Redis / BullMQ
                                             │
            Worker pool (BullMQ, concurrency N, horizontally scalable)
              └─▶ Workflow engine ─▶ Template mapper ─▶ Driver registry ─▶ Telegram driver ─▶ Telegram Bot API
                    │                  (pre-compiled)                      (undici keep-alive pool, pre-warmed)
                    └─▶ async batched writes ─▶ PostgreSQL (executions, step logs, idempotency keys, dead letters)
```

**Hot-path rules** (webhook receipt → outbound request start):
no PostgreSQL queries (endpoints/workflows live in an in-memory snapshot refreshed via Redis pub/sub), no new TCP/TLS connections (pooled and pre-warmed), no synchronous logging (async Pino destination), no waiting on downstream APIs in the gateway, and all execution records are written in background batches.

---

## Latency: target, definitions and measured results

The **engineering target** is < 30 ms from webhook receipt until the outbound API request is initiated, and < 10 ms for the webhook acknowledgment, under suitable conditions (warm processes, co-located Redis, workers not saturated). It is a measurable target, not a guarantee: host load, GC pauses, queue backlog and Telegram's own rate limits all affect it. Telegram's response time (network + API) is **outside** this budget and is measured separately.

Every stage is measured with high-resolution timestamps (`performance.now()` anchored to wall-clock so the gateway and worker processes agree) and exported as Prometheus histograms plus sliding-window p50/p95/p99/p99.9 summaries:

| Metric (`automation_<name>_latency_ms`) | Measured from → to |
|---|---|
| `webhook_ack` | request received → response sent (gateway) |
| `webhook_enqueue` | Redis enqueue call duration (gateway) |
| `queue` | enqueue → worker picks the job up |
| `worker_pre_dispatch` | worker pickup → first outbound request initiated |
| `template_render` | rendering one step's configuration |
| `outbound_request_start` | **webhook receipt → outbound request initiated (the 30 ms target)** |
| `external_api` | outbound request start → response received (Telegram's latency) |
| `execution_duration` | worker pickup → job finished |
| `total_execution` | webhook receipt → job finished |

Human-readable snapshot: `GET /metrics/latency` on the gateway (`http://localhost:3001` with Docker Compose; port 3000 inside the container) and worker (`:9464`). Each execution row in PostgreSQL also stores `queue_latency_ms`, `outbound_start_latency_ms`, `execution_duration_ms` and `total_latency_ms`.

### Measured results (from a real run — reproduce with the commands in [Benchmarks](#benchmarks))

Environment: 4 vCPU / 16 GB cloud sandbox, Node 22.22, Redis 7.0, PostgreSQL 16. **Everything on the same host**: load generator, gateway, one worker process (`WORKER_CONCURRENCY=200`), Redis, PostgreSQL and a mock Telegram API with 30 ms simulated latency. `LOG_LEVEL=info`. Open-loop constant arrival rate, 20 s per stage, latency measured from each request's scheduled send time. Server-side percentiles are interpolated from histogram buckets.

| Target rate | Achieved | Errors | Client latency p50 / p95 / p99 / p99.9 (ms) | Ack p50 / p99 (ms) | **Receipt → request start** p50 / p95 / p99 / p99.9 (ms) | Worker CPU | Gateway CPU |
|---:|---:|---:|---|---|---|---:|---:|
| 100/s | 100/s | 0 | 2.1 / 3.0 / 4.5 / 11.1 | 1.1 / 2.6 | **1.8 / 2.9 / 4.6 / 15.0** | 24% | 14% |
| 500/s | 500/s | 0 | 1.6 / 2.9 / 6.9 / 17.9 | 0.7 / 3.1 | **1.4 / 3.9 / 11.2 / 28.0** | 65% | 34% |
| 1,000/s | 1,000/s | 0 | 1.6 / 3.5 / 6.0 / 8.9 | 0.6 / 3.0 | **1.6 / 9.6 / 18.8 / 38.7** | 92% | 46% |
| 2,000/s | 2,000/s | 0 | 2.2 / 8.0 / 13.3 / 35.8 | 0.8 / 8.3 | 24 / 215 / 247 / 456 (worker saturated) | 112% | 59% |

- Template rendering: 0.3 µs for the 3-field Telegram config, 2.6 µs for a rich HTML caption with filters (`npm run bench:mapper`).
- RSS at 1,000/s: gateway ≈ 150 MB, worker ≈ 400 MB.
- Tails near worker saturation vary between runs: repeat runs at 1,000/s gave receipt → request start p99 of 19–26 ms and p99.9 of 39–69 ms (medians were stable at 1.6–1.7 ms).
- **One worker process sustains roughly 1,000 jobs/s** before its queue backs up; beyond that, run more worker processes (`docker compose up -d --scale worker=N`).
- **5,000 req/s was not reachable on this host.** With 3 worker processes, the co-located setup accepted at most ≈ 3,380 webhooks/s (closed-loop `--mode max`), and the 5,000/s open-loop stage achieved 3,293/s because the load generator, gateway, workers, Redis, PostgreSQL and the mock all compete for 4 vCPUs. Results with 3 workers at 2,000/s varied between runs (receipt → request start p99 of 24 ms in one run, 181 ms in another) for the same reason. Run the load generator on a separate machine to measure higher rates.

---

## Project layout

```
automation-engine/
├── src/
│   ├── server.ts                    # gateway entrypoint (wiring + graceful shutdown)
│   ├── worker.ts                    # worker entrypoint (wiring + graceful shutdown)
│   ├── app.ts                       # Fastify factory: JSON-only parser (raw body kept), error handler, /health /ready /metrics
│   ├── config.ts                    # Zod-validated environment configuration
│   ├── errors.ts                    # error taxonomy + classification (retryable vs permanent)
│   ├── gateway/webhook.ts           # POST /webhooks/:endpoint (auth, HMAC, validation, idempotency, enqueue)
│   ├── gateway/schemas.ts           # Zod request schemas + fast JSON response schemas
│   ├── gateway/idempotency.ts       # Redis Lua claim/release (+ in-memory store for tests)
│   ├── queue/connection.ts          # ioredis connections tuned per role (fail-fast producer, blocking worker)
│   ├── queue/automation.queue.ts    # BullMQ queue, job options, publisher, backpressure monitor
│   ├── workers/automation.worker.ts # processor: retries, rate-limit deferral, dead-lettering, step resume
│   ├── workers/dead-letter.ts       # dead-letter sink (PostgreSQL + BullMQ DLQ)
│   ├── workflows/workflow-engine.ts # runs ordered steps through the driver registry
│   ├── workflows/workflow-loader.ts # in-memory snapshot of endpoints/workflows (compiled templates, decrypted credentials)
│   ├── mapper/template-mapper.ts    # safe {{path | filter}} engine (no eval)
│   ├── integrations/integration-driver.ts  # driver/action interfaces + registry (extension point)
│   ├── integrations/index.ts        # built-in driver wiring
│   ├── integrations/telegram/telegram-driver.ts  # sendMessage / sendPhoto
│   ├── integrations/http/http-driver.ts          # generic http.request (SSRF-protected)
│   ├── database/prisma.ts           # Prisma client with pool parameters
│   ├── database/execution-recorder.ts  # async, batched, coalescing execution writer
│   ├── security/hmac.ts             # HMAC signatures + bearer token hashing
│   ├── security/credentials.ts      # AES-256-GCM credential encryption
│   ├── security/ssrf.ts             # private-address blocking + DNS-rebinding-safe agent
│   ├── security/redact.ts           # secret redaction (tokens, bearer, signatures)
│   ├── observability/logger.ts      # Pino (async destination, redaction)
│   ├── observability/metrics.ts     # Prometheus metrics, p50/p95/p99/p99.9
│   ├── observability/timing.ts      # cross-process high-resolution clock
│   ├── observability/health-server.ts  # worker /health /ready /metrics
│   ├── lib/retry.ts                 # exponential backoff with jitter
│   ├── lib/rate-limiter.ts          # token buckets (per bot, per chat)
│   ├── lib/shutdown.ts              # ordered graceful shutdown with timeout
│   ├── scripts/create-workflow.ts   # create/update user, credentials, endpoint, workflows
│   ├── scripts/requeue-dead-letters.ts  # list / requeue / discard dead letters safely
│   ├── scripts/mock-telegram.ts     # mock Telegram API for tests and benchmarks
│   └── types/workflow.ts            # normalized event, job payload, workflow definitions
├── prisma/schema.prisma             # + prisma/migrations/
├── tests/                           # Vitest unit tests, integration test, benchmarks
├── bench/load-test.ts               # open-loop / max-throughput load test (undici, autocannon)
├── bench/k6-webhook.js              # k6 constant-arrival-rate scenario
├── examples/                        # workflow definitions and a sample payload
├── docker/redis.conf                # Redis tuned for BullMQ (noeviction, AOF)
├── Dockerfile, docker-compose.yml, docker-compose.dev.yml
├── .env.example, .gitignore, .dockerignore
├── package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
└── README.md
```

---

## Quick start (Docker Compose)

Requirements: Docker with Compose v2, `openssl`, a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
cd automation-engine
cp .env.example .env

# Generate secrets (on macOS use: sed -i '' ...)
sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
sed -i "s/^WEBHOOK_SECRET=.*/WEBHOOK_SECRET=$(openssl rand -hex 32)/" .env
# Then edit .env and set TELEGRAM_BOT_TOKEN=<token from BotFather>
# and TELEGRAM_CHANNEL_ID=<@yourchannel or -100… channel ID> (the bot must be a channel admin)

# Build and start PostgreSQL, Redis, migrations, gateway and worker
docker compose up -d --build
docker compose ps            # gateway and worker should become "healthy"; migrate exits 0

# Create the example workflow (prints the webhook token ONCE — copy it)
docker compose run --rm gateway node dist/scripts/create-workflow.js examples/blog-to-telegram.workflow.json
export WEBHOOK_TOKEN=<token printed above>
```

Find your chat id: send any message to your bot, then
`curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"` and read `result[].message.chat.id`.

Send a test webhook:

```bash
export TELEGRAM_CHAT_ID=<your chat id>
sed "s/REPLACE_WITH_YOUR_CHAT_ID/$TELEGRAM_CHAT_ID/" examples/post-published.json > /tmp/post.json

curl -i -X POST http://localhost:3001/webhooks/blog \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $WEBHOOK_TOKEN" \
  --data-binary @/tmp/post.json
# HTTP/1.1 202 Accepted  + {"accepted":true,"eventId":"…","executions":[{"executionId":"…"}]}
```

Verify the Telegram execution:

```bash
# 1. The photo appears in your Telegram chat.
# 2. Worker log line with per-stage latency:
docker compose logs worker | grep '"execution succeeded"' | tail -1
# 3. Execution record:
docker compose exec postgres psql -U automation -d automation -c \
  "select status, attempts, queue_latency_ms, outbound_start_latency_ms, total_latency_ms from executions order by created_at desc limit 5;"
# 4. Latency percentiles:
curl -s localhost:3001/metrics/latency
docker compose exec worker node -e "fetch('http://127.0.0.1:9464/metrics/latency').then(r=>r.text()).then(console.log)"
```

The gateway is published on host port **3001** (`3001:3000` in `docker-compose.yml`), so `http://localhost:3001/health` must return 200.

### Blogger → Telegram channel

`examples/blog-to-telegram.workflow.json` posts every `post.published` event to the channel in `TELEGRAM_CHANNEL_ID`:

- **Post with a usable image** (`image` is an absolute http(s) URL): `telegram.sendPhoto` with the image and a caption containing the title, the excerpt (HTML stripped, truncated) and the post URL.
- **Post without an image** (`image` empty, missing, `null` or not a URL): `telegram.sendMessage` with the same title, excerpt and URL; `sendPhoto` is never called.
- **Image URL Telegram cannot use** (unreachable, not an image, caption too long): the photo step sends the caption as a text message instead (`fallbackToMessage`), so the execution still succeeds.

The destination comes from `TELEGRAM_CHANNEL_ID` (`@channelusername` for a public channel, or the `-100…` channel ID); the Blogger payload does not need to carry a chat ID. Personal chat IDs are rejected at startup. Test payloads for each case are in `examples/test-post-*.json`.

Posts that were dead-lettered before a fix cannot be re-sent from the Apps Script (their `id` is already recorded for idempotency). Requeue them instead: `docker compose run --rm gateway node dist/scripts/requeue-dead-letters.js --list`, then `--id <id>` or `--all`. They run with the current workflow version.

Scale workers horizontally: `docker compose up -d --scale worker=3`.
Stop gracefully (drains in-flight requests and jobs): `docker compose stop`.

## Local development (Node on the host)

```bash
cd automation-engine
npm ci
cp .env.example .env                        # set ENCRYPTION_KEY, WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN as above

# PostgreSQL + Redis in Docker, published on 127.0.0.1 only
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis

npm run db:migrate                          # prisma migrate deploy
npm run dev:gateway                         # terminal 1 (listens on PORT from .env; use PORT=3001 if 3000 is taken)
npm run dev:worker                          # terminal 2 (metrics on :9464)
npm run workflow:create -- examples/blog-to-telegram.workflow.json
```

Production-style on the host: `npm run build && npm run start:gateway` and `npm run start:worker`.

---

## Testing scenarios

### Duplicate events (idempotency)

```bash
for i in 1 2; do
  curl -s -X POST localhost:3001/webhooks/blog -H 'content-type: application/json' \
    -H "authorization: Bearer $WEBHOOK_TOKEN" --data-binary @/tmp/post.json; echo
done
# 1st: 202 {"duplicate":false,"eventId":"X",…}
# 2nd: 200 {"duplicate":true,"eventId":"X",…}   ← same event id, no second Telegram message
```

Key precedence: `Idempotency-Key` header → `X-Event-Id` header → the endpoint's `idempotencyField` in the body (`"id"` in the example) → SHA-256 of the raw body (if `dedupeByPayloadHash`). Keys live in Redis for `IDEMPOTENCY_TTL_SEC` (24 h default) and are recorded in the `idempotency_keys` table.

### Retries with exponential backoff (mock Telegram failing twice)

```bash
# In .env: TELEGRAM_API_BASE_URL=http://mock-telegram:8081   (host dev: http://localhost:8081)
MOCK_FAIL_FIRST=2 docker compose --profile bench up -d mock-telegram
docker compose up -d worker                  # pick up the new base URL
curl -s -X POST localhost:3001/webhooks/blog -H 'content-type: application/json' \
  -H "authorization: Bearer $WEBHOOK_TOKEN" \
  --data-binary '{"id":"retry-demo","title":"Retry demo","image":"https://example.com/a.jpg","telegram_chat_id":"42"}'
docker compose logs worker | grep -E 'retry scheduled|execution succeeded' | tail -3
# two "execution failed; retry scheduled" lines, then "execution succeeded"; executions.attempts = 3
```

Host development equivalent: `MOCK_FAIL_FIRST=2 npm run mock:telegram` and restart `npm run dev:worker`.

### Dead letters and safe requeueing

```bash
MOCK_ERROR_RATE=1 docker compose --profile bench up -d mock-telegram      # every call fails with 500
curl -s -X POST localhost:3001/webhooks/blog -H 'content-type: application/json' \
  -H "authorization: Bearer $WEBHOOK_TOKEN" \
  --data-binary '{"id":"dlq-demo","title":"DLQ demo","image":"https://example.com/a.jpg","telegram_chat_id":"42"}'
# after MAX_RETRIES+1 attempts (default backoff: up to 1 s, 2 s, 4 s, 8 s, 16 s; each delay is jittered between 50% and 100%):
docker compose run --rm gateway node dist/scripts/requeue-dead-letters.js --list

MOCK_ERROR_RATE=0 docker compose --profile bench up -d mock-telegram      # "fix" Telegram
docker compose run --rm gateway node dist/scripts/requeue-dead-letters.js --all
# requeued 1/1 dead-letter job(s); running it again requeues nothing (claims are atomic)
```

Host development: `npm run dlq:list`, `npm run dlq:requeue -- --all`, `npm run dlq:requeue -- --id <id>`, `npm run dlq:requeue -- --discard --id <id>`.
Permanent errors (400 Bad Request, invalid token, template/config errors) are dead-lettered immediately without retries.

### HMAC-signed webhooks

`examples/blog-to-telegram-advanced.workflow.json` creates an HMAC endpoint (`/webhooks/blog-signed`) with a rich HTML caption, a photo step and a text fallback (`runIf`). Signature scheme: `X-Webhook-Timestamp: <unix seconds>` and `X-Webhook-Signature: sha256=hex(HMAC_SHA256(secret, "<timestamp>.<raw body>"))`, 300 s tolerance. The secret is `WEBHOOK_SECRET` unless the endpoint defines its own (`hmacSecretEnv`).

```bash
docker compose run --rm gateway node dist/scripts/create-workflow.js examples/blog-to-telegram-advanced.workflow.json
WEBHOOK_SECRET=$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2-)
BODY=$(cat /tmp/post.json)
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -i -X POST localhost:3001/webhooks/blog-signed -H 'content-type: application/json' \
  -H "x-webhook-timestamp: $TS" -H "x-webhook-signature: sha256=$SIG" --data-binary "$BODY"
```

### Automated tests

```bash
npm test                      # unit tests (no external services needed)
npm run test:integration      # real Redis + BullMQ pipeline (uses redis://localhost:6379/15)
npm run typecheck
npm run bench:mapper          # template mapper micro-benchmarks
```

Unit tests cover webhook validation, HMAC, authentication, template mapping (nested/missing/null values, filters, safety), idempotency, workflow execution, the Telegram driver (keep-alive reuse, 429/Retry-After, 5xx inline retry, 400/401 classification, timeouts, per-chat throttling, token redaction), retries/backoff, rate limits, dead-letter handling, execution recording, SSRF protection and graceful shutdown. The integration test runs gateway → BullMQ → worker → fake Telegram with real Redis: delivery, duplicates, retry-then-succeed, retry exhaustion → DLQ, permanent failure → DLQ, and a throttled burst with zero dead letters.

---

## Benchmarks

Benchmark the engine against the mock Telegram API, otherwise you are measuring Telegram's rate limits (30 msg/s per bot) instead of the engine.

```bash
npm ci && npm run build
# .env overrides for benchmarking (append or edit):
#   TELEGRAM_API_BASE_URL=http://localhost:8081
#   RATE_LIMIT_MAX=1000000
#   TELEGRAM_RATE_LIMIT_GLOBAL_PER_SEC=100000
#   TELEGRAM_RATE_LIMIT_PER_CHAT_PER_SEC=100000
#   TELEGRAM_RATE_LIMIT_PER_CHAT_BURST=100000
#   WORKER_CONCURRENCY=200
#   TELEGRAM_POOL_CONNECTIONS=128

MOCK_LATENCY_MS=30 npm run mock:telegram                 # terminal 1
npm run start:gateway                                    # terminal 2
npm run start:worker                                     # terminal 3 (more workers: WORKER_METRICS_PORT=9465 npm run start:worker)
npm run workflow:create -- examples/blog-to-telegram.workflow.json --rotate-token
export WEBHOOK_TOKEN=<printed token>

# Open-loop constant arrival rate, 20 s per stage (latency + CPU + RSS per stage)
npm run bench:load -- --token "$WEBHOOK_TOKEN" --rates 100,500,1000,5000 --duration 20
# Several workers: --worker http://localhost:9464,http://localhost:9465
# Maximum throughput (closed loop, autocannon):
npm run bench:load -- --token "$WEBHOOK_TOKEN" --mode max --connections 100 --duration 20
```

Each stage prints throughput, client p50/p95/p99/p99.9, and server-side p50/p95/p99/p99.9 for ack, enqueue, queue wait, worker pre-dispatch, template render, receipt → request start, external API and total execution, plus gateway/worker CPU and RSS. Results are also written to `bench/results/<run>.json`.

k6 inside the Compose network:

```bash
# In .env: TELEGRAM_API_BASE_URL=http://mock-telegram:8081 and the overrides above
docker compose --profile bench up -d mock-telegram && docker compose up -d
WEBHOOK_TOKEN=<token> RATES=100,500,1000,5000 STAGE_SECONDS=20 docker compose --profile bench run --rm k6
```

For meaningful numbers at thousands of requests per second, run the load generator on a different machine from the engine.

---

## Workflows

A definition file (see `examples/`) contains an owner, credentials (values read from environment variables, never stored in the file), one endpoint and one or more workflows:

```json
{
  "trigger": { "type": "webhook", "event": "post.published" },
  "steps": [
    {
      "key": "announce",
      "type": "telegram.sendPhoto",
      "credential": "telegram-bot",
      "config": {
        "chatId": "{{trigger.body.telegram_chat_id}}",
        "photo": "{{trigger.body.image}}",
        "caption": "{{trigger.body.title}}"
      }
    }
  ]
}
```

- `trigger.event` matches the event type (`X-Event-Type` header → `body.type` → `body.event` → endpoint default); `"*"` matches everything.
- Steps run in order; each step's output is available to later steps as `{{steps.<key>.output...}}`.
- Optional per step: `runIf` (template; the step runs only if it renders truthy), `timeoutMs`, `credential`.
- Telegram steps without `chatId` (or with an empty one) send to `TELEGRAM_CHANNEL_ID`. `telegram.sendPhoto` accepts `"fallbackToMessage": true` to deliver the caption as text when the photo is missing or rejected by Telegram.
- Re-running `create-workflow` updates the workflow (version + 1) and tells running processes to reload.

Every job receives this normalized event as `trigger`:

```json
{
  "id": "6fdcb160-6ac3-4abc-bec5-9e69cd394e99",
  "source": "blog",
  "type": "post.published",
  "timestamp": "2026-09-25T18:06:02.123Z",
  "headers": { "content-type": "application/json", "user-agent": "…", "authorization": "[REDACTED]" },
  "query": {},
  "body": { "id": "post-1001", "title": "…", "image": "…" },
  "metadata": { "requestId": "…", "userAgent": "…", "ip": "…", "endpoint": "blog", "receivedAt": 1790359562123.456 }
}
```

Credential-bearing headers are redacted unless `WEBHOOK_FORWARD_SENSITIVE_HEADERS=true` (needed only if a template must use `{{trigger.headers.authorization}}`).

### Template syntax

| Syntax | Meaning |
|---|---|
| `{{trigger.body.title}}` | nested property |
| `{{trigger.body.author.name}}`, `{{trigger.body.items[0].name}}`, `{{trigger.body["a key"]}}` | nesting, array index, quoted key |
| `{{trigger.headers.authorization}}`, `{{trigger.query.id}}` | headers (lower-case names) and query string |
| `{{steps.announce.output.messageId}}`, `{{workflow.id}}`, `{{execution.id}}` | other roots |
| `{{ path \| filter \| filter:arg }}` | filters, applied left to right |
| `\{{` | literal `{{` |

Filters: `default:"x"`, `escape_html`, `escape_markdown` (Telegram MarkdownV2), `strip_html`, `truncate:N` (code-point safe), `upper`, `lower`, `trim`, `json`, `url_encode`, `join:", "`, `first`, `number`, `string`, `not`, `http_url` (the value if it is an absolute http(s) URL, otherwise empty; `//host/…` becomes `https://host/…`).

Semantics: a template that is exactly one expression keeps the value's type (number, boolean, object); otherwise the result is a string. Missing and null values render as `""` inside strings, and config keys whose single expression is missing/null are omitted (so optional Telegram fields disappear). Templates are compiled when workflows load; syntax errors surface then. No `eval`/`Function`; only the roots `trigger`, `steps`, `workflow`, `execution` are reachable, own properties only, and `__proto__`/`prototype`/`constructor` are rejected.

### Adding an integration (Discord, Slack, Email, WhatsApp, …)

Write a driver and register it in `src/integrations/index.ts`; the worker and engine do not change.

```ts
import { z } from 'zod';
import { request } from 'undici';
import { defineAction, type IntegrationDriver } from '../integration-driver.js';
import { ExternalApiError } from '../../errors.js';

export function createDiscordDriver(): IntegrationDriver {
  return {
    name: 'discord',
    actions: [
      defineAction({
        type: 'discord.sendMessage',
        credentialProvider: 'discord',
        configSchema: z.object({ content: z.string().min(1).max(2000) }),
        async execute(config, ctx) {
          const webhookUrl = String(ctx.credential?.data['webhookUrl'] ?? '');
          ctx.markRequestStart();
          const res = await request(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config),
            signal: ctx.signal,
          });
          ctx.markResponse();
          await res.body.dump();
          if (res.statusCode >= 400) throw new ExternalApiError(`Discord HTTP ${res.statusCode}`, res.statusCode);
          return { output: { status: res.statusCode } };
        },
      }),
    ],
  };
}
```

A generic SSRF-protected `http.request` action is already built in (`url`, `method`, `headers`, `body`, `expectStatus`).

---

## Reliability

- **Acknowledge fast, execute asynchronously**: the gateway returns 202 once the job is in Redis; Telegram is never on the request path.
- **Idempotency**: atomic Redis claim per endpoint + key; the claim is released if enqueueing fails, so the sender's retry is accepted.
- **Error classification** (`src/errors.ts`): validation, authentication, configuration, template → permanent; network, timeout, rate limit, 5xx external API, Redis, transient PostgreSQL → retryable; unknown → not retried (dead-lettered, requeue manually).
- **Retries**: BullMQ attempts = `MAX_RETRIES + 1`, custom backoff = exponential with jitter (`RETRY_BASE_DELAY_MS` doubling, capped at `RETRY_MAX_DELAY_MS`), honoring Telegram's `retry_after` exactly. The Telegram driver also retries inline once for failures where the request provably never reached Telegram (connect errors) and for 5xx.
- **Rate limits are not failures**: Telegram 429s and client-side throttling (token buckets per bot and per chat) postpone the job with BullMQ `moveToDelayed` without consuming a retry attempt, for up to `JOB_RATE_LIMIT_MAX_DEFER_MS`.
- **Step-level resume**: after each successful step (except the last) the step output is saved on the job; retries and requeues skip completed steps, so a multi-step workflow does not repeat an already-sent message.
- **Dead letters**: permanent failures and exhausted retries are written to `dead_letter_jobs` (with the resume state) and to the `automation-dead-letter` BullMQ queue; requeue is atomic per row.
- **Timeouts**: HTTP headers/body timeout (`HTTP_TIMEOUT_MS`), per-step (`STEP_TIMEOUT_MS` or `timeoutMs`), per-job (`JOB_TIMEOUT_MS`).
- **Crash recovery**: jobs held by a crashed worker become "stalled" after the lock expires and are retried by another worker (BullMQ `lockDuration`/`stalledInterval`).
- **Graceful shutdown** (SIGTERM/SIGINT): stop accepting, drain in-flight HTTP requests (with `Connection: close`), let active jobs finish, flush execution records, close pools, then Redis and PostgreSQL; forced exit after `SHUTDOWN_TIMEOUT_MS`.
- **Backpressure**: 503 + `Retry-After` when Redis is unavailable or the queue exceeds `QUEUE_BACKPRESSURE_THRESHOLD`.

## Security

- Bearer tokens are stored as SHA-256 hashes and compared in constant time; bearer auth runs before the body is parsed.
- HMAC-SHA256 over `timestamp.rawBody` with replay tolerance; multiple signatures accepted during secret rotation.
- Credentials are encrypted with AES-256-GCM (`ENCRYPTION_KEY`, key id for rotation); plaintext exists only in worker memory.
- Secrets are redacted in logs (structured fields and message strings), error messages, execution rows and dead-letter payloads; bot tokens are never logged.
- Payload size limit, JSON-only content type, prototype-poisoning protection, per-endpoint+IP rate limiting.
- Templates cannot execute code or reach prototypes; SQL goes through Prisma (parameterized, including the raw bulk upsert).
- SSRF protection for `http.request`: scheme allowlist, no credentials in URLs, private/loopback/link-local/metadata ranges blocked, re-validated at connect time (DNS rebinding), redirects not followed.

## Observability

- Gateway: `GET /health` (liveness), `GET /ready` (Redis, workflow snapshot, queue below threshold, not shutting down), `GET /metrics` (Prometheus), `GET /metrics/latency` (JSON p50/p95/p99/p99.9, 60 s window).
- Worker: the same endpoints on `WORKER_METRICS_PORT` (9464).
- Metrics: latency histograms + quantiles listed above, `automation_webhook_requests_total{outcome}`, `automation_jobs_processed_total{status}`, `automation_job_retries_total{category}`, `automation_job_failures_total{category}`, `automation_dead_letter_jobs_total{category}`, `automation_queue_depth{state}`, `automation_idempotency_duplicates_total`, `automation_recorder_dropped_total`, plus Node.js process metrics (CPU, RSS, event loop lag, GC).
- Logs: JSON with `requestId`, `eventId`, `workflowId`, `executionId`, `stepId`/`stepKey`, `jobId`, `attempt` and per-stage timings.

## Configuration

All variables are documented in [`.env.example`](.env.example) and validated at startup by `src/config.ts`. The main ones:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | runtime mode |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | gateway listen address |
| `DATABASE_URL` | — | PostgreSQL connection (pool size via `DATABASE_POOL_SIZE`) |
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ, idempotency, cache invalidation |
| `WORKER_CONCURRENCY` | `50` | concurrent jobs per worker process |
| `WEBHOOK_SECRET` | — | default HMAC secret (min 16 chars) |
| `ENCRYPTION_KEY` | — | 32-byte key (64 hex chars) for credential encryption |
| `TELEGRAM_BOT_TOKEN` | — | fallback bot token for steps without a credential |
| `TELEGRAM_CHANNEL_ID` | — | default destination: `@channelusername` or `-100…` channel ID |
| `HTTP_TIMEOUT_MS` | `10000` | outbound headers/body timeout |
| `MAX_RETRIES` | `5` | retries after the first attempt |
| `LOG_LEVEL` | `info` | Pino level |

## Known limitations

- Telegram has no idempotency key: if a request times out after Telegram accepted it, the retry can post twice (at-least-once delivery). Only connect-phase failures are retried inline, where a duplicate is impossible.
- Client-side Telegram token buckets are per worker process; with N workers the effective client-side ceiling is N × the configured rate. Telegram's own 429 responses are still honored.
- The Redis idempotency window is `IDEMPOTENCY_TTL_SEC`; the `idempotency_keys` table is an audit trail and is not consulted on the hot path.
- Cross-process latency relies on the host clock; compare gateway and worker timings only on NTP-synchronized hosts.
- Execution records are written asynchronously: a hard crash can lose up to `RECORDER_FLUSH_INTERVAL_MS` of records (not jobs). Redis AOF `everysec` can lose up to ~1 s of accepted jobs if Redis itself crashes.
