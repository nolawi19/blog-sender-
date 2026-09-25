// k6 load test for the webhook gateway (constant arrival rate, stepped).
//
//   docker compose --profile bench run --rm k6            (inside the compose network)
//   k6 run -e WEBHOOK_URL=http://localhost:3000/webhooks/blog -e WEBHOOK_TOKEN=... bench/k6-webhook.js
//
// Env: WEBHOOK_URL, WEBHOOK_TOKEN, RATES (default "100,500,1000,5000"), STAGE_SECONDS (default 20)
// k6 reports client-side p50/p95/p99/p99.9; pipeline latency comes from GET /metrics/latency
// on the gateway (:3000) and worker (:9464).
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';

const url = __ENV.WEBHOOK_URL || 'http://gateway:3000/webhooks/blog';
const token = __ENV.WEBHOOK_TOKEN;
const rates = (__ENV.RATES || '100,500,1000,5000').split(',').map(Number);
const stageSeconds = Number(__ENV.STAGE_SECONDS || 20);

const scenarios = {};
rates.forEach((rate, i) => {
  scenarios[`rate_${rate}`] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: `${stageSeconds}s`,
    startTime: `${i * (stageSeconds + 5)}s`,
    preAllocatedVUs: Math.min(Math.max(rate / 10, 10), 500),
    maxVUs: Math.max(rate, 50),
    tags: { target_rate: String(rate) },
  };
});

export const options = {
  scenarios,
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
  thresholds: {
    // Engineering targets for the acknowledgment, not guarantees; tune per host.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{target_rate:100}': ['p(99)<10'],
  },
};

export default function () {
  if (!token) throw new Error('WEBHOOK_TOKEN is required');
  const n = exec.scenario.iterationInTest;
  const body = JSON.stringify({
    id: `k6-${exec.scenario.name}-${n}-${Date.now()}`,
    type: 'post.published',
    title: `k6 post ${n}`,
    image: `https://example.com/k6/${n}.jpg`,
    telegram_chat_id: String(100000 + (n % 1000)),
  });
  const res = http.post(url, body, { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
  check(res, { accepted: (r) => r.status === 202 });
}
