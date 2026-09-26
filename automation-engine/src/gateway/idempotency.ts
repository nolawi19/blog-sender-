import type { Redis } from 'ioredis';
import { RedisError } from '../errors.js';

export type ClaimResult = { claimed: true } | { claimed: false; existingEventId: string };

/**
 * Hot-path duplicate detection. `claim` atomically records key -> eventId if the
 * key is new; otherwise it returns the event id of the first delivery.
 */
export interface IdempotencyStore {
  claim(scope: string, key: string, eventId: string, ttlSec: number): Promise<ClaimResult>;
  /** Undo a claim when the event could not be enqueued, so the sender's retry is accepted. */
  release(scope: string, key: string, eventId: string): Promise<void>;
}

// One round trip: SET NX, and on conflict return the stored value.
const CLAIM_SCRIPT = `
local ok = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if ok then return false end
return redis.call('GET', KEYS[1])
`;

// Compare-and-delete so a late release cannot remove someone else's claim.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

type ScriptedRedis = Redis & {
  idemClaim(key: string, eventId: string, ttl: string): Promise<string | null>;
  idemRelease(key: string, eventId: string): Promise<number>;
};

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: ScriptedRedis;

  constructor(redis: Redis, private readonly prefix = 'automation:idem') {
    if (!('idemClaim' in redis)) {
      redis.defineCommand('idemClaim', { numberOfKeys: 1, lua: CLAIM_SCRIPT });
      redis.defineCommand('idemRelease', { numberOfKeys: 1, lua: RELEASE_SCRIPT });
    }
    this.redis = redis as ScriptedRedis;
  }

  private keyFor(scope: string, key: string): string {
    return `${this.prefix}:${scope}:${key}`;
  }

  async claim(scope: string, key: string, eventId: string, ttlSec: number): Promise<ClaimResult> {
    let existing: string | null;
    try {
      existing = await this.redis.idemClaim(this.keyFor(scope, key), eventId, String(ttlSec));
    } catch (err) {
      throw new RedisError('Idempotency check failed', { cause: err });
    }
    return existing === null ? { claimed: true } : { claimed: false, existingEventId: existing };
  }

  async release(scope: string, key: string, eventId: string): Promise<void> {
    try {
      await this.redis.idemRelease(this.keyFor(scope, key), eventId);
    } catch {
      // Best effort: the key expires on its own.
    }
  }

  /** Replaces a fresh claim with the event id of the original delivery. */
  async reseed(scope: string, key: string, eventId: string, ttlSec: number): Promise<void> {
    try {
      await this.redis.set(this.keyFor(scope, key), eventId, 'EX', ttlSec);
    } catch {
      // Best effort: the durable store still knows the key.
    }
  }
}

export type DurableLookup = (scope: string, key: string) => Promise<string | null>;

/**
 * Redis answers the common case (duplicates within IDEMPOTENCY_TTL_SEC) in one
 * round trip. Only when Redis has not seen the key is the durable record in
 * PostgreSQL (idempotency_keys, written by the worker) consulted, so an event
 * processed days ago is still recognised after its Redis key expired, e.g. when
 * a poller or a manual "send existing posts" run re-sends old posts.
 * If the lookup fails or is slow, the event is accepted (availability first).
 */
export class DurableIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly fast: IdempotencyStore & { reseed(scope: string, key: string, eventId: string, ttlSec: number): Promise<void> },
    private readonly lookup: DurableLookup,
    private readonly options: { timeoutMs?: number; onLookupError?: (err: unknown) => void } = {},
  ) {}

  async claim(scope: string, key: string, eventId: string, ttlSec: number): Promise<ClaimResult> {
    const fast = await this.fast.claim(scope, key, eventId, ttlSec);
    if (!fast.claimed) return fast;
    let existing: string | null;
    try {
      existing = await Promise.race([
        this.lookup(scope, key),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('durable idempotency lookup timed out')), this.options.timeoutMs ?? 1_000).unref()),
      ]);
    } catch (err) {
      this.options.onLookupError?.(err);
      return fast;
    }
    if (!existing) return fast;
    await this.fast.reseed(scope, key, existing, ttlSec);
    return { claimed: false, existingEventId: existing };
  }

  release(scope: string, key: string, eventId: string): Promise<void> {
    return this.fast.release(scope, key, eventId);
  }
}

/** In-process store for tests and single-node development. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { eventId: string; expiresAt: number }>();

  async claim(scope: string, key: string, eventId: string, ttlSec: number): Promise<ClaimResult> {
    const k = `${scope}:${key}`;
    const now = Date.now();
    const existing = this.entries.get(k);
    if (existing && existing.expiresAt > now) return { claimed: false, existingEventId: existing.eventId };
    this.entries.set(k, { eventId, expiresAt: now + ttlSec * 1000 });
    return { claimed: true };
  }

  async release(scope: string, key: string, eventId: string): Promise<void> {
    const k = `${scope}:${key}`;
    if (this.entries.get(k)?.eventId === eventId) this.entries.delete(k);
  }

  async reseed(scope: string, key: string, eventId: string, ttlSec: number): Promise<void> {
    this.entries.set(`${scope}:${key}`, { eventId, expiresAt: Date.now() + ttlSec * 1000 });
  }

  /** Test helper: simulates the Redis key expiring. */
  expire(scope: string, key: string): void {
    this.entries.delete(`${scope}:${key}`);
  }
}
