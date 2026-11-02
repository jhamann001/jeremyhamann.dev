import { describe, it, expect } from "vitest";
import {
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  WARN_BEFORE_MS,
  msUntilExpiry,
  shouldWarn,
  isExpired,
  formatCountdown,
} from "@/lib/auth/session-timeout";

// ticket — pure session-timeout math. This drives an AUTH-sensitive flow (when
// to warn, when to sign out, what the countdown reads), so pin every boundary.

describe("session-timeout constants", () => {
  it("is a 4h session with a sub-maxAge slide window", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 4); // 14400
    // Auth.js requires updateAge < maxAge, else it never slides.
    expect(SESSION_UPDATE_AGE_SECONDS).toBeLessThan(SESSION_MAX_AGE_SECONDS);
    expect(WARN_BEFORE_MS).toBe(5 * 60 * 1000);
  });
});

describe("msUntilExpiry", () => {
  const now = 1_000_000;
  it("returns the positive remaining time", () => {
    expect(msUntilExpiry(now + 5000, now)).toBe(5000);
  });
  it("clamps to 0 once past expiry (never negative)", () => {
    expect(msUntilExpiry(now - 5000, now)).toBe(0);
    expect(msUntilExpiry(now, now)).toBe(0);
  });
});

describe("shouldWarn", () => {
  const now = 10_000_000;
  it("does NOT warn with more than 5 min left", () => {
    expect(shouldWarn(now + WARN_BEFORE_MS + 1000, now)).toBe(false);
  });
  it("warns exactly at the 5-min threshold", () => {
    expect(shouldWarn(now + WARN_BEFORE_MS, now)).toBe(true);
  });
  it("warns inside the window", () => {
    expect(shouldWarn(now + 30_000, now)).toBe(true);
  });
  it("stops warning at 0 (that is sign-out territory, not warn)", () => {
    expect(shouldWarn(now, now)).toBe(false);
    expect(shouldWarn(now - 1000, now)).toBe(false);
  });
});

describe("isExpired", () => {
  const now = 5_000_000;
  it("is false while time remains", () => {
    expect(isExpired(now + 1, now)).toBe(false);
  });
  it("is true at and past expiry", () => {
    expect(isExpired(now, now)).toBe(true);
    expect(isExpired(now - 1, now)).toBe(true);
  });
});

describe("formatCountdown", () => {
  it("formats M:SS with zero-padded seconds", () => {
    expect(formatCountdown(5 * 60 * 1000)).toBe("5:00");
    expect(formatCountdown(4 * 60 * 1000 + 7 * 1000)).toBe("4:07");
    expect(formatCountdown(59 * 1000)).toBe("0:59");
  });
  it("rounds up so the window opens at 5:00, not 4:59", () => {
    // 4:59.4 remaining should still read 5:00 (ceil), and only true 0 shows 0:00.
    expect(formatCountdown(4 * 60 * 1000 + 59_400)).toBe("5:00");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
  });
  it("never renders negative", () => {
    expect(formatCountdown(-5000)).toBe("0:00");
  });
});
