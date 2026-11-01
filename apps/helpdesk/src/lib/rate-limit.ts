/**
 * Per-token request limiting for the machine surfaces — pure, node only, layer L2
 *.
 *
 * The shape is deliberately the one `src/lib/denial-throttle.ts` already uses, for the same reasons
 * and with the same stated limits:
 *
 *  - **In-memory and therefore PER INSTANCE.** Cloud Run runs several containers and replaces them
 *    freely, so the effective ceiling is `limit x instances`, not `limit`. That makes this a FLOOR on
 *    what a single misbehaving consumer can do to one container, never a total for the service. The
 *    real control is an edge rate limit in front of production, and no such control is deployed —
 *    neither `infra/terraform-dev` nor `infra/terraform-prod` contains a `google_compute_security_policy`
 *    or a load balancer. the build record says so in writing so
 *    nobody reads this module as the answer to a denial-of-service question.
 *  - **No timers.** A window is closed lazily by the next call that finds it stale, so an idle
 *    instance keeps nothing warm and there is nothing to unwind at shutdown.
 *  - **Bounded and LRU-evicted.** A caller rotating token ids cannot grow the map; the cost of
 *    eviction is that an evicted key restarts its window, which loosens the limit rather than
 *    tightening it — the safe direction for a control whose failure mode must never be "refuse a
 *    legitimate desk call".
 *
 * Counting is by FIXED window rather than a sliding log: a sliding window needs per-request
 * timestamps, which is an unbounded allocation per key driven by the caller, and the precision buys
 * nothing here — the limit exists to stop a runaway loop, not to meter billing.
 *
 * Pure in the sense that matters: no database, no audit write, no `fetch`. The AUDIT half of
 * "audited throttling" lives with the caller, which is the only layer that knows the actor and the
 * request context; `shouldRecordThrottle` is what keeps that write to one row per key per window so a
 * runaway consumer cannot grow the append-only ledger by being throttled.
 */
import { WAVE_B_LIMITS } from "@/types/domain";

/** One minute, matching `WAVE_B_LIMITS.tokenRateLimitPerMinute`'s unit. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Requests per key per window. One place, so no surface can disagree with another. */
export const RATE_LIMIT_PER_WINDOW: number = WAVE_B_LIMITS.tokenRateLimitPerMinute;

/**
 * Ceiling on tracked keys. Ten thousand distinct tokens in one minute is far past anything the desk
 * will ever issue, so this is a memory bound against a caller that forges token ids, not a business
 * limit. Same number as `DENIAL_MAX_TRACKED_KEYS`, deliberately.
 */
export const RATE_LIMIT_MAX_TRACKED_KEYS = 10_000;

export type RateLimitDecision = {
  /** False when this request is over the limit. The caller answers 429 and records the throttle. */
  allowed: boolean;
  /** Requests left in this window AFTER this one. Zero once the limit is reached; never negative. */
  remaining: number;
  /** When the window rolls over and `remaining` returns to the full budget. */
  resetAt: Date;
};

type WindowState = {
  windowStartedAt: number;
  count: number;
  /** True once a throttle has been recorded for this key in this window (see `shouldRecordThrottle`). */
  throttleRecorded: boolean;
};

/** Insertion-ordered, so `keys().next()` is the least recently touched entry (touch = delete-then-set). */
const windows = new Map<string, WindowState>();

function touch(key: string, state: WindowState): void {
  windows.delete(key);
  windows.set(key, state);
  while (windows.size > RATE_LIMIT_MAX_TRACKED_KEYS) {
    const oldest = windows.keys().next();
    if (oldest.done === true) break;
    windows.delete(oldest.value);
  }
}

/**
 * Resolves the live window for `key`, opening a fresh one when the previous has expired.
 *
 * A clock that steps BACKWARDS (an NTP correction) leaves `now - windowStartedAt` negative, which
 * reads as "still inside the window". That over-counts rather than under-counts, which is the safe
 * direction for a limiter: the worst case is a caller waiting out a window that lasts a little
 * longer than a minute, not a limit that silently stops applying.
 */
function liveWindow(key: string, nowMs: number): WindowState {
  const existing = windows.get(key);
  if (existing !== undefined && nowMs - existing.windowStartedAt < RATE_LIMIT_WINDOW_MS) {
    touch(key, existing);
    return existing;
  }
  const fresh: WindowState = { windowStartedAt: nowMs, count: 0, throttleRecorded: false };
  touch(key, fresh);
  return fresh;
}

/**
 * Counts one request against `key` and says whether it may proceed.
 *
 * `key` is caller-composed and namespaced by the caller — `src/lib/api-tokens.ts` uses
 * `token:<tokenId>` for a database credential and `token:legacy:<surface>` for the env bearer, so two
 * realms can never share a budget. It is never a raw bearer: a key is held in memory and appears in
 * log lines, and a secret must be in neither.
 *
 * Every call counts, including the ones this function refuses. A caller that ignores a 429 therefore
 * keeps its own window open, which is the behaviour that makes a runaway loop back off instead of
 * hammering the edge of the window forever.
 */
export function checkRateLimit(key: string, now: Date = new Date()): RateLimitDecision {
  const nowMs = now.getTime();
  const state = liveWindow(key, Number.isFinite(nowMs) ? nowMs : Date.now());
  state.count += 1;
  const allowed = state.count <= RATE_LIMIT_PER_WINDOW;
  return {
    allowed,
    remaining: Math.max(0, RATE_LIMIT_PER_WINDOW - state.count),
    resetAt: new Date(state.windowStartedAt + RATE_LIMIT_WINDOW_MS),
  };
}

/**
 * True for the FIRST refused request of a window and false for every later one, so the audited
 * throttle writes ONE `AUTHZ_DENIED` row per key per minute instead of one per refused request.
 *
 * Without this a throttled consumer would be able to grow an append-only, hash-chained ledger at
 * exactly the rate it is being refused — which is the failure mode Decision #71 was written about,
 * arriving through a different door. Evidence is not lost: the recorded row carries the count of
 * requests the window has seen, and the caller's structured log line carries the rest.
 *
 * Call it only after `checkRateLimit` has answered `allowed: false` for the same key; on a key with
 * no live window it opens one and answers true, which is the honest reading of "nothing has been
 * recorded for this key yet".
 */
export function shouldRecordThrottle(key: string, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  const state = liveWindow(key, Number.isFinite(nowMs) ? nowMs : Date.now());
  if (state.throttleRecorded) return false;
  state.throttleRecorded = true;
  return true;
}

/** Requests counted against `key` in the live window, for the audit row's metadata. Zero when idle. */
export function rateLimitCount(key: string, now: Date = new Date()): number {
  const state = windows.get(key);
  if (state === undefined) return 0;
  const nowMs = now.getTime();
  return nowMs - state.windowStartedAt < RATE_LIMIT_WINDOW_MS ? state.count : 0;
}

/** Test seam. Never called by application code — the map is process-lifetime state by design. */
export function resetRateLimit(): void {
  windows.clear();
}

/** Tracked keys, so a test can prove the bound actually evicts. */
export function rateLimitSize(): number {
  return windows.size;
}
