import { Counter, Gauge, Histogram, Registry, Summary, collectDefaultMetrics } from '@prometheus-io/client';

/** Latency buckets in milliseconds, dense below 30 ms where the targets live. */
const LATENCY_BUCKETS_MS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30, 40, 50, 75, 100, 250, 500, 1000, 2500, 5000, 10000,
  30000, 60000,
];
const PERCENTILES = [0.5, 0.95, 0.99, 0.999];
const QUANTILE_LABELS: Record<string, string> = { '0.5': 'p50', '0.95': 'p95', '0.99': 'p99', '0.999': 'p99.9' };

export type LatencyName =
  | 'webhook_ack'
  | 'webhook_enqueue'
  | 'queue'
  | 'worker_pre_dispatch'
  | 'template_render'
  | 'outbound_request_start'
  | 'external_api'
  | 'execution_duration'
  | 'total_execution';

const LATENCY_HELP: Record<LatencyName, string> = {
  webhook_ack: 'Webhook receipt to acceptance response (gateway)',
  webhook_enqueue: 'Time spent enqueuing jobs into Redis/BullMQ (gateway)',
  queue: 'Enqueue call to worker pickup',
  worker_pre_dispatch: 'Worker pickup to first outbound request start',
  template_render: 'Rendering one step configuration',
  outbound_request_start: 'Webhook receipt to outbound request initiation (the 30 ms target)',
  external_api: 'Outbound request start to response received (third-party latency)',
  execution_duration: 'Worker pickup to job completion',
  total_execution: 'Webhook receipt to job completion',
};

export interface LatencyRecorder {
  observe(name: LatencyName, valueMs: number, labels?: Record<string, string>): void;
}

export interface QueueDepthSource {
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export class Metrics implements LatencyRecorder {
  readonly registry = new Registry();
  private readonly histograms = new Map<LatencyName, Histogram<string>>();
  private readonly summaries = new Map<LatencyName, Summary<string>>();

  readonly webhookRequests: Counter<'outcome'>;
  readonly jobsProcessed: Counter<'status'>;
  readonly jobRetries: Counter<'category'>;
  readonly jobFailures: Counter<'category'>;
  readonly deadLetters: Counter<'category'>;
  readonly outboundRequests: Counter<'action' | 'outcome'>;
  readonly recorderDropped: Counter<'kind'>;
  readonly idempotencyDuplicates: Counter<string>;
  readonly queueDepth: Gauge<'state'>;

  constructor(options: { service: string; defaultMetrics?: boolean; queue?: QueueDepthSource }) {
    this.registry.setDefaultLabels({ service: options.service });
    if (options.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry });

    for (const name of Object.keys(LATENCY_HELP) as LatencyName[]) {
      this.histograms.set(
        name,
        new Histogram({
          name: `automation_${name}_latency_ms`,
          help: `${LATENCY_HELP[name]} (histogram, ms)`,
          labelNames: ['action'],
          buckets: LATENCY_BUCKETS_MS,
          registers: [this.registry],
        }),
      );
      this.summaries.set(
        name,
        new Summary({
          name: `automation_${name}_latency_ms_quantiles`,
          help: `${LATENCY_HELP[name]} (sliding 60s window, ms)`,
          percentiles: PERCENTILES,
          maxAgeSeconds: 60,
          ageBuckets: 3,
          registers: [this.registry],
        }),
      );
    }

    this.webhookRequests = new Counter({
      name: 'automation_webhook_requests_total',
      help: 'Webhook requests by outcome',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.jobsProcessed = new Counter({
      name: 'automation_jobs_processed_total',
      help: 'Jobs processed by final status of the attempt',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.jobRetries = new Counter({
      name: 'automation_job_retries_total',
      help: 'Attempts that failed and were scheduled for retry',
      labelNames: ['category'],
      registers: [this.registry],
    });
    this.jobFailures = new Counter({
      name: 'automation_job_failures_total',
      help: 'Failed attempts by error category',
      labelNames: ['category'],
      registers: [this.registry],
    });
    this.deadLetters = new Counter({
      name: 'automation_dead_letter_jobs_total',
      help: 'Jobs moved to the dead-letter store',
      labelNames: ['category'],
      registers: [this.registry],
    });
    this.outboundRequests = new Counter({
      name: 'automation_outbound_requests_total',
      help: 'Outbound integration calls by action and outcome',
      labelNames: ['action', 'outcome'],
      registers: [this.registry],
    });
    this.recorderDropped = new Counter({
      name: 'automation_recorder_dropped_total',
      help: 'Execution records dropped because the async buffer was full or the DB was unavailable',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.idempotencyDuplicates = new Counter({
      name: 'automation_idempotency_duplicates_total',
      help: 'Webhook deliveries rejected as duplicates',
      registers: [this.registry],
    });

    const queue = options.queue;
    this.queueDepth = new Gauge({
      name: 'automation_queue_depth',
      help: 'BullMQ job counts by state',
      labelNames: ['state'],
      registers: [this.registry],
      async collect() {
        if (!queue) return;
        try {
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'prioritized');
          for (const [state, count] of Object.entries(counts)) this.set({ state }, count);
        } catch {
          // Scrapes must not fail because Redis is briefly unavailable.
        }
      },
    });
  }

  observe(name: LatencyName, valueMs: number, labels?: Record<string, string>): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const action = labels?.['action'] ?? 'all';
    this.histograms.get(name)?.observe({ action }, valueMs);
    this.summaries.get(name)?.observe(valueMs);
  }

  async prometheus(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Human-readable p50/p95/p99/p99.9 snapshot of every latency metric (60 s window). */
  async latencySnapshot(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [name, summary] of this.summaries) {
      const data = await summary.get();
      const entry: Record<string, number> = {};
      for (const v of data.values) {
        const q = (v.labels as Record<string, string | number> | undefined)?.['quantile'];
        if (q !== undefined) entry[QUANTILE_LABELS[String(q)] ?? `q${q}`] = Math.round(v.value * 1000) / 1000;
        else if (v.metricName?.endsWith('_count')) entry['count'] = v.value;
        else if (v.metricName?.endsWith('_sum')) entry['sum'] = Math.round(v.value * 1000) / 1000;
      }
      if ((entry['count'] ?? 0) > 0) out[name] = entry;
    }
    return out;
  }
}
