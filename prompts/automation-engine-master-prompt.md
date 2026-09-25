# Master Prompt: Ultra-Low-Latency Automation Engine

A copy-pasteable prompt for Claude. It asks Claude to design and build a self-hosted,
sub-30ms webhook → REST automation engine (a lightweight alternative to Zapier / Make.com),
with Blog → Telegram as the reference use case.

**How to use**

1. Edit the values in `<project_config>` (stack, throughput, host size) if needed.
2. Paste everything inside the code block below into Claude.
3. The output is longer than one response. When Claude stops with `⏸ CONTINUE → ...`, reply `continue`.

````text
<role>
You are a Principal Engineer and distributed-systems architect with deep production experience building low-latency event pipelines: webhook ingestion, message queues, HTTP client tuning, PostgreSQL, and Redis internals. You write code that ships: complete, idiomatic, benchmarked, observable, and safe to operate at 3 a.m. You make decisive technical choices, state the trade-off in one or two sentences, and move on.
</role>

<mission>
Design and implement, end to end, a production-grade, ultra-low-latency automation engine: a lightweight, self-hosted alternative to Zapier / Make.com that does one thing extremely fast. It catches an inbound webhook and executes the outbound REST calls defined by a stored workflow.

Reference use case (must work out of the box after `docker compose up` + seed):
A blog platform fires a "post published" webhook → the engine renders a Telegram message from the payload → it calls the Telegram Bot API `sendPhoto` (cover image + formatted caption), falling back to `sendMessage` when the post has no image.
</mission>

<project_config>
Treat these values as authoritative.

PRIMARY_STACK      = Go (latest stable)            # alternative: Node.js 24 LTS + Fastify 5 + undici
QUEUE              = Redis Streams + consumer groups  # BullMQ allowed ONLY in the Node variant, ONLY for delayed retries (see <queue_rules>)
DATABASE           = PostgreSQL 17 or newer (generate UUIDv7 in application code; do not depend on a built-in uuidv7())
REDIS              = Redis 7.4+ (Valkey 8 is an acceptable drop-in)
ORCHESTRATION      = Docker Compose
TARGET_HOST        = 4 vCPU / 8 GB RAM, Linux, SSD, all services on one Docker network
TARGET_THROUGHPUT  = 1,000 webhooks/s sustained; bursts of 5,000/s for 10 s
MAX_WEBHOOK_BODY   = 256 KB
LATENCY_SLO_E2E    = p99 ≤ 30 ms  (trigger received → outbound request dispatched; exact definition in <latency_definition>)
LATENCY_SLO_ACK    = p99 ≤ 10 ms  (trigger received → HTTP 202 written)
DELIVERY_SEMANTICS = at-least-once queueing + idempotency keys + step-level resume ⇒ effectively-once Telegram posts
</project_config>

Implement ONLY PRIMARY_STACK. Do not produce a second implementation in the other stack; depth beats breadth.

<latency_definition>
Instrument exactly these points:
- T0 (received_at): gateway handler entry, high-resolution clock, before the body is read.
- T_ack: HTTP 202 response written to the client.
- T_dispatch: the outbound request to Telegram has been fully written to the socket (Go: `httptrace.ClientTrace.WroteRequest`; Node: undici diagnostics channel `undici:request:bodySent`).
- T_resp: Telegram response headers received. This is informational only: third-party network RTT is NOT part of the SLO, but it must be recorded separately.

E2E SLO = T_dispatch − T0. ACK SLO = T_ack − T0.
Gateway and worker are separate processes on the same host, so carry T0 as wall-clock Unix nanoseconds inside the queue message.
Expose all three durations as Prometheus histograms with sub-millisecond buckets (0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100, 250 ms).
</latency_definition>

<latency_budget>
Starting budget. In Section 1, confirm or refine each line with a justification. Every component you build must fit it.

| Stage                                                                   | p99 budget |
|-------------------------------------------------------------------------|------------|
| Gateway: body read, JSON well-formedness, token lookup, HMAC verify     | 1.0 ms     |
| Redis round-trip: idempotency check + XADD in one Lua call              | 1.5 ms     |
| 202 response write                                                      | 0.5 ms     |
| Queue hand-off: XREADGROUP BLOCK wake-up → in-process channel → worker  | 3.0 ms     |
| Message decode + execution-context build                                | 0.5 ms     |
| Template rendering, all steps, pre-compiled                             | 0.2 ms     |
| In-memory lookups: workflow, decrypted credential, rate limiter         | 0.1 ms     |
| Outbound request write on a warm, pre-established TLS connection        | 1.0 ms     |
| Nominal total                                                           | ≈ 8 ms     |
| Headroom for GC, scheduler jitter, burst contention                     | ≈ 22 ms    |
</latency_budget>

<architecture_invariants>
Non-negotiable. If a design choice violates one of these, change the design.

1. Nothing on the hot path touches PostgreSQL. Workflows, steps, compiled templates, workflow variables, and decrypted credentials live in an in-memory, immutable snapshot that is swapped atomically. Invalidate it via PostgreSQL LISTEN/NOTIFY (triggers on workflow/step/credential/variable changes), with a periodic full resync (e.g., every 60 s) as a safety net.
2. Nothing on the hot path performs DNS resolution, TCP connect, or a TLS handshake in steady state. Outbound connection pools are pre-warmed at startup and kept warm.
3. The gateway does not fully decode the payload. It validates size, content type, JSON well-formedness, and signature, then enqueues the raw bytes. Decoding happens once, in the worker.
4. The gateway returns 202 only after Redis has durably accepted the message (XADD returned). No fire-and-forget.
5. Logging, execution-log persistence, and metrics on the hot path are non-blocking: bounded in-memory buffers flushed asynchronously in batches. If a buffer is full, drop the entry and increment a counter. Never block dispatch.
6. Every queue and buffer is bounded, and backpressure is explicit: the gateway returns 503 + Retry-After when Redis is unavailable or consumer-group lag exceeds a configured threshold.
7. Every outbound call has a timeout, every retry loop has a cap, and every goroutine/loop has a shutdown path. Graceful shutdown drains in-flight work; unacknowledged messages are recovered by other workers.
8. Secrets (bot tokens, HMAC secrets) are encrypted at rest (AES-256-GCM, versioned key from env), decrypted only in process memory, and never logged. Webhook tokens are stored only as SHA-256 hashes. Telegram bot tokens appear in URL paths, so redact them in every log line, error string, and trace attribute.
</architecture_invariants>

<queue_rules>
- Hot path: Redis Streams with a consumer group. The gateway uses XADD with approximate MAXLEN trimming. The worker runs a fetcher loop (XREADGROUP with COUNT and BLOCK) that feeds a bounded in-process channel consumed by a fixed-size worker pool. This two-tier design (durable Redis stream + in-memory channel) is the "in-memory queueing" layer.
- XACK only after a terminal outcome for that delivery: success, dead-lettered, or a retry durably scheduled.
- Delayed retries: a Redis sorted set scored by due time. A scheduler moves due entries back to the stream with an atomic Lua script (ZRANGEBYSCORE + ZREM + XADD), so multiple worker replicas never double-enqueue.
- Crash recovery: periodic XAUTOCLAIM of entries idle longer than a visibility timeout. Entries that exceed the max delivery count go to a dead-letter stream, and the execution is recorded as `dead_lettered`.
- Idempotency: the gateway derives a key from the `Idempotency-Key` header, else from a per-workflow configurable payload field (e.g., `id`), else none. One Lua script performs SET NX EX + XADD atomically in a single round trip. Duplicates return 200 with the original execution_id.
- Step-level resume: on retry, steps that already succeeded are NOT re-executed. Store completed step outputs in a short-TTL Redis hash keyed by execution_id. This prevents duplicate Telegram posts in multi-step workflows.
- If PRIMARY_STACK is Node and you choose BullMQ for delayed retries, justify it against the sorted-set approach in ≤ 3 sentences.
</queue_rules>

<telegram_facts>
Use only real, documented Telegram Bot API behavior:
- Endpoint: POST {TELEGRAM_API_BASE_URL}/bot<token>/<method> with a JSON body. The base URL must be configurable so a mock server can replace api.telegram.org in tests and benchmarks.
- Methods in scope: `sendMessage` (text ≤ 4096 characters after entity parsing) and `sendPhoto` (photo as an HTTPS URL or file_id; caption ≤ 1024 characters after entity parsing). Default `parse_mode` is "HTML".
- Response envelope: `{ "ok": true, "result": ... }` or `{ "ok": false, "error_code": N, "description": "...", "parameters": { ... } }`. `parameters.retry_after` (seconds) accompanies 429; `parameters.migrate_to_chat_id` accompanies group → supergroup migrations.
- Rate limits: about 30 messages/s per bot overall, about 1 message/s per chat, about 20 messages/min per group. Implement token buckets keyed by (bot, chat). If the required wait is short (≤ a configurable threshold, e.g., 50 ms), wait in the worker; otherwise reschedule through the retry sorted set instead of holding a worker slot.
- Error classification: network errors, timeouts, 5xx, and 429 are retryable (429 honors retry_after exactly). 400 (bad request, chat not found, can't parse entities, caption too long) and 401/403 (invalid token, bot blocked or kicked) are permanent. migrate_to_chat_id triggers one retry against the new chat id plus a warning event.
</telegram_facts>

<sample_trigger_payload>
{
  "event": "post.published",
  "id": "post_01J9Z6Q7XK",
  "title": "Shipping a Sub-30ms Automation Engine",
  "excerpt": "<p>How we replaced a <b>SaaS</b> automation tool with a Redis stream & 2,000 lines of code.</p>",
  "url": "https://blog.example.com/posts/sub-30ms-engine",
  "cover_image": "https://blog.example.com/images/engine-cover.jpg",
  "tags": [{ "name": "Go" }, { "name": "Performance" }],
  "author": { "name": "Alex Doe" },
  "published_at": "2026-09-25T10:00:00Z"
}
</sample_trigger_payload>

<sample_workflow>
The seed must create exactly this demo workflow (adapt the syntax to your schema).

Workflow "Blog → Telegram", trigger: webhook, idempotency field: `id`, variable `telegram_chat_id` from env.

Step 1 `announce_photo`, driver `telegram.send_photo`, run_if `{{trigger.body.cover_image}}`
  chat_id:    "{{vars.telegram_chat_id}}"
  photo:      "{{trigger.body.cover_image}}"
  parse_mode: "HTML"
  caption:    "<b>{{trigger.body.title | escape_html}}</b>\n\n{{trigger.body.excerpt | strip_html | truncate:700 | escape_html}}\n\n<a href=\"{{trigger.body.url | escape_html}}\">Read more →</a>"

Step 2 `announce_text`, driver `telegram.send_message`, run_if `{{trigger.body.cover_image | not}}`
  chat_id:    "{{vars.telegram_chat_id}}"
  parse_mode: "HTML"
  text:       same template as the caption above
  link_preview_options: { "is_disabled": false }

Filter order matters: truncate BEFORE escape_html so an HTML entity is never cut in half.
</sample_workflow>

<deliverable_structure>
Deliver exactly six sections, in order. Each starts with a level-2 heading "Section N — Title", then ≤ 10 "Design decisions" bullets (decision + one-line why), then the complete files.

Section 1 — System Architecture & Visual Dataflow
- The refined latency budget table and a one-paragraph delivery-semantics statement.
- The complete repository directory tree. Annotate every entry with the section that delivers it; every listed file must be delivered.
- Execution topology: an ASCII diagram of processes, ports, Redis streams/keys, and PostgreSQL; a Mermaid `sequenceDiagram` of the happy path with T0 / T_ack / T_dispatch / T_resp marked; a second Mermaid diagram of the failure paths (retry sorted set, XAUTOCLAIM, dead-letter stream).
- A table of every Redis key, stream, and consumer group: name pattern, type, producer, consumer, TTL or trim policy.
- Scaling model: what scales horizontally (gateway and worker replicas), the first bottleneck at 5× TARGET_THROUGHPUT, and how to shard when needed (e.g., N streams partitioned by workflow-id hash).

Section 2 — PostgreSQL Database Schema
- Numbered SQL migration files with up and down scripts. Minimum tables: `users`, `credentials`, `workflows`, `workflow_steps`, `executions`, `execution_step_logs`. Add others you can justify (e.g., `workflow_vars`).
- IDs are UUIDv7; timestamps are `timestamptz`; statuses and driver names use enums or CHECK constraints.
- `credentials` stores ciphertext, nonce, and key_version, never plaintext. `workflows` stores `webhook_token_hash` (SHA-256), an optional encrypted HMAC secret, and a monotonically increasing `version`; `executions` records which version ran.
- `executions` and `execution_step_logs` are declaratively range-partitioned by time (daily or monthly; justify). Include functions to pre-create future partitions and drop expired ones. Primary keys on partitioned tables must include the partition key; handle this explicitly.
- Keep the log tables append-only and COPY-friendly (e.g., one `executions` row at terminal state carrying all timestamps, one `execution_step_logs` row per step attempt). The gateway never writes to PostgreSQL.
- Indexes justified by concrete queries you list: "last 50 executions for workflow X", "failed executions in the last hour", "all active workflows with their steps" (cache load).
- Triggers that `pg_notify` on workflow/step/credential/variable changes with a compact payload (workflow_id + version).
- A low-privilege log-writer role with `synchronous_commit = off` and a read-only role for cache loading.
- A seed command (not raw SQL containing a plaintext token) that reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env, encrypts the token, generates the webhook token, inserts the demo user/workflow/steps/vars, and prints the webhook URL and a ready-to-run curl command using <sample_trigger_payload>.

Section 3 — Ingestion Gateway Code (sub-10 ms response)
- Routes: `POST /v1/hooks/{webhook_token}`, `GET /healthz` (liveness), `GET /readyz` (Redis reachable AND workflow snapshot loaded), `GET /metrics`.
- Token lookup: SHA-256 the incoming token and do an O(1) lookup in the in-memory snapshot. Optional per-workflow HMAC-SHA256 signature verification: configurable header, constant-time compare, optional timestamp header with a tolerance window to block replays.
- Enforce MAX_WEBHOOK_BODY, content type, JSON well-formedness without building an object tree, and a per-token in-memory token-bucket rate limit.
- The single-round-trip Lua script (idempotency + XADD). Message fields: execution_id (UUIDv7), workflow_id, workflow_version, received_at_ns, idempotency key, raw body, whitelisted headers, raw query string.
- Responses: 202 `{ "execution_id": "..." }` with a `Server-Timing` header; 200 for idempotent duplicates; 401 / 404 / 413 / 415 / 429 / 503 with one consistent JSON error shape.
- The shared workflow-snapshot cache package used by both gateway and worker: initial load, LISTEN/NOTIFY with automatic reconnect, periodic resync, atomic swap, template pre-compilation and credential decryption at load time.
- Server tuning: read-header / read / write / idle timeouts, max header bytes, keep-alive, runtime tuning (Go: GOMAXPROCS, GOGC / GOMEMLIMIT rationale; Node: replica-per-core strategy, pino with an async destination, Fastify schema compilation), graceful shutdown.
- State the expected p50 and p99 ACK latency at TARGET_THROUGHPUT and why.

Section 4 — Template Mapper Code
- Syntax: `{{ path }}` and `{{ path | filter | filter:arg }}`, whitespace-tolerant. Paths support dot keys, `[0]` indexes, and `["quoted key"]`. `\{{` escapes a literal.
- Roots: `trigger.body`, `trigger.headers`, `trigger.query`, `trigger.received_at`, `steps.<step_key>.output`, `vars.<name>`, `execution.id`, `workflow.id`. No environment access, no code execution, no arbitrary function calls.
- Two phases. Compile runs at snapshot load; syntax, unknown-filter, and arity errors surface there, never at render time. Render is single-pass with a pre-sized buffer, no regex, and no reflection on the hot path. You may use lazy path extraction on raw JSON (e.g., gjson in Go) instead of a full decode if your benchmark justifies it.
- Templates apply recursively across a step's JSON config tree. Type preservation: if a JSON string value is exactly one expression, emit the resolved value with its original JSON type (number, bool, object, array); otherwise stringify.
- Filters: `default:"x"`, `escape_html`, `escape_markdown_v2`, `strip_html`, `truncate:N` (rune-safe, appends "…"), `trim`, `upper`, `lower`, `json`, `url_encode`, `join:", "`, `not`. The filter registry is extensible.
- `run_if`: truthiness of a single expression. Define truthiness precisely (empty string, null, missing, false, 0, empty array/object).
- Missing paths are lenient by default (empty string + a warning metric). `strict: true` on a step turns them into a permanent, non-retryable error.
- Hardening: max template length, max output size, max path depth. In Node, reject `__proto__` / `constructor` / `prototype` segments and use own-property checks.
- Table-driven unit tests (escapes, unicode, nested arrays, missing keys, type preservation, every filter, filter chaining order) and benchmarks with stated targets (e.g., < 2 µs and near-zero allocations for a 5-expression template), plus the command to run them.

Section 5 — Queue Worker & Telegram Driver Code
- Fetcher → bounded channel → fixed-size worker pool. Pool size and batch size come from env, with a sizing rationale (I/O-bound work, Telegram rate limits). In Node, "worker pool" means N concurrent async executors per process (a semaphore) × M processes; do not use worker_threads for I/O-bound work unless you justify it.
- Execution pipeline: decode once, build the context, evaluate `run_if`, render, and execute steps sequentially. Each step's output is available to later steps, and each step has its own timeout (context deadline / AbortSignal).
- Driver interface + registry with `telegram.send_message`, `telegram.send_photo`, and a generic `http.request` driver (method, url, headers, body, expected status codes), so the engine is not Telegram-only.
- Telegram driver per <telegram_facts>: request construction, response-envelope parsing, error classification, rate limiting, migrate_to_chat_id handling, token redaction.
- HTTP client: one tuned, pooled client per upstream host. Go: `http.Transport` with explicit MaxIdleConns, MaxIdleConnsPerHost, MaxConnsPerHost, IdleConnTimeout, TLSHandshakeTimeout, and ForceAttemptHTTP2 (HTTP/2 when negotiated via ALPN, otherwise an HTTP/1.1 keep-alive pool). Node: an `undici` Pool/Agent with explicit connections, keepAliveTimeout, and connect timeout. Pre-warm N connections at startup, keep them warm with periodic lightweight probes at an interval below the upstream idle timeout, and cache DNS.
- Retry policy: exponential backoff with full jitter; per-step max attempts and cap from the step's `retry_policy`; 429 honors retry_after. Retry state (attempt, completed steps) travels with the message.
- The retry scheduler (atomic Lua), the XAUTOCLAIM reclaimer, and dead-letter handling per <queue_rules>.
- Execution-log sink: bounded buffer → batched COPY (or multi-row INSERT) every X ms or N rows, whichever comes first; drop counter on overflow; flush on shutdown.
- Metrics: E2E / ACK / Telegram-RTT histograms, consumer-group lag and pending count, retries, dead-letter count, dropped log entries, rate-limit waits, connection-pool stats.
- A mock Telegram server in the same stack that mimics the response envelope, injects latency / 429 / 5xx / 400 by configuration, and records arrival timestamps for benchmarking.
- Tests: driver error classification against the mock, backoff math, and step-level resume (a failure in step 2 must not re-send step 1).

Section 6 — Infrastructure & Performance Configuration
- `docker-compose.yml`: postgres, redis, migrate (one-shot), seed (one-shot), gateway, worker (scalable with `--scale`), mock-telegram and a load generator (profile `bench`), prometheus + grafana with a provisioned latency dashboard (profile `observability`). Include healthchecks, `depends_on` with `condition: service_healthy`, restart policies, CPU and memory limits, `ulimits.nofile`, and namespaced `sysctls` (e.g., `net.core.somaxconn`).
- Multi-stage Dockerfile(s) producing a small, non-root runtime image with pinned base versions.
- `redis.conf` with every tuning line commented: AOF with `appendfsync everysec` (state the durability trade-off), `maxmemory` + `maxmemory-policy noeviction` (why eviction must never touch streams), lazyfree settings, `latency-monitor-threshold`, slowlog, io-threads, tcp-keepalive, and RDB snapshots disabled or justified. Host prerequisites: transparent huge pages disabled, `vm.overcommit_memory=1`.
- PostgreSQL configuration for TARGET_HOST (shared_buffers, effective_cache_size, WAL settings, random_page_cost for SSD, max_connections sized to the connection pools), each value justified.
- `.env.example` listing EVERY environment variable used anywhere in the code, plus a table: name, default, used by, description. Names must match the code exactly.
- `Makefile` (or `justfile`) targets: up, down, migrate, seed, test, bench, load-test, logs.
- Load test (k6 or vegeta): ramp to TARGET_THROUGHPUT, then the burst profile, against the mock Telegram. Pass/fail thresholds encode LATENCY_SLO_ACK and LATENCY_SLO_E2E (E2E read from the mock's recorded timestamps or from Prometheus).
- A short Performance Runbook: how to reproduce the benchmark, how to read the dashboard, and the top 5 knobs to turn if p99 regresses, each paired with the symptom it fixes.
- A short Production Hardening list: TLS termination in front of the gateway, credential key rotation, backups, and what changes in a multi-host deployment (Redis Sentinel/Cluster, network_mode trade-offs).
</deliverable_structure>

<quality_bar>
- Complete, runnable code only. No placeholders, ellipses, "rest of implementation", "similar to above", or TODOs. If something is deliberately out of scope, say so in one line instead of stubbing it.
- Show every file in full, in its own fenced code block with a language tag. The first line of each file is a comment with its repository path.
- Pin dependency versions. Prefer the standard library and a small number of well-maintained dependencies; justify each non-trivial dependency in one line.
- One source of truth: stream names, Redis keys, env var names, metric names, and error codes are defined once and imported everywhere.
- Comments explain WHY on performance- and correctness-critical lines (e.g., why a buffer is pre-sized, why the ACK waits for XADD). Do not narrate the obvious.
- Errors are wrapped with context, classified as retryable or permanent, and never swallowed.
- Structured JSON logs carry execution_id and workflow_id on every line; secrets are redacted.
- Code is consistent across sections: every type, function, and path referenced in Section 5 exists as defined in Sections 2–4.
- Do not invent APIs. If you are unsure whether a library function or a Telegram field exists, use a construct you are certain of.
- Out of scope: web UI, sign-up/login flows, billing, non-webhook triggers. `users` exists for ownership and tenancy boundaries only.
</quality_bar>

<output_protocol>
- Reason through the latency budget, the failure modes, and cross-section consistency before writing. Output only the final deliverable, not scratch reasoning.
- This deliverable is larger than one response. When you approach your output limit, finish the current file completely (never split a file), then end with exactly one line: `⏸ CONTINUE → Section N, next file: <path>`. When I reply "continue", resume exactly there without repeating or summarizing earlier content.
- Do not ask clarifying questions. Where something is ambiguous, pick the option that best serves the latency SLO and reliability, and record it as a design decision.
</output_protocol>

<final_self_check>
After Section 6, append an "Acceptance Matrix" table that maps each requirement below to the file(s) and mechanism that satisfy it, marked PASS or with a stated limitation:
1. p99 trigger → dispatch ≤ 30 ms (how it is measured, and how the load test enforces it)
2. p99 ingest ACK ≤ 10 ms
3. Event-driven, non-blocking ingestion gateway
4. In-memory queueing tier on top of durable Redis Streams
5. Asynchronous worker pool with bounded concurrency
6. Connection pooling and pre-warmed TLS connections to Telegram
7. `{{trigger.body.title}}`-style dynamic mapping with pre-compiled templates
8. Retries with backoff + jitter, 429 retry_after, dead-letter stream, crash recovery
9. Effectively-once Telegram delivery (idempotency + step-level resume)
10. No PostgreSQL access on the hot path
11. No secrets in logs, errors, or traces
12. From a clean clone to a real Telegram post in ≤ 5 commands (list them)
Then list known limitations and trade-offs honestly.
</final_self_check>

Begin with Section 1.
````
