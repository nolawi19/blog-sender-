/**
 * Load test: drives the gateway at fixed request rates and reports client-side
 * latency plus server-side pipeline latency, CPU and memory scraped from the
 * gateway and worker /metrics endpoints.
 *
 *   npm run bench:load -- --token <webhook token> [--rates 100,500,1000,5000]
 *        [--duration 20] [--connections 64] [--mode open|max]
 *        [--url http://localhost:3000/webhooks/blog]
 *        [--gateway http://localhost:3000] [--worker http://localhost:9464[,http://localhost:9465]]
 *        [--chats 1000]
 *
 * Modes:
 *  - open (default): open-loop constant arrival rate. Request i is scheduled at
 *    t0 + i/rate and its latency is measured from that scheduled time, so a
 *    slow server cannot hide latency by slowing the generator down
 *    (coordinated omission). Percentiles are exact, from every sample.
 *  - max: closed-loop autocannon with N connections, to find maximum throughput.
 *    (autocannon's per-connection rate limiting sends synchronized bursts, so it
 *    is not used for latency percentiles at a target rate.)
 *
 * Point the worker at the mock Telegram API (npm run mock:telegram) and raise the
 * client-side Telegram limits, otherwise you are benchmarking Telegram's rate
 * limits instead of the engine. See README "Benchmarking".
 *
 * Server-side percentiles come from Prometheus histogram deltas for each stage
 * (linear interpolation inside buckets, like PromQL histogram_quantile).
 * Nothing here is simulated: every number printed is measured during the run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import autocannon from 'autocannon';
import { Pool } from 'undici';

interface Args {
  mode: 'open' | 'max';
  url: string;
  token: string;
  rates: number[];
  duration: number;
  connections: number;
  gateway: string;
  worker: string;
  chats: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback?: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 ? argv[idx + 1] : fallback;
  };
  const token = get('token', process.env['WEBHOOK_TOKEN']);
  if (!token) {
    process.stderr.write('missing --token (or WEBHOOK_TOKEN env)\n');
    process.exit(2);
  }
  const mode = get('mode', 'open');
  if (mode !== 'open' && mode !== 'max') {
    process.stderr.write('--mode must be "open" or "max"\n');
    process.exit(2);
  }
  return {
    mode,
    url: get('url', 'http://localhost:3000/webhooks/blog') as string,
    token,
    rates: (get('rates', '100,500,1000,5000') as string).split(',').map(Number),
    duration: Number(get('duration', '20')),
    connections: Number(get('connections', '64')),
    gateway: get('gateway', 'http://localhost:3000') as string,
    worker: get('worker', 'http://localhost:9464') as string,
    chats: Number(get('chats', '1000')),
  };
}

type Samples = Map<string, number>;

/** Scrapes one or more comma-separated base URLs and sums identical series (e.g. several workers). */
async function scrape(bases: string): Promise<Samples> {
  const samples: Samples = new Map();
  for (const base of bases.split(',')) await scrapeInto(base.trim(), samples);
  return samples;
}

async function scrapeInto(base: string, samples: Samples): Promise<void> {
  const text = await (await fetch(`${base}/metrics`)).text();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    const key = line.slice(0, space);
    const value = Number(line.slice(space + 1));
    // Sum series that differ only by the "action" label.
    const normalized = key.replace(/,?action="[^"]*"/, '').replace('{,', '{');
    samples.set(normalized, (samples.get(normalized) ?? 0) + value);
  }
}

function histogramQuantile(before: Samples, after: Samples, metric: string, q: number): number | null {
  const buckets: Array<{ le: number; count: number }> = [];
  const prefix = `${metric}_bucket{`;
  for (const [key, value] of after) {
    if (!key.startsWith(prefix)) continue;
    const le = /le="([^"]+)"/.exec(key)?.[1];
    if (!le) continue;
    buckets.push({ le: le === '+Inf' ? Infinity : Number(le), count: value - (before.get(key) ?? 0) });
  }
  buckets.sort((a, b) => a.le - b.le);
  const total = buckets.at(-1)?.count ?? 0;
  if (total <= 0) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.count >= rank) {
      if (b.le === Infinity) return prevLe;
      const inBucket = b.count - prevCount;
      return inBucket <= 0 ? b.le : prevLe + ((b.le - prevLe) * (rank - prevCount)) / inBucket;
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return null;
}

function delta(before: Samples, after: Samples, key: string): number {
  return (after.get(key) ?? 0) - (before.get(key) ?? 0);
}

async function waitForDrain(workers: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const first = workers.split(',')[0] as string; // every worker reports the same queue
  while (Date.now() < deadline) {
    const s = await scrape(first);
    const pending = (s.get('automation_queue_depth{state="waiting",service="worker"}') ?? 0) + (s.get('automation_queue_depth{state="active",service="worker"}') ?? 0);
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write('  ! queue did not drain within the timeout\n');
}

const fmt = (v: number | null | undefined): string => (v === null || v === undefined || Number.isNaN(v) ? '   n/a' : v.toFixed(2).padStart(7));

interface ClientResult {
  sent: number;
  ok: number;
  errors: number;
  statuses: Record<string, number>;
  achievedRate: number;
  latency: { p50: number; p95: number; p99: number; p999: number; max: number };
}

function payloadFor(args: Args, runId: string, rate: number, n: number): string {
  return JSON.stringify({
    id: `${runId}-${rate}-${n}`,
    type: 'post.published',
    title: `Benchmark post ${n}`,
    image: `https://example.com/bench/${n}.jpg`,
    telegram_chat_id: String(100000 + (n % args.chats)),
  });
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

/** Open-loop constant-arrival generator; latency is measured from each request's scheduled time. */
async function openLoop(args: Args, rate: number, runId: string): Promise<ClientResult> {
  const target = new URL(args.url);
  const pool = new Pool(target.origin, { connections: args.connections, pipelining: 1, keepAliveTimeout: 60_000 });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${args.token}` };
  const total = Math.max(1, Math.round(rate * args.duration));
  const interval = 1000 / rate;
  const latencies = new Float64Array(total).fill(Number.NaN);
  const statuses: Record<string, number> = {};
  let errors = 0;
  let completed = 0;
  let next = 0;

  // Warm the pool so connection setup is not measured as request latency.
  await Promise.all(Array.from({ length: Math.min(args.connections, 16) }, async () => (await pool.request({ path: '/health', method: 'GET' })).body.dump()));

  const start = performance.now() + 20;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      while (next < total && start + next * interval <= now) {
        const n = next++;
        const scheduled = start + n * interval;
        pool
          .request({ path: target.pathname, method: 'POST', headers, body: payloadFor(args, runId, rate, n) })
          .then(async (res) => {
            await res.body.dump();
            latencies[n] = performance.now() - scheduled;
            statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
          })
          .catch(() => {
            errors++;
          })
          .finally(() => {
            if (++completed === total) resolve();
          });
      }
      if (next < total) setTimeout(tick, Math.max(0, start + next * interval - performance.now()));
    };
    tick();
  });
  const elapsed = (performance.now() - start) / 1000;
  await pool.close();

  const measured = latencies.filter((v) => !Number.isNaN(v)).sort();
  return {
    sent: total,
    ok: (statuses['202'] ?? 0) + (statuses['200'] ?? 0),
    errors,
    statuses,
    achievedRate: total / elapsed,
    latency: {
      p50: percentile(measured, 0.5),
      p95: percentile(measured, 0.95),
      p99: percentile(measured, 0.99),
      p999: percentile(measured, 0.999),
      max: measured.length ? (measured[measured.length - 1] as number) : Number.NaN,
    },
  };
}

/** Closed-loop maximum-throughput run with autocannon. */
async function maxThroughput(args: Args, runId: string): Promise<ClientResult> {
  let counter = 0;
  const result = await autocannon({
    url: args.url,
    method: 'POST',
    connections: args.connections,
    duration: args.duration,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.token}` },
    requests: [{ setupRequest: (req) => ({ ...req, body: payloadFor(args, runId, 0, counter++) }) }],
  });
  const statuses: Record<string, number> = {};
  for (const [code, v] of Object.entries(result.statusCodeStats ?? {})) statuses[code] = (v as { count: number }).count;
  return {
    sent: result.requests.total,
    ok: result['2xx'],
    errors: result.errors + result.timeouts,
    statuses,
    achievedRate: result.requests.average,
    latency: { p50: result.latency.p50, p95: Number.NaN, p99: result.latency.p99, p999: result.latency.p99_9, max: result.latency.max },
  };
}

interface StageReport {
  mode: string;
  targetRate: number | null;
  client: ClientResult;
  server: Record<string, { p50: number | null; p95: number | null; p99: number | null; p999: number | null; samples: number }>;
  resources: Record<string, { cpuPercentOfOneCore: number; rssMb: number }>;
}

async function runStage(args: Args, rate: number | null, runId: string): Promise<StageReport> {
  const [g0, w0] = await Promise.all([scrape(args.gateway), scrape(args.worker)]);
  const started = Date.now();
  const client = rate === null ? await maxThroughput(args, runId) : await openLoop(args, rate, runId);
  const wallSec = (Date.now() - started) / 1000;
  await waitForDrain(args.worker);
  const [g1, w1] = await Promise.all([scrape(args.gateway), scrape(args.worker)]);

  const label = rate === null ? `max throughput, ${args.connections} connections` : `target ${rate} req/s`;
  const statusText = Object.entries(client.statuses)
    .map(([code, count]) => `${code}:${count}`)
    .join(' ');
  process.stdout.write(`\n=== ${label}, ${args.duration}s ===\n`);
  process.stdout.write(`throughput: ${client.achievedRate.toFixed(0)} req/s, ${client.sent} requests, errors ${client.errors}  [${statusText}]\n`);
  process.stdout.write(
    `client latency ms: p50 ${fmt(client.latency.p50)} p95 ${fmt(client.latency.p95)} p99 ${fmt(client.latency.p99)} p99.9 ${fmt(client.latency.p999)} max ${fmt(client.latency.max)}\n`,
  );

  const rows: Array<[string, Samples, Samples, string, string]> = [
    ['webhook ack (gateway)', g0, g1, 'automation_webhook_ack_latency_ms', 'gateway'],
    ['enqueue (gateway)', g0, g1, 'automation_webhook_enqueue_latency_ms', 'gateway'],
    ['queue wait', w0, w1, 'automation_queue_latency_ms', 'worker'],
    ['worker pre-dispatch', w0, w1, 'automation_worker_pre_dispatch_latency_ms', 'worker'],
    ['template render', w0, w1, 'automation_template_render_latency_ms', 'worker'],
    ['receipt -> request start', w0, w1, 'automation_outbound_request_start_latency_ms', 'worker'],
    ['external API (mock)', w0, w1, 'automation_external_api_latency_ms', 'worker'],
    ['total execution', w0, w1, 'automation_total_execution_latency_ms', 'worker'],
  ];
  const server: StageReport['server'] = {};
  process.stdout.write('server latency ms (histogram)      p50     p95     p99   p99.9   samples\n');
  for (const [name, before, after, metric, service] of rows) {
    const samples = delta(before, after, `${metric}_count{service="${service}"}`);
    const q = (p: number) => histogramQuantile(before, after, metric, p);
    server[name] = { p50: q(0.5), p95: q(0.95), p99: q(0.99), p999: q(0.999), samples };
    process.stdout.write(`  ${name.padEnd(28)} ${fmt(q(0.5))} ${fmt(q(0.95))} ${fmt(q(0.99))} ${fmt(q(0.999))} ${String(samples).padStart(9)}\n`);
  }

  const resources: StageReport['resources'] = {};
  for (const [name, before, after] of [
    ['gateway', g0, g1],
    ['worker', w0, w1],
  ] as const) {
    const service = `{service="${name}"}`;
    const cpuPercentOfOneCore = (delta(before, after, `process_cpu_seconds_total${service}`) / wallSec) * 100;
    const rssMb = (after.get(`process_resident_memory_bytes${service}`) ?? 0) / 1024 / 1024;
    resources[name] = { cpuPercentOfOneCore, rssMb };
    const processes = (name === 'worker' ? args.worker : args.gateway).split(',').length;
    process.stdout.write(
      `  ${name.padEnd(8)} CPU ${cpuPercentOfOneCore.toFixed(0).padStart(4)}% of one core   RSS ${rssMb.toFixed(0)} MB${processes > 1 ? `   (sum of ${processes} processes)` : ''}\n`,
    );
  }
  let deadLetters = 0;
  for (const [key, value] of w1) if (key.startsWith('automation_dead_letter_jobs_total')) deadLetters += value - (w0.get(key) ?? 0);
  if (deadLetters > 0) process.stdout.write(`  ! ${deadLetters} dead-lettered jobs during this stage\n`);
  return { mode: args.mode, targetRate: rate, client, server, resources };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = `bench-${Date.now()}`;
  process.stdout.write(
    `load test ${runId}: ${args.url}, mode ${args.mode}, ${args.mode === 'open' ? `rates ${args.rates.join(', ')} req/s, ` : ''}${args.duration}s per stage, ${args.connections} connections\n`,
  );
  const reports: StageReport[] = [];
  if (args.mode === 'max') reports.push(await runStage(args, null, runId));
  else for (const rate of args.rates) reports.push(await runStage(args, rate, runId));
  await mkdir('bench/results', { recursive: true });
  await writeFile(`bench/results/${runId}.json`, JSON.stringify({ runId, args: { ...args, token: undefined }, reports }, null, 2));
  process.stdout.write(`\nresults written to bench/results/${runId}.json\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`load test failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
