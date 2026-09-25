import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { TokenBucketLimiter } from '../lib/rate-limiter.js';
import { compileTemplate, compileValue } from '../mapper/template-mapper.js';
import type { Logger } from '../observability/logger.js';
import { CACHE_INVALIDATION_CHANNEL } from '../queue/automation.queue.js';
import { credentialSchemas, isKnownProvider, type CredentialCipher, type DecryptedCredential } from '../security/credentials.js';
import type { RuntimeEndpoint, RuntimeStep, RuntimeWorkflow, WebhookAuthType } from '../types/workflow.js';

// ---------------------------------------------------------------------------
// Persistence-facing row shapes (what the repository returns)
// ---------------------------------------------------------------------------

export interface EndpointRow {
  id: string;
  slug: string;
  userId: string;
  source: string;
  authType: WebhookAuthType;
  tokenHash: string | null;
  hmacSecretEncrypted: string | null;
  defaultEventType: string | null;
  idempotencyField: string | null;
  dedupeByPayloadHash: boolean;
  isActive: boolean;
}

export interface StepRow {
  id: string;
  key: string;
  position: number;
  type: string;
  config: unknown;
  runIf: string | null;
  timeoutMs: number | null;
  credential: { id: string; name: string; provider: string; encryptedData: string } | null;
}

export interface WorkflowRow {
  id: string;
  name: string;
  userId: string;
  endpointId: string;
  triggerEvent: string;
  version: number;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  steps: StepRow[];
}

export interface WorkflowRepository {
  loadAll(): Promise<{ endpoints: EndpointRow[]; workflows: WorkflowRow[] }>;
  loadEndpointBySlug(slug: string): Promise<{ endpoint: EndpointRow; workflows: WorkflowRow[] } | null>;
  loadWorkflow(id: string): Promise<WorkflowRow | null>;
}

const workflowInclude = {
  steps: {
    orderBy: { position: 'asc' as const },
    include: { credential: { select: { id: true, name: true, provider: true, encryptedData: true } } },
  },
};

export class PrismaWorkflowRepository implements WorkflowRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async loadAll(): Promise<{ endpoints: EndpointRow[]; workflows: WorkflowRow[] }> {
    const [endpoints, workflows] = await Promise.all([
      this.prisma.webhookEndpoint.findMany({ where: { isActive: true } }),
      this.prisma.workflow.findMany({
        where: { status: 'ACTIVE', endpoint: { isActive: true } },
        include: workflowInclude,
      }),
    ]);
    return { endpoints, workflows };
  }

  async loadEndpointBySlug(slug: string): Promise<{ endpoint: EndpointRow; workflows: WorkflowRow[] } | null> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { slug },
      include: { workflows: { where: { status: 'ACTIVE' }, include: workflowInclude } },
    });
    if (!endpoint || !endpoint.isActive) return null;
    const { workflows, ...row } = endpoint;
    return { endpoint: row, workflows };
  }

  async loadWorkflow(id: string): Promise<WorkflowRow | null> {
    return this.prisma.workflow.findUnique({ where: { id }, include: workflowInclude });
  }
}

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

/** What the gateway needs: synchronous lookups on the hot path. */
export interface EndpointRegistry {
  getEndpoint(slug: string): RuntimeEndpoint | undefined;
  /** Cache miss path: one indexed DB query, with negative caching. */
  resolveEndpoint(slug: string): Promise<RuntimeEndpoint | undefined>;
  workflowsFor(endpointId: string, eventType: string): readonly RuntimeWorkflow[];
  isReady(): boolean;
}

/** What the worker needs. */
export interface WorkflowSource {
  resolveWorkflow(id: string, minVersion: number): Promise<RuntimeWorkflow | undefined>;
}

interface Snapshot {
  endpoints: Map<string, RuntimeEndpoint>;
  workflows: Map<string, RuntimeWorkflow>;
  /** endpointId -> eventType (or "*") -> workflows */
  routes: Map<string, Map<string, RuntimeWorkflow[]>>;
}

const EMPTY: readonly RuntimeWorkflow[] = Object.freeze([]);

export interface WorkflowLoaderOptions {
  repository: WorkflowRepository;
  cipher: CredentialCipher;
  logger: Logger;
  refreshIntervalMs: number;
  /** Workers need decrypted integration credentials; the gateway does not. */
  decryptStepCredentials: boolean;
  negativeCacheTtlMs?: number;
  /** Global budget for cache-miss DB lookups, so random slugs cannot flood PostgreSQL. */
  missLookupsPerSec?: number;
}

/**
 * Keeps endpoints and workflows (with pre-compiled templates and decrypted
 * credentials) in an immutable in-memory snapshot. The snapshot is rebuilt on a
 * timer and whenever a message arrives on the cache-invalidation channel, then
 * swapped atomically, so request handling never waits on PostgreSQL.
 */
export class WorkflowLoader implements EndpointRegistry, WorkflowSource {
  private snapshot: Snapshot = { endpoints: new Map(), workflows: new Map(), routes: new Map() };
  private readonly negative = new Map<string, number>();
  private readonly negativeTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ready = false;
  private reloading: Promise<void> | null = null;
  private reloadQueued = false;
  private readonly missLimiter: TokenBucketLimiter;

  constructor(private readonly options: WorkflowLoaderOptions) {
    this.negativeTtlMs = options.negativeCacheTtlMs ?? 5_000;
    const missRate = options.missLookupsPerSec ?? 20;
    this.missLimiter = new TokenBucketLimiter({ ratePerSec: missRate, burst: Math.max(1, Math.ceil(missRate)) });
  }

  async start(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => {
      this.reload().catch((err: unknown) => this.options.logger.error({ err }, 'periodic workflow reload failed'));
    }, this.options.refreshIntervalMs);
    this.timer.unref();
  }

  /** Subscribes to invalidation messages published by admin tooling. */
  async subscribe(subscriber: Redis): Promise<void> {
    await subscriber.subscribe(CACHE_INVALIDATION_CHANNEL);
    subscriber.on('message', (channel: string) => {
      if (channel !== CACHE_INVALIDATION_CHANNEL) return;
      this.reload().catch((err: unknown) => this.options.logger.error({ err }, 'workflow reload after invalidation failed'));
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isReady(): boolean {
    return this.ready;
  }

  get stats(): { endpoints: number; workflows: number } {
    return { endpoints: this.snapshot.endpoints.size, workflows: this.snapshot.workflows.size };
  }

  /** Rebuilds the snapshot. Concurrent calls coalesce into at most one extra run. */
  reload(): Promise<void> {
    if (this.reloading) {
      this.reloadQueued = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      try {
        do {
          this.reloadQueued = false;
          const started = performance.now();
          const { endpoints, workflows } = await this.options.repository.loadAll();
          const next: Snapshot = { endpoints: new Map(), workflows: new Map(), routes: new Map() };
          for (const row of endpoints) {
            const endpoint = this.toRuntimeEndpoint(row);
            if (endpoint) next.endpoints.set(endpoint.slug, endpoint);
          }
          const activeEndpointIds = new Set([...next.endpoints.values()].map((e) => e.id));
          for (const row of workflows) {
            if (!activeEndpointIds.has(row.endpointId)) continue;
            const workflow = this.toRuntimeWorkflow(row);
            if (workflow) addWorkflow(next, workflow);
          }
          this.snapshot = next;
          this.negative.clear();
          this.ready = true;
          this.options.logger.info(
            { endpoints: next.endpoints.size, workflows: next.workflows.size, ms: Math.round(performance.now() - started) },
            'workflow snapshot loaded',
          );
        } while (this.reloadQueued);
      } finally {
        this.reloading = null;
      }
    })();
    return this.reloading;
  }

  getEndpoint(slug: string): RuntimeEndpoint | undefined {
    return this.snapshot.endpoints.get(slug);
  }

  async resolveEndpoint(slug: string): Promise<RuntimeEndpoint | undefined> {
    const hit = this.snapshot.endpoints.get(slug);
    if (hit) return hit;
    const negativeUntil = this.negative.get(slug);
    if (negativeUntil !== undefined && negativeUntil > Date.now()) return undefined;
    // Endpoints normally arrive through the snapshot; the miss path only covers the
    // gap before an invalidation lands, so it gets a small global budget.
    if (!this.missLimiter.reserve('miss', 0).ok) return undefined;

    const loaded = await this.options.repository.loadEndpointBySlug(slug);
    const endpoint = loaded ? this.toRuntimeEndpoint(loaded.endpoint) : null;
    if (!loaded || !endpoint) {
      if (this.negative.size > 10_000) this.negative.clear();
      this.negative.set(slug, Date.now() + this.negativeTtlMs);
      return undefined;
    }
    // Copy-on-write so readers holding the old snapshot are unaffected.
    const next = cloneSnapshot(this.snapshot);
    next.endpoints.set(endpoint.slug, endpoint);
    for (const row of loaded.workflows) {
      const workflow = this.toRuntimeWorkflow(row);
      if (workflow) addWorkflow(next, workflow);
    }
    this.snapshot = next;
    return endpoint;
  }

  workflowsFor(endpointId: string, eventType: string): readonly RuntimeWorkflow[] {
    const byType = this.snapshot.routes.get(endpointId);
    if (!byType) return EMPTY;
    const exact = byType.get(eventType);
    const wildcard = eventType === '*' ? undefined : byType.get('*');
    if (!wildcard) return exact ?? EMPTY;
    if (!exact) return wildcard;
    return [...exact, ...wildcard];
  }

  async resolveWorkflow(id: string, minVersion: number): Promise<RuntimeWorkflow | undefined> {
    const cached = this.snapshot.workflows.get(id);
    if (cached && cached.version >= minVersion) return cached;
    const row = await this.options.repository.loadWorkflow(id);
    if (!row || row.status !== 'ACTIVE') return undefined;
    const workflow = this.toRuntimeWorkflow(row, true);
    if (!workflow) return undefined;
    const next = cloneSnapshot(this.snapshot);
    addWorkflow(next, workflow);
    this.snapshot = next;
    return workflow;
  }

  private toRuntimeEndpoint(row: EndpointRow): RuntimeEndpoint | null {
    try {
      return {
        id: row.id,
        slug: row.slug,
        userId: row.userId,
        source: row.source,
        authType: row.authType,
        tokenHash: row.tokenHash,
        hmacSecret: row.hmacSecretEncrypted ? this.options.cipher.decrypt(row.hmacSecretEncrypted) : null,
        defaultEventType: row.defaultEventType,
        idempotencyPath: row.idempotencyField ? row.idempotencyField.split('.').filter(Boolean) : null,
        dedupeByPayloadHash: row.dedupeByPayloadHash,
      };
    } catch (err) {
      this.options.logger.error({ err, endpointId: row.id }, 'endpoint skipped: cannot decrypt HMAC secret');
      return null;
    }
  }

  /**
   * Compiles templates and decrypts credentials. A workflow that fails either
   * step is logged and excluded, so a bad definition never reaches execution.
   * With `throwOnError` the failure propagates (used by the worker on demand).
   */
  private toRuntimeWorkflow(row: WorkflowRow, throwOnError = false): RuntimeWorkflow | null {
    try {
      const steps: RuntimeStep[] = row.steps.map((step) => ({
        id: step.id,
        key: step.key,
        position: step.position,
        type: step.type,
        config: compileValue(step.config),
        runIf: step.runIf ? compileTemplate(step.runIf) : null,
        credential: this.options.decryptStepCredentials && step.credential ? this.decryptCredential(step.credential) : null,
        timeoutMs: step.timeoutMs,
      }));
      return {
        id: row.id,
        name: row.name,
        userId: row.userId,
        endpointId: row.endpointId,
        triggerEvent: row.triggerEvent,
        version: row.version,
        steps,
      };
    } catch (err) {
      this.options.logger.error({ err, workflowId: row.id }, 'workflow skipped: invalid definition or credential');
      if (throwOnError) throw err;
      return null;
    }
  }

  private decryptCredential(cred: NonNullable<StepRow['credential']>): DecryptedCredential {
    const data = this.options.cipher.decryptJson(cred.encryptedData);
    if (isKnownProvider(cred.provider)) credentialSchemas[cred.provider].parse(data);
    return { id: cred.id, name: cred.name, provider: cred.provider, data };
  }
}

function cloneSnapshot(s: Snapshot): Snapshot {
  const routes = new Map<string, Map<string, RuntimeWorkflow[]>>();
  for (const [endpointId, byType] of s.routes) {
    routes.set(endpointId, new Map([...byType].map(([type, list]) => [type, [...list]])));
  }
  return { endpoints: new Map(s.endpoints), workflows: new Map(s.workflows), routes };
}

function addWorkflow(snapshot: Snapshot, workflow: RuntimeWorkflow): void {
  // Remove any previous version from the routing table first.
  const previous = snapshot.workflows.get(workflow.id);
  if (previous) {
    const list = snapshot.routes.get(previous.endpointId)?.get(previous.triggerEvent);
    if (list) {
      const idx = list.findIndex((w) => w.id === workflow.id);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  snapshot.workflows.set(workflow.id, workflow);
  let byType = snapshot.routes.get(workflow.endpointId);
  if (!byType) {
    byType = new Map();
    snapshot.routes.set(workflow.endpointId, byType);
  }
  const list = byType.get(workflow.triggerEvent);
  if (list) list.push(workflow);
  else byType.set(workflow.triggerEvent, [workflow]);
}

/** Tells every gateway and worker to rebuild its snapshot. */
export async function publishCacheInvalidation(redis: Redis, reason: string): Promise<number> {
  return redis.publish(CACHE_INVALIDATION_CHANNEL, JSON.stringify({ reason, at: new Date().toISOString() }));
}
