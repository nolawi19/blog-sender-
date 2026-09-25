export interface TokenBucketOptions {
  /** Tokens added per second. */
  ratePerSec: number;
  /** Bucket capacity (max burst). */
  burst: number;
  /** Upper bound on tracked keys; idle full buckets are evicted beyond this. */
  maxKeys?: number;
  now?: () => number;
}

export type Reservation = { ok: true; waitMs: number } | { ok: false; retryAfterMs: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-process token bucket with reservations. A reservation may drive the bucket
 * negative, which represents callers already queued behind it; `waitMs` tells the
 * caller how long to sleep before sending. If the wait would exceed `maxWaitMs`
 * the reservation is refused (nothing is consumed) so the caller can reschedule
 * the work instead of holding a worker slot.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (options.ratePerSec <= 0) throw new Error('ratePerSec must be > 0');
    if (options.burst < 1) throw new Error('burst must be >= 1');
    this.ratePerMs = options.ratePerSec / 1000;
    this.burst = options.burst;
    this.maxKeys = options.maxKeys ?? 50_000;
    this.now = options.now ?? (() => performance.now());
  }

  reserve(key: string, maxWaitMs: number): Reservation {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evictIdle(now);
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.updatedAt) * this.ratePerMs);
      bucket.updatedAt = now;
    }

    const after = bucket.tokens - 1;
    const waitMs = after >= 0 ? 0 : -after / this.ratePerMs;
    if (waitMs > maxWaitMs) return { ok: false, retryAfterMs: Math.ceil(waitMs) };
    bucket.tokens = after;
    return { ok: true, waitMs: Math.ceil(waitMs) };
  }

  /** Returns a token taken by a reservation whose request was never sent. */
  release(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) bucket.tokens = Math.min(this.burst, bucket.tokens + 1);
  }

  get size(): number {
    return this.buckets.size;
  }

  private evictIdle(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.ratePerMs;
      if (refilled >= this.burst) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }
  }
}
