/**
 * denial-throttle.ts unit tests — no database.
 *
 * The pure core is the whole point: one row per key per window, a carried-forward suppressed count so
 * a single row can state the true number, a bounded LRU map, and no timers anywhere. The wiring
 * function is exercised against a mocked `recordCoalescedDenial` so the "first records, rest log"
 * split is proven without touching the ledger.
 *
 * The second bound — at most DENIAL_MAX_ROWS_PER_ROUTE_WINDOW rows per ROUTE per window, whatever the
 * source address — is what holds when the per-IP key does not: an adversary with an IPv6 /64 presents
 * a fresh address per probe, so every probe is a fresh key. Those tests are the last describe block,
 * and they are the reason this module is not a no-op against the attacker it was written for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@/types/domain";
import { captureLogs } from "@/test-support/capture-logs";

const auditMock = vi.hoisted(() => ({ recordCoalescedDenial: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => auditMock);

import {
  DENIAL_MAX_ROWS_PER_ROUTE_WINDOW,
  DENIAL_MAX_TRACKED_KEYS,
  DENIAL_MAX_TRACKED_SCOPES,
  DENIAL_SCOPE_SEPARATOR,
  DENIAL_WINDOW_MS,
  denialThrottleKey,
  denialThrottleScopeSize,
  denialThrottleSize,
  recordDenialAttempt,
  recordUnauthenticatedClientDenial,
  resetDenialThrottle,
} from "@/lib/denial-throttle";

const T0 = new Date("2026-09-19T12:00:00.000Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

const CTX: RequestContext = {
  ipAddress: "203.0.113.7",
  userAgent: "probe/1.0",
  requestId: "req-throttle-0001",
  isPrefetch: false,
};

beforeEach(() => {
  resetDenialThrottle();
  auditMock.recordCoalescedDenial.mockClear();
});

afterEach(() => {
  resetDenialThrottle();
});

describe("recordDenialAttempt", () => {
  it("records the first denial for a key and suppresses the rest of the window", () => {
    const first = recordDenialAttempt("k", at(0));
    expect(first.record).toBe(true);
    expect(first.suppressedSinceLastRecord).toBe(0);
    expect(first.windowStartedAt.toISOString()).toBe(T0.toISOString());

    for (let i = 1; i <= 5; i++) {
      const later = recordDenialAttempt("k", at(i * 1_000));
      expect(later.record).toBe(false);
      expect(later.suppressedSinceLastRecord).toBe(i);
      // The window is the one the recorded row opened, not the moment of this attempt.
      expect(later.windowStartedAt.toISOString()).toBe(T0.toISOString());
    }
  });

  it("carries the suppressed count into the next window's row, so ONE row can state the true count", () => {
    recordDenialAttempt("k", at(0));
    recordDenialAttempt("k", at(1_000));
    recordDenialAttempt("k", at(2_000));
    recordDenialAttempt("k", at(3_000));

    const next = recordDenialAttempt("k", at(DENIAL_WINDOW_MS));
    expect(next.record).toBe(true);
    expect(next.suppressedSinceLastRecord).toBe(3);
    expect(next.windowStartedAt.toISOString()).toBe(at(DENIAL_WINDOW_MS).toISOString());

    // The carried count is consumed exactly once.
    const after = recordDenialAttempt("k", at(DENIAL_WINDOW_MS * 2));
    expect(after.record).toBe(true);
    expect(after.suppressedSinceLastRecord).toBe(0);
  });

  it("closes a window at exactly DENIAL_WINDOW_MS, not a millisecond earlier", () => {
    recordDenialAttempt("k", at(0));
    expect(recordDenialAttempt("k", at(DENIAL_WINDOW_MS - 1)).record).toBe(false);
    expect(recordDenialAttempt("k", at(DENIAL_WINDOW_MS)).record).toBe(true);
  });

  it("keeps windows independent per key", () => {
    expect(recordDenialAttempt("a", at(0)).record).toBe(true);
    expect(recordDenialAttempt("b", at(0)).record).toBe(true);
    expect(recordDenialAttempt("a", at(1)).record).toBe(false);
    expect(recordDenialAttempt("b", at(1)).record).toBe(false);
  });

  it("suppresses rather than over-records when the clock steps backwards", () => {
    recordDenialAttempt("k", at(0));
    // An NTP step backwards must never open a fresh window and write another row.
    expect(recordDenialAttempt("k", at(-30_000)).record).toBe(false);
  });

  it("stays bounded under key rotation, evicting the least recently touched key", () => {
    for (let i = 0; i < DENIAL_MAX_TRACKED_KEYS + 250; i++) {
      recordDenialAttempt(`ip-${i}`, at(0));
    }
    expect(denialThrottleSize()).toBe(DENIAL_MAX_TRACKED_KEYS);
    // The first keys were evicted, so their next attempt reads as a fresh window (the count is a floor).
    expect(recordDenialAttempt("ip-0", at(1)).record).toBe(true);
    // A key still tracked is still inside its window.
    expect(recordDenialAttempt(`ip-${DENIAL_MAX_TRACKED_KEYS + 249}`, at(1)).record).toBe(false);
  });

  it("a touched key survives eviction pressure that would otherwise drop it", () => {
    recordDenialAttempt("sticky", at(0));
    for (let i = 0; i < DENIAL_MAX_TRACKED_KEYS - 1; i++) {
      recordDenialAttempt(`filler-${i}`, at(0));
      // Touch the sticky key so it never becomes the oldest entry.
      recordDenialAttempt("sticky", at(1));
    }
    recordDenialAttempt("overflow", at(1));
    expect(recordDenialAttempt("sticky", at(2)).record).toBe(false);
  });
});

describe("denialThrottleKey", () => {
  it("separates routes for the same IP, so the recorded route is always the one that was hit", () => {
    expect(denialThrottleKey("/api/client/tickets", "1.2.3.4")).not.toBe(
      denialThrottleKey("/api/client/tickets/[id]/messages", "1.2.3.4"),
    );
    expect(denialThrottleKey("/a", "1.2.3.4")).toBe(denialThrottleKey("/a", "1.2.3.4"));
  });

  it("cannot be confused by a route or IP that contains the separator's printable neighbours", () => {
    expect(denialThrottleKey("/a|b", "1.2.3.4")).not.toBe(denialThrottleKey("/a", "b|1.2.3.4"));
  });
});

describe("recordUnauthenticatedClientDenial", () => {
  it("writes ONE row for the window and logs the rest", async () => {
    // The suppressed denials go through `@/lib/logger` now, which never calls `console` — `console`
    // is the sink CWE-209 watches — so they are captured off `process.stderr` instead of spied on
    // `console.warn`. Asserting the emitted record is stricter than counting calls was.
    const logs = captureLogs();
    try {
      await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(0));
      await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(1_000));
      await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(2_000));

      expect(auditMock.recordCoalescedDenial).toHaveBeenCalledTimes(1);
      expect(auditMock.recordCoalescedDenial).toHaveBeenCalledWith(CTX, "/api/client/tickets", 1, at(0));
      expect(logs.err).toHaveLength(2);
      for (const record of logs.err) {
        expect(record).toMatchObject({
          severity: "WARNING",
          logScope: "client-api",
          event: "unauthenticated_denial_suppressed",
          route: "/api/client/tickets",
          requestId: CTX.requestId,
        });
      }
    } finally {
      logs.restore();
    }
  });

  it("states the collapsed count on the next window's row (this one plus everything suppressed)", async () => {
    const logs = captureLogs();
    try {
      await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(0));
      for (let i = 1; i <= 9; i++) {
        await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(i * 1_000));
      }
      await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(DENIAL_WINDOW_MS));

      expect(auditMock.recordCoalescedDenial).toHaveBeenCalledTimes(2);
      expect(auditMock.recordCoalescedDenial).toHaveBeenLastCalledWith(
        CTX,
        "/api/client/tickets",
        10,
        at(DENIAL_WINDOW_MS),
      );
    } finally {
      logs.restore();
    }
  });

  it("does not swallow a failed ledger write — an unaudited 401 must never be served", async () => {
    auditMock.recordCoalescedDenial.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(0))).rejects.toThrow(
      "ledger unavailable",
    );
  });

  it("keeps two different client IPs on their own windows", async () => {
    const other: RequestContext = { ...CTX, ipAddress: "198.51.100.9" };
    await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(0));
    await recordUnauthenticatedClientDenial(other, "/api/client/tickets", at(0));
    expect(auditMock.recordCoalescedDenial).toHaveBeenCalledTimes(2);
  });
});

describe("the per-route budget (source-address rotation)", () => {
  const rotate = (route: string, n: number, now: Date): number => {
    let recorded = 0;
    for (let i = 0; i < n; i++) {
      // A /64 gives an attacker 2^64 addresses; each one is a fresh per-IP key.
      if (recordDenialAttempt(denialThrottleKey(route, `2001:db8:0:0:0:0:0:${i.toString(16)}`), now).record) {
        recorded++;
      }
    }
    return recorded;
  };

  it("bounds rows per route per window however many source addresses probe", () => {
    expect(rotate("/api/client/tickets", 500, at(0))).toBe(DENIAL_MAX_ROWS_PER_ROUTE_WINDOW);
  });

  it("does not lose the refused denials — the next row in the route states every one of them", () => {
    const probes = DENIAL_MAX_ROWS_PER_ROUTE_WINDOW + 25;
    expect(rotate("/api/client/tickets", probes, at(0))).toBe(DENIAL_MAX_ROWS_PER_ROUTE_WINDOW);

    // The budget refused 25. The first row of the next budget window carries them, so the ledger's
    // count of what happened stays truthful even though 25 rows were never written.
    const next = recordDenialAttempt(denialThrottleKey("/api/client/tickets", "198.51.100.1"), at(DENIAL_WINDOW_MS));
    expect(next.record).toBe(true);
    expect(next.suppressedSinceLastRecord).toBe(25);

    // And consumed exactly once.
    const after = recordDenialAttempt(denialThrottleKey("/api/client/tickets", "198.51.100.2"), at(DENIAL_WINDOW_MS));
    expect(after.record).toBe(true);
    expect(after.suppressedSinceLastRecord).toBe(0);
  });

  it("counts up while the budget is spent, so the log line is not a flat zero", () => {
    rotate("/api/client/tickets", DENIAL_MAX_ROWS_PER_ROUTE_WINDOW, at(0));
    const first = recordDenialAttempt(denialThrottleKey("/api/client/tickets", "198.51.100.7"), at(0));
    const second = recordDenialAttempt(denialThrottleKey("/api/client/tickets", "198.51.100.8"), at(0));
    expect(first.record).toBe(false);
    expect(first.suppressedSinceLastRecord).toBe(1);
    expect(second.record).toBe(false);
    expect(second.suppressedSinceLastRecord).toBe(2);
  });

  it("is per route, so a flood on one route cannot silence another route's first row", () => {
    expect(rotate("/api/client/tickets", 500, at(0))).toBe(DENIAL_MAX_ROWS_PER_ROUTE_WINDOW);
    const other = recordDenialAttempt(denialThrottleKey("/api/client/tickets/[id]", "198.51.100.3"), at(0));
    expect(other.record).toBe(true);
    expect(other.suppressedSinceLastRecord).toBe(0);
  });

  it("is per realm — the machine surface's namespaced keys spend their own budget", () => {
    // integration-auth.ts keys as `integration:${denialThrottleKey(route, ip)}`.
    for (let i = 0; i < 500; i++) {
      recordDenialAttempt(`integration:${denialThrottleKey("/api/ingest/tickets", `203.0.113.${i % 256}`)}`, at(0));
    }
    const client = recordDenialAttempt(denialThrottleKey("/api/ingest/tickets", "203.0.113.9"), at(0));
    expect(client.record).toBe(true);
  });

  it("does not silence an address whose row the budget refused — it never had a window", () => {
    rotate("/api/client/tickets", DENIAL_MAX_ROWS_PER_ROUTE_WINDOW, at(0));
    const key = denialThrottleKey("/api/client/tickets", "198.51.100.4");
    expect(recordDenialAttempt(key, at(0)).record).toBe(false);
    // The budget window rolls; this address records, rather than sitting out a window it never opened.
    expect(recordDenialAttempt(key, at(DENIAL_WINDOW_MS)).record).toBe(true);
  });

  it("still suppresses a key inside its own window even while the route has budget left", () => {
    const key = denialThrottleKey("/api/client/tickets", "198.51.100.5");
    expect(recordDenialAttempt(key, at(0)).record).toBe(true);
    expect(recordDenialAttempt(key, at(1)).record).toBe(false);
    expect(denialThrottleScopeSize()).toBe(1);
  });

  it("an address carrying the separator cannot mint a scope of its own and walk past the budget", () => {
    const route = "/api/client/tickets";
    rotate(route, DENIAL_MAX_ROWS_PER_ROUTE_WINDOW, at(0));
    // Both the sanitising key builder and the first-separator scope rule have to hold for this.
    const crafted = denialThrottleKey(route, `${DENIAL_SCOPE_SEPARATOR}evil${DENIAL_SCOPE_SEPARATOR}1.2.3.4`);
    expect(crafted.indexOf(DENIAL_SCOPE_SEPARATOR)).toBe(route.length);
    expect(recordDenialAttempt(crafted, at(0)).record).toBe(false);
    // Even a raw key built by hand around the separator lands in the route's scope, not a new one.
    expect(recordDenialAttempt(`${route}${DENIAL_SCOPE_SEPARATOR}x${DENIAL_SCOPE_SEPARATOR}y`, at(0)).record).toBe(
      false,
    );
    expect(denialThrottleScopeSize()).toBe(1);
  });

  it("keeps the scope map bounded under route rotation too", () => {
    for (let i = 0; i < DENIAL_MAX_TRACKED_SCOPES + 100; i++) {
      recordDenialAttempt(denialThrottleKey(`/api/client/${i}`, "203.0.113.7"), at(0));
    }
    expect(denialThrottleScopeSize()).toBe(DENIAL_MAX_TRACKED_SCOPES);
  });

  it("holds through the wiring: a rotating flood writes at most the budget in coalesced rows", async () => {
    const logs = captureLogs();
    try {
      for (let i = 0; i < 300; i++) {
        const ctx: RequestContext = { ...CTX, ipAddress: `2001:db8::${i.toString(16)}` };
        await recordUnauthenticatedClientDenial(ctx, "/api/client/tickets", at(0));
      }
      expect(auditMock.recordCoalescedDenial).toHaveBeenCalledTimes(DENIAL_MAX_ROWS_PER_ROUTE_WINDOW);
      expect(logs.err).toHaveLength(300 - DENIAL_MAX_ROWS_PER_ROUTE_WINDOW);
      logs.clear();

      // The next window's first row states the 290 the budget refused, plus itself.
      auditMock.recordCoalescedDenial.mockClear();
      await recordUnauthenticatedClientDenial(CTX, "/api/client/tickets", at(DENIAL_WINDOW_MS));
      expect(auditMock.recordCoalescedDenial).toHaveBeenCalledWith(
        CTX,
        "/api/client/tickets",
        300 - DENIAL_MAX_ROWS_PER_ROUTE_WINDOW + 1,
        at(DENIAL_WINDOW_MS),
      );
    } finally {
      logs.restore();
    }
  });
});
