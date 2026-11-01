/**
 * The AI draft brake. Unit; no timers, so the clock is passed in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_DRAFT_LIMIT_PER_WINDOW,
  AI_DRAFT_MAX_TRACKED_USERS,
  AI_DRAFT_WINDOW_MS,
  checkAiDraftRateLimit,
  resetAiDraftRateLimitForTests,
} from "@/lib/ai/rate-limit";

const T0 = new Date("2026-09-20T12:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

beforeEach(() => {
  resetAiDraftRateLimitForTests();
});

describe("checkAiDraftRateLimit", () => {
  it("allows exactly the limit in a window and refuses the next", () => {
    for (let i = 1; i <= AI_DRAFT_LIMIT_PER_WINDOW; i += 1) {
      const d = checkAiDraftRateLimit("u1", at(i));
      expect(d.allowed, `request ${i}`).toBe(true);
      expect(d.remaining).toBe(AI_DRAFT_LIMIT_PER_WINDOW - i);
    }
    const over = checkAiDraftRateLimit("u1", at(AI_DRAFT_LIMIT_PER_WINDOW + 1));
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("reports when the allowance returns, measured from the window's first request", () => {
    const first = checkAiDraftRateLimit("u1", T0);
    expect(first.resetAt.getTime()).toBe(T0.getTime() + AI_DRAFT_WINDOW_MS);
    // A later request in the same window does not extend it.
    expect(checkAiDraftRateLimit("u1", at(500)).resetAt.getTime()).toBe(T0.getTime() + AI_DRAFT_WINDOW_MS);
  });

  it("rolls the window on wall-clock time, so a legitimate operator waits at most one window", () => {
    for (let i = 0; i <= AI_DRAFT_LIMIT_PER_WINDOW; i += 1) checkAiDraftRateLimit("u1", at(i));
    expect(checkAiDraftRateLimit("u1", at(AI_DRAFT_WINDOW_MS + 1)).allowed).toBe(true);
  });

  it("counts refused attempts too — hammering does not buy a fresh allowance", () => {
    for (let i = 0; i < AI_DRAFT_LIMIT_PER_WINDOW + 5; i += 1) checkAiDraftRateLimit("u1", at(i));
    // Still inside the window: the extra five were counted, so this is refused as well.
    expect(checkAiDraftRateLimit("u1", at(AI_DRAFT_WINDOW_MS - 1)).allowed).toBe(false);
  });

  it("is per user", () => {
    for (let i = 0; i <= AI_DRAFT_LIMIT_PER_WINDOW; i += 1) checkAiDraftRateLimit("u1", at(i));
    expect(checkAiDraftRateLimit("u2", at(1)).allowed).toBe(true);
  });

  it("is bounded — a flood of distinct keys cannot grow the map without limit", () => {
    for (let i = 0; i < AI_DRAFT_MAX_TRACKED_USERS + 50; i += 1) checkAiDraftRateLimit(`u${i}`, at(i));
    // The oldest keys were evicted, so the earliest user starts a fresh window rather than being
    // remembered forever. (Observable behaviour; the map itself is private.)
    expect(checkAiDraftRateLimit("u0", at(1)).remaining).toBe(AI_DRAFT_LIMIT_PER_WINDOW - 1);
  });
});
