/**
 * Per-user rate limit for the AI draft seam — pure, node, layer L1.
 *
 * The same shape as `src/lib/denial-throttle.ts`: a fixed window, a bounded LRU map and **no timers**
 * — a window is closed lazily by the next call that finds it stale, so an idle instance keeps nothing
 * warm and there is nothing to clean up at shutdown.
 *
 * What it is for, stated honestly, because it is easy to mistake this for a security control:
 *
 *  - It bounds the COST and the noise of one operator holding the draft button down — a generative
 *    call is billed per token and writes an `AI_DRAFT_REQUESTED` row per attempt, and an append-only
 *    ledger should not be growable at the speed of a key repeat.
 *  - It is per Cloud Run INSTANCE, like every other in-memory limit in this repository.
 *    With several instances the real ceiling is `limit × instances`, so this is a FLOOR, not a total.
 *  - It is NOT an authorization check. The capability check in `requestAiDraft` is the control; this
 *    is a brake.
 *
 * `src/lib/rate-limit.ts` (B8's `checkRateLimit`) is the per-TOKEN limiter for the
 * machine surface and is built by another slice in this same wave. This one is deliberately separate
 * rather than importing it: the two answer different questions (a signed-in person with a session
 * versus a bearer token), they want different windows, and B3 must not fail to typecheck because B8
 * has not landed yet. Recorded in the build record.
 */

/** Requests per window, per user. A drafting operator asks for two or three; twelve is generous. */
export const AI_DRAFT_LIMIT_PER_WINDOW = 12;

/** The window. */
export const AI_DRAFT_WINDOW_MS = 60_000;

/** LRU bound on the tracked-user map. Far more than one instance sees in a minute. */
export const AI_DRAFT_MAX_TRACKED_USERS = 2_000;

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests left in the current window AFTER this one. Zero on the request that exhausts it. */
  remaining: number;
  /** When the current window ends and the allowance returns. */
  resetAt: Date;
};

type Window = { startedAtMs: number; count: number };

const windows = new Map<string, Window>();

/** Map insertion order is LRU here because every touch re-inserts; the oldest key is the first. */
function touch(key: string, window: Window): void {
  windows.delete(key);
  windows.set(key, window);
  if (windows.size > AI_DRAFT_MAX_TRACKED_USERS) {
    const oldest = windows.keys().next();
    if (!oldest.done) windows.delete(oldest.value);
  }
}

/**
 * Counts one attempt against `userId` and says whether it may proceed.
 *
 * Counting the REFUSED attempt too is deliberate: a caller hammering the endpoint should not get a
 * fresh allowance the moment the window rolls simply because its refusals were free. The window
 * still rolls on wall-clock time, so a legitimate operator waits at most one window.
 */
export function checkAiDraftRateLimit(userId: string, now: Date = new Date()): RateLimitDecision {
  const nowMs = now.getTime();
  const existing = windows.get(userId);
  const stale = existing === undefined || nowMs - existing.startedAtMs >= AI_DRAFT_WINDOW_MS;
  const window: Window = stale ? { startedAtMs: nowMs, count: 0 } : existing;

  window.count += 1;
  touch(userId, window);

  const resetAt = new Date(window.startedAtMs + AI_DRAFT_WINDOW_MS);
  const allowed = window.count <= AI_DRAFT_LIMIT_PER_WINDOW;
  return { allowed, remaining: Math.max(0, AI_DRAFT_LIMIT_PER_WINDOW - window.count), resetAt };
}

/** Test seam: forgets every window. */
export function resetAiDraftRateLimitForTests(): void {
  windows.clear();
}
