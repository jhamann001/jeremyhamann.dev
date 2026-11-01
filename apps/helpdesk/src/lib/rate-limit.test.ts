/**
 * `src/lib/rate-limit.ts` — the per-token limit and its audited-throttle gate.
 *
 * Every assertion here stands for a property the module PROMISES, not for an implementation detail:
 * the window is fixed and closes lazily, refused requests still count, the audit gate fires once per
 * window, the map is bounded, and a clock that steps backwards over-counts rather than under-counts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { WAVE_B_LIMITS } from "@/types/domain";
import {
  RATE_LIMIT_MAX_TRACKED_KEYS,
  RATE_LIMIT_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  checkRateLimit,
  rateLimitCount,
  rateLimitSize,
  resetRateLimit,
  shouldRecordThrottle,
} from "@/lib/rate-limit";

const T0 = new Date("2026-09-20T14:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

beforeEach(() => {
  resetRateLimit();
});

describe("checkRateLimit", () => {
  it("is the contract's limit, not a second opinion", () => {
    expect(RATE_LIMIT_PER_WINDOW).toBe(WAVE_B_LIMITS.tokenRateLimitPerMinute);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("allows exactly the budget and then refuses", () => {
    for (let i = 1; i <= RATE_LIMIT_PER_WINDOW; i++) {
      const d = checkRateLimit("token:a", at(0));
      expect(d.allowed, `request ${i} must be allowed`).toBe(true);
      expect(d.remaining).toBe(RATE_LIMIT_PER_WINDOW - i);
    }
    const over = checkRateLimit("token:a", at(0));
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("reports the reset at the end of the window the first request opened", () => {
    const first = checkRateLimit("token:a", at(0));
    expect(first.resetAt.getTime()).toBe(T0.getTime() + RATE_LIMIT_WINDOW_MS);
    const later = checkRateLimit("token:a", at(30_000));
    expect(later.resetAt.getTime()).toBe(T0.getTime() + RATE_LIMIT_WINDOW_MS);
  });

  it("counts refused requests too, so ignoring a 429 does not reopen the window early", () => {
    for (let i = 0; i < RATE_LIMIT_PER_WINDOW + 5; i++) checkRateLimit("token:a", at(0));
    expect(rateLimitCount("token:a", at(0))).toBe(RATE_LIMIT_PER_WINDOW + 5);
    // Still inside the window a moment before it closes: still refused.
    expect(checkRateLimit("token:a", at(RATE_LIMIT_WINDOW_MS - 1)).allowed).toBe(false);
  });

  it("opens a fresh window lazily, with no timer, once the old one has passed", () => {
    for (let i = 0; i < RATE_LIMIT_PER_WINDOW + 1; i++) checkRateLimit("token:a", at(0));
    const next = checkRateLimit("token:a", at(RATE_LIMIT_WINDOW_MS));
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(RATE_LIMIT_PER_WINDOW - 1);
    expect(next.resetAt.getTime()).toBe(T0.getTime() + 2 * RATE_LIMIT_WINDOW_MS);
  });

  it("keeps separate budgets per key", () => {
    for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i++) checkRateLimit("token:a", at(0));
    expect(checkRateLimit("token:a", at(0)).allowed).toBe(false);
    expect(checkRateLimit("token:b", at(0)).allowed).toBe(true);
  });

  it("a backwards clock step suppresses rather than resets — over-counting is the safe direction", () => {
    for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i++) checkRateLimit("token:a", at(30_000));
    // NTP steps the clock back by a minute. `now - windowStartedAt` is negative, which reads as
    // "still inside the window": the caller waits, rather than getting a free budget.
    expect(checkRateLimit("token:a", at(-30_000)).allowed).toBe(false);
  });
});

describe("shouldRecordThrottle", () => {
  it("is true once per key per window and false for every later refusal", () => {
    expect(shouldRecordThrottle("token:a", at(0))).toBe(true);
    expect(shouldRecordThrottle("token:a", at(1))).toBe(false);
    expect(shouldRecordThrottle("token:a", at(59_999))).toBe(false);
    // Next window: one more row, which is what carries the evidence forward.
    expect(shouldRecordThrottle("token:a", at(60_000))).toBe(true);
  });

  it("does not consume another key's budget", () => {
    expect(shouldRecordThrottle("token:a", at(0))).toBe(true);
    expect(shouldRecordThrottle("token:b", at(0))).toBe(true);
  });

  it("opening the window through the throttle gate still lets the first request through", () => {
    shouldRecordThrottle("token:a", at(0));
    expect(checkRateLimit("token:a", at(0)).allowed).toBe(true);
  });
});

describe("bounds", () => {
  it("evicts least-recently-used keys instead of growing without limit", () => {
    for (let i = 0; i < RATE_LIMIT_MAX_TRACKED_KEYS + 50; i++) checkRateLimit(`token:${i}`, at(0));
    expect(rateLimitSize()).toBe(RATE_LIMIT_MAX_TRACKED_KEYS);
    // The oldest key was evicted, so its window restarts — a looser limit, never a tighter one.
    expect(rateLimitCount("token:0", at(0))).toBe(0);
    expect(rateLimitCount(`token:${RATE_LIMIT_MAX_TRACKED_KEYS + 49}`, at(0))).toBe(1);
  });

  it("rateLimitCount forgets a stale window without being asked to", () => {
    checkRateLimit("token:a", at(0));
    expect(rateLimitCount("token:a", at(0))).toBe(1);
    expect(rateLimitCount("token:a", at(RATE_LIMIT_WINDOW_MS))).toBe(0);
  });
});
