import { AppError, classifyError } from '../errors.js';

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with "equal jitter": half of the exponential delay is kept,
 * the other half is randomised. This spreads retries from many workers while
 * guaranteeing a minimum spacing between attempts.
 *
 * @param retryNumber 1 for the first retry, 2 for the second, ...
 */
export function computeBackoffDelay(retryNumber: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const exponent = Math.max(0, retryNumber - 1);
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(exponent, 30));
  const half = capped / 2;
  return Math.round(half + random() * half);
}

/**
 * Delay for a failed attempt. An explicit Retry-After from the remote API is
 * honoured exactly (retrying earlier would only be rejected again); otherwise
 * exponential backoff with jitter is used.
 */
export function retryDelayFor(err: unknown, retryNumber: number, policy: BackoffPolicy, random?: () => number): number {
  const retryAfter = err instanceof AppError ? err.retryAfterMs : undefined;
  if (retryAfter !== undefined && retryAfter > 0) return retryAfter;
  return computeBackoffDelay(retryNumber, policy, random);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  policy: BackoffPolicy;
  shouldRetry: (err: AppError, retryNumber: number) => boolean;
  onRetry?: (err: AppError, retryNumber: number, delayMs: number) => void;
  signal?: AbortSignal;
  random?: () => number;
}

/** Runs `fn`, retrying classified retryable failures with backoff. Throws the last error. */
export async function retryAsync<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = classifyError(raw);
      const retryNumber = attempt;
      if (retryNumber > options.retries || !err.retryable || !options.shouldRetry(err, retryNumber)) throw err;
      const delay = retryDelayFor(err, retryNumber, options.policy, options.random);
      options.onRetry?.(err, retryNumber, delay);
      await sleep(delay, options.signal);
    }
  }
}
