import { describe, expect, it } from "vitest";
import { evaluateRiskFreeFreshness } from "@/lib/data/risk-free-rate-health";

const nowInstant = new Date("2026-07-07T13:30:00Z"); // Tue 09:30 ET
const recentSync = new Date("2026-07-07T11:01:00Z"); // today's 07:01 ET run

describe("evaluateRiskFreeFreshness", () => {
  it("accepts the previous trading day's rate after a recent scheduled run", () => {
    const result = evaluateRiskFreeFreshness({
      maxRateDate: "2026-07-06",
      maxSyncedAt: recentSync,
      rowCount: 2_900,
      nowEt: "2026-07-07",
      nowInstant,
    });
    expect(result).toMatchObject({
      ok: true,
      reason: "ok",
      expectedMinRateDate: "2026-07-06",
      staleByTradingDays: 0,
    });
  });

  it("uses the prior Friday on Monday rather than treating the weekend as stale", () => {
    const monday = new Date("2026-07-13T13:30:00Z");
    const result = evaluateRiskFreeFreshness({
      maxRateDate: "2026-07-10",
      maxSyncedAt: new Date("2026-07-13T11:01:00Z"),
      rowCount: 2_900,
      nowEt: "2026-07-13",
      nowInstant: monday,
    });
    expect(result.ok).toBe(true);
    expect(result.expectedMinRateDate).toBe("2026-07-10");
  });

  it("fails loud when the newest Treasury date is behind", () => {
    const result = evaluateRiskFreeFreshness({
      maxRateDate: "2026-07-01",
      maxSyncedAt: recentSync,
      rowCount: 2_900,
      nowEt: "2026-07-07",
      nowInstant,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_rate_date");
    expect(result.staleByTradingDays).toBe(2);
  });

  it("fails loud on an empty table", () => {
    const result = evaluateRiskFreeFreshness({
      maxRateDate: null,
      maxSyncedAt: null,
      rowCount: 0,
      nowEt: "2026-07-07",
      nowInstant,
    });
    expect(result).toMatchObject({ ok: false, reason: "empty", rowCount: 0 });
  });

  it("detects a missed schedule even when the latest rate date still looks current", () => {
    const result = evaluateRiskFreeFreshness({
      maxRateDate: "2026-07-06",
      maxSyncedAt: new Date(nowInstant.getTime() - 26.5 * 3_600_000),
      rowCount: 2_900,
      nowEt: "2026-07-07",
      nowInstant,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_sync");
    expect(result.syncAgeHours).toBeCloseTo(26.5);
  });

  it("treats a missing sync timestamp as a dead schedule", () => {
    const result = evaluateRiskFreeFreshness({
      maxRateDate: "2026-07-06",
      maxSyncedAt: null,
      rowCount: 2_900,
      nowEt: "2026-07-07",
      nowInstant,
    });
    expect(result.reason).toBe("stale_sync");
  });
});
