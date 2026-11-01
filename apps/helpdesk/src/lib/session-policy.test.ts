/**
 * Session policy — the 30-minute idle bound.
 *
 * The absolute 8-hour bound is tested in `src/auth.config.test.ts`, against the real `jwt` callback.
 * This file tests the arithmetic underneath it, including the two fail-closed edges that matter more
 * than the happy path: a token with no stamp at all, and a stamp that is not a number.
 */
import { describe, expect, it } from "vitest";
import { IDLE_TIMEOUT_MS, isIdleExpired, touchActivity } from "@/lib/session-policy";

const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);

describe("IDLE_TIMEOUT_MS", () => {
  it("is 30 minutes, and shorter than the absolute 8-hour bound it sits under", () => {
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(IDLE_TIMEOUT_MS).toBeLessThan(8 * 3600 * 1000);
  });
});

describe("isIdleExpired", () => {
  it("is false up to and including the bound, true one millisecond past it (strict >)", () => {
    const token = { lastSeenAt: T0, groupsSyncedAt: T0 };
    expect(isIdleExpired(token, T0)).toBe(false);
    expect(isIdleExpired(token, T0 + IDLE_TIMEOUT_MS - 1)).toBe(false);
    expect(isIdleExpired(token, T0 + IDLE_TIMEOUT_MS)).toBe(false);
    expect(isIdleExpired(token, T0 + IDLE_TIMEOUT_MS + 1)).toBe(true);
  });

  it("falls back to groupsSyncedAt for a token minted before this policy existed", () => {
    // Conservative on purpose: such a token is judged from its SIGN-IN, so an old session cannot
    // outlive the policy by virtue of predating it.
    const legacy = { groupsSyncedAt: T0 };
    expect(isIdleExpired(legacy, T0 + 5 * 60 * 1000)).toBe(false);
    expect(isIdleExpired(legacy, T0 + IDLE_TIMEOUT_MS + 1)).toBe(true);
  });

  it("treats an unreadable or missing stamp as expired (fail closed)", () => {
    expect(isIdleExpired({}, T0)).toBe(true);
    expect(isIdleExpired({ lastSeenAt: "yesterday" }, T0)).toBe(true);
    expect(isIdleExpired({ lastSeenAt: Number.NaN }, T0)).toBe(true);
    expect(isIdleExpired({ lastSeenAt: 0 }, T0)).toBe(true);
    expect(isIdleExpired({ lastSeenAt: -1 }, T0)).toBe(true);
    expect(isIdleExpired({ lastSeenAt: null }, T0)).toBe(true);
  });

  it("prefers lastSeenAt over groupsSyncedAt — activity, not sign-in, is what resets the window", () => {
    const token = { groupsSyncedAt: T0, lastSeenAt: T0 + 3 * 3600 * 1000 };
    expect(isIdleExpired(token, T0 + 3 * 3600 * 1000 + 60_000)).toBe(false);
  });
});

describe("touchActivity", () => {
  it("returns a NEW object carrying the stamp, and never mutates its input", () => {
    const token: { uid: string; groupsSyncedAt: number; lastSeenAt?: unknown } = {
      uid: "user_1",
      groupsSyncedAt: T0,
    };
    const touched = touchActivity(token, T0 + 1000);
    expect(touched).not.toBe(token);
    expect(touched.lastSeenAt).toBe(T0 + 1000);
    expect(touched.uid).toBe("user_1");
    expect(touched.groupsSyncedAt).toBe(T0);
    // The input is untouched: a caller cannot half-apply the stamp by holding on to the old object.
    expect("lastSeenAt" in token).toBe(false);
  });

  it("a touched token is never idle at the instant it was touched", () => {
    expect(isIdleExpired(touchActivity({ groupsSyncedAt: T0 }, T0), T0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slice B6 review against CONTRACT §6. The module was handed over LIVE by the
// foundation; this block extends the cover rather than restating it, and weakens nothing above.
// ---------------------------------------------------------------------------

describe("idle policy — B6 review against CONTRACT §6", () => {
  it("the idle bound is strictly tighter than the absolute one, and they answer different questions", () => {
    // §6: 8 hours bounds how long a DEMOTED user keeps stale groups; 30 minutes bounds how long an
    // UNATTENDED machine stays signed into a books-and-records system. If the idle window ever grew
    // past the absolute lifetime it would be decorative, so the relationship is pinned here as well
    // as in auth.config.test.ts, where only the absolute bound is exercised.
    const ABSOLUTE_MAX_MS = 8 * 3600 * 1000;
    expect(IDLE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(IDLE_TIMEOUT_MS).toBeLessThan(ABSOLUTE_MAX_MS);
    // Auth.js re-issues a token at most once per `updateAge` (1 hour), so a window tighter than the
    // re-issue interval could not be enforced honestly. 30 minutes sits below the absolute bound and
    // above nothing — the comment in the module explains why it is not 5.
    expect(IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("a clock that runs backwards does not expire a live session", () => {
    // Server clock skew, an NTP correction or a token minted a few milliseconds in the future must
    // not sign somebody out mid-sentence. `now - last` goes negative, which is not `> IDLE_TIMEOUT_MS`.
    expect(isIdleExpired({ lastSeenAt: T0 + 60_000 }, T0)).toBe(false);
    expect(isIdleExpired({ lastSeenAt: T0 + 10 * 3600 * 1000 }, T0)).toBe(false);
  });

  it("rejects every non-finite or non-positive stamp shape, including the ones that coerce", () => {
    // Fail closed: an unreadable stamp is not a fresh one. Strings that LOOK numeric are the trap —
    // `"1790000000000" > 0` is true under coercion and false under a typeof check.
    for (const bad of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      0,
      -1,
      "1790000000000",
      true,
      [],
      {},
      new Date(T0),
    ]) {
      expect(isIdleExpired({ lastSeenAt: bad, groupsSyncedAt: bad }, T0), String(bad)).toBe(true);
    }
  });

  it("an unusable lastSeenAt falls back to groupsSyncedAt rather than expiring outright", () => {
    // The fallback is the whole reason a token minted before this policy existed still works. It must
    // survive a lastSeenAt that is present but unreadable, not only one that is absent.
    expect(isIdleExpired({ lastSeenAt: "corrupt", groupsSyncedAt: T0 }, T0 + 60_000)).toBe(false);
    expect(isIdleExpired({ lastSeenAt: null, groupsSyncedAt: T0 }, T0 + 60_000)).toBe(false);
    expect(isIdleExpired({ lastSeenAt: "corrupt", groupsSyncedAt: T0 }, T0 + IDLE_TIMEOUT_MS + 1)).toBe(true);
  });

  it("touchActivity preserves every other claim, including ones this module has never heard of", () => {
    // The jwt callback passes the WHOLE token through. Dropping an unknown claim here would silently
    // strip `groups`, `uid` or anything a later wave adds.
    const token = {
      uid: "user_1",
      groups: ["ops_team"],
      groupsSyncedAt: T0,
      somethingWaveCAdds: { nested: true },
      lastSeenAt: T0 - 60_000,
    };
    const touched = touchActivity(token, T0);
    expect(touched).toEqual({ ...token, lastSeenAt: T0 });
    expect(touched.somethingWaveCAdds).toBe(token.somethingWaveCAdds);
  });

  it("repeated touches inside the window keep a session alive; one gap past it ends it", () => {
    // The behaviour a person experiences: working keeps you in, a long coffee does not.
    let token: { groupsSyncedAt: number; lastSeenAt?: unknown } = { groupsSyncedAt: T0 };
    let now = T0;
    for (let i = 0; i < 20; i++) {
      now += IDLE_TIMEOUT_MS - 1;
      expect(isIdleExpired(token, now), `tick ${i}`).toBe(false);
      token = touchActivity(token, now);
    }
    expect(isIdleExpired(token, now + IDLE_TIMEOUT_MS + 1)).toBe(true);
  });
});
