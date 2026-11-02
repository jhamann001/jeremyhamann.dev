import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateAumFreshness } from "@/lib/data/feed-health";

// Pure decision-function cases — no DB, no clock. `nowInstant` only ages
// `maxSyncedAt`, so any instant works; we pin `nowEt` to drive the calendar.

// A Tuesday: previous trading day is Monday 2026-07-06 (T-1).
const NOW_TUE = "2026-07-07";
const PREV_TUE = "2026-07-06";
// A Monday: previous trading day is Friday 2026-07-10 (the T-3 case).
const NOW_MON = "2026-07-13";
const PREV_MON = "2026-07-10";

const nowInstant = new Date("2026-07-07T11:00:00Z");
const recentSync = new Date("2026-07-07T10:00:00Z"); // 1h old

describe("evaluateAumFreshness", () => {
  it("counts nullable legacy lifecycle rows as open until explicitly CLOSED", () => {
    const source = readFileSync("lib/data/feed-health.ts", "utf8");
    expect(source).toContain("account_status IS DISTINCT FROM 'CLOSED'");
    expect(source).not.toContain("account_status <> 'CLOSED'");
  });
  it("fresh: maxAsOf === previousTradingDay → ok", () => {
    const r = evaluateAumFreshness({
      maxAsOf: PREV_TUE,
      maxSyncedAt: recentSync,
      rowCount: 100,
      nowEt: NOW_TUE,
      nowInstant,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.expectedMinAsOf).toBe(PREV_TUE);
    expect(r.staleByTradingDays).toBe(0);
  });

  it("Monday case: Friday as_of on a Monday → ok (T-3), not stale", () => {
    const r = evaluateAumFreshness({
      maxAsOf: PREV_MON,
      maxSyncedAt: recentSync,
      rowCount: 100,
      nowEt: NOW_MON,
      nowInstant,
    });
    expect(r.ok).toBe(true);
    expect(r.expectedMinAsOf).toBe(PREV_MON);
  });

  it("stale_as_of: older as_of → not ok with correct staleByTradingDays", () => {
    // maxAsOf Wed 2026-07-01, expected Mon 2026-07-06 → 2 trading days behind
    // (Jul 2 Thu, Jul 6 Mon; Jul 3 holiday + weekend skipped).
    const r = evaluateAumFreshness({
      maxAsOf: "2026-07-01",
      maxSyncedAt: recentSync,
      rowCount: 100,
      nowEt: NOW_TUE,
      nowInstant,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale_as_of");
    expect(r.staleByTradingDays).toBe(2);
    expect(r.maxAsOf).toBe("2026-07-01");
  });

  it("empty: rowCount 0 → not ok, reason empty", () => {
    const r = evaluateAumFreshness({
      maxAsOf: null,
      maxSyncedAt: null,
      rowCount: 0,
      nowEt: NOW_TUE,
      nowInstant,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty");
    expect(r.staleByTradingDays).toBe(0);
  });

  it("stale_sync: as_of fresh but sync older than threshold → not ok", () => {
    const staleSync = new Date(nowInstant.getTime() - 31 * 3_600_000); // 31h
    const r = evaluateAumFreshness({
      maxAsOf: PREV_TUE, // as_of looks current
      maxSyncedAt: staleSync,
      rowCount: 100,
      nowEt: NOW_TUE,
      nowInstant,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale_sync");
    expect(r.syncAgeHours).toBeGreaterThan(30);
  });

  it("stale_sync respects a custom syncMaxAgeHours override", () => {
    const sync = new Date(nowInstant.getTime() - 10 * 3_600_000); // 10h
    // Under the default 30h this is ok; with a 6h ceiling it is stale_sync.
    expect(
      evaluateAumFreshness({
        maxAsOf: PREV_TUE,
        maxSyncedAt: sync,
        rowCount: 100,
        nowEt: NOW_TUE,
        nowInstant,
      }).ok,
    ).toBe(true);
    const r = evaluateAumFreshness({
      maxAsOf: PREV_TUE,
      maxSyncedAt: sync,
      rowCount: 100,
      nowEt: NOW_TUE,
      nowInstant,
      syncMaxAgeHours: 6,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale_sync");
  });

  it("stale_as_of takes precedence over a coincidentally-fresh sync", () => {
    const r = evaluateAumFreshness({
      maxAsOf: "2026-07-01",
      maxSyncedAt: recentSync, // sync is fine…
      rowCount: 100,
      nowEt: NOW_TUE,
      nowInstant,
    });
    expect(r.reason).toBe("stale_as_of"); // …but the data date is behind
  });

  it("fails when any open account or corporate account lacks a complete current row", () => {
    const r = evaluateAumFreshness({
      maxAsOf: PREV_TUE, maxSyncedAt: recentSync, rowCount: 132,
      nowEt: NOW_TUE, nowInstant, openAccountCount: 100,
      currentOpenAccountCount: 99, corporateCurrentCount: 4,
      missingCloseDateCount: 0, reconciliationFailureCount: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("incomplete_coverage");
  });

  it("fails when retained source rows do not match the committed expected cardinality", () => {
    const r = evaluateAumFreshness({
      maxAsOf: PREV_TUE, maxSyncedAt: recentSync, rowCount: 99,
      expectedRowCount: 100, nowEt: NOW_TUE, nowInstant,
      openAccountCount: 95, currentOpenAccountCount: 95,
      corporateCurrentCount: 4, missingCloseDateCount: 0,
      reconciliationFailureCount: 0,
    });
    expect(r.reason).toBe("incomplete_coverage");
  });

  it("fails on missing close-date provenance or a reconciliation failure", () => {
    const base = {
      maxAsOf: PREV_TUE, maxSyncedAt: recentSync, rowCount: 132,
      nowEt: NOW_TUE, nowInstant, openAccountCount: 100,
      currentOpenAccountCount: 100, corporateCurrentCount: 4,
    };
    expect(evaluateAumFreshness({ ...base, missingCloseDateCount: 1 }).reason)
      .toBe("close_date_missing");
    expect(evaluateAumFreshness({ ...base, reconciliationFailureCount: 1 }).reason)
      .toBe("reconciliation_failed");
  });

  it("throws (fail-loud) for a nowEt in an unsupported year → route maps to 500", () => {
    expect(() =>
      evaluateAumFreshness({
        maxAsOf: "2029-01-12",
        maxSyncedAt: recentSync,
        rowCount: 100,
        nowEt: "2029-01-16",
        nowInstant,
      }),
    ).toThrow(/2029/);
  });
});
