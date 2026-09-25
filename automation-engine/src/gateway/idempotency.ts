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
}
