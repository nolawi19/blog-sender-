/**
 * High-resolution wall clock shared by the gateway and the worker.
 *
 * Latency is measured across processes (gateway stamps receipt, worker stamps
 * outbound request start), so a monotonic per-process clock is not enough. This
 * clock is `performance.now()` (microsecond resolution, monotonic) anchored to
 * the system wall clock, and re-anchored when the two drift apart by more than
 * 2 ms (for example after an NTP step). Processes on the same host therefore
 * agree to within roughly a millisecond, which is well below the 30 ms target.
 */

const REANCHOR_INTERVAL_MS = 5_000;
const MAX_DRIFT_MS = 2;

let anchor = Date.now() - performance.now();

const reanchor = setInterval(() => {
  const candidate = Date.now() - performance.now();
  if (Math.abs(candidate - anchor) > MAX_DRIFT_MS) anchor = candidate;
}, REANCHOR_INTERVAL_MS);
reanchor.unref();

/** Milliseconds since the Unix epoch with sub-millisecond precision. */
export function nowMs(): number {
  return anchor + performance.now();
}

/** Rounds a millisecond duration to microsecond precision for logs and storage. */
export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type Clock = () => number;
