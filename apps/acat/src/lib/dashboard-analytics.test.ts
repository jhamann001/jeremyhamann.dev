import { describe, it, expect } from "vitest";
import { AcatRecord } from "./types";
import {
  excludeResiduals,
  getCompletionDays,
  rollingWindowSeries,
  avgDaysByWeek,
  cumulativeCompletedAum,
  inflowMetric,
  outflowMetric,
  throughputMetric,
  directionMix,
  avgDaysExResiduals,
  avgDaysAllIn,
  stalledSnapshot,
  periodOverPeriodPct,
  RESIDUAL_TYPE,
} from "./dashboard-analytics";

const FAKE_NOW = new Date("2026-04-15T12:00:00Z").getTime();

function makeRecord(overrides: Partial<AcatRecord>): AcatRecord {
  return {
    id: "TEST",
    clientName: "Test User",
    status: "Completed",
    apexAccountId: "APX-0000",
    lastUpdated: "2026-04-15T00:00:00Z",
    crmDealId: "",
    custodianId: "",
    custodianName: "",
    acatDate: "2026-04-01",
    slackAlerted: false,
    mappingSource: "",
    apexSource: "",
    assets: [],
    ...overrides,
  };
}

describe("excludeResiduals", () => {
  it("filters out records typed Residual Credit", () => {
    const full = makeRecord({ id: "FULL", type: "Full" });
    const partial = makeRecord({ id: "PART", type: "Partial" });
    const residual = makeRecord({ id: "RES", type: RESIDUAL_TYPE });
    const untyped = makeRecord({ id: "NONE", type: undefined });
    const out = excludeResiduals([full, partial, residual, untyped]);
    expect(out.map((r) => r.id)).toEqual(["FULL", "PART", "NONE"]);
  });
});

describe("getCompletionDays", () => {
  it("uses business dates when both present", () => {
    const r = makeRecord({
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-08",
      acatDate: "2026-03-01",
    });
    // Good Friday and the weekend are excluded from Apr 1 → Apr 8.
    expect(getCompletionDays(r)).toBe(4);
  });

  it("falls back to acatDate as the start anchor", () => {
    // ticket: legacy completedDate column dropped. apexCompletionDate is
    // now the only end-anchor; the start anchor still falls back from
    // originalClientRequestDate to acatDate.
    const r = makeRecord({
      originalClientRequestDate: undefined,
      apexCompletionDate: "2026-04-10",
      acatDate: "2026-04-05",
    });
    expect(getCompletionDays(r)).toBe(5);
  });

  it("returns null when end date is missing", () => {
    const r = makeRecord({
      apexCompletionDate: undefined,
    });
    expect(getCompletionDays(r)).toBeNull();
  });
});

describe("avgDaysExResiduals", () => {
  it("excludes residuals from the avg", () => {
    const fast = makeRecord({
      id: "FAST",
      type: RESIDUAL_TYPE,
      originalClientRequestDate: "2026-04-13",
      apexCompletionDate: "2026-04-14",
    });
    const full1 = makeRecord({
      id: "F1",
      type: "Full",
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-11",
    });
    const full2 = makeRecord({
      id: "F2",
      type: "Full",
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-13",
    });

    const result = avgDaysExResiduals([fast, full1, full2]);
    expect(result.avg).toBe(6.5);
    expect(result.min).toBe(6);
    expect(result.max).toBe(7);
    expect(result.count).toBe(2);
  });

  it("returns nulls when no eligible completions", () => {
    const result = avgDaysExResiduals([]);
    expect(result.avg).toBeNull();
    expect(result.min).toBeNull();
    expect(result.max).toBeNull();
  });
});

describe("avgDaysAllIn vs avgDaysExResiduals", () => {
  it("residuals pull the all-in average down", () => {
    const fast = makeRecord({
      id: "FAST",
      type: RESIDUAL_TYPE,
      originalClientRequestDate: "2026-04-14",
      apexCompletionDate: "2026-04-15",
    });
    const slow = makeRecord({
      id: "SLOW",
      type: "Full",
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-15",
    });

    const allIn = avgDaysAllIn([fast, slow]);
    const exRes = avgDaysExResiduals([fast, slow]).avg;
    expect(allIn).toBeLessThan(exRes!);
  });
});

describe("inflowMetric", () => {
  it("counts records initiated in the trailing 30 days", () => {
    const inWindow = makeRecord({
      id: "IN",
      originalClientRequestDate: "2026-04-10",
      statementAmount: 100000,
    });
    const olderWindow = makeRecord({
      id: "PRIOR",
      originalClientRequestDate: "2026-03-10",
      statementAmount: 50000,
    });
    const tooOld = makeRecord({
      id: "OLD",
      originalClientRequestDate: "2025-01-01",
      statementAmount: 999999,
    });

    const m = inflowMetric([inWindow, olderWindow, tooOld], FAKE_NOW);
    expect(m.count).toBe(1);
    expect(m.value).toBe(100000);
    expect(m.countPrior).toBe(1);
    expect(m.valuePrior).toBe(50000);
    expect(m.days).toBe(30);
  });

  it("respects a custom days window", () => {
    const inWindow7 = makeRecord({
      id: "RECENT",
      originalClientRequestDate: "2026-04-12", // 3 days back
      statementAmount: 100000,
    });
    const olderThan14 = makeRecord({
      id: "OLDER",
      originalClientRequestDate: "2026-03-15", // ~31 days back
      statementAmount: 50000,
    });

    const m7 = inflowMetric([inWindow7, olderThan14], FAKE_NOW, 7);
    expect(m7.count).toBe(1);
    expect(m7.days).toBe(7);

    const m30 = inflowMetric([inWindow7, olderThan14], FAKE_NOW, 30);
    expect(m30.count).toBe(1);
    expect(m30.days).toBe(30);
  });

  it("ignores negative (ACAT Out) amounts — those belong to outflow", () => {
    const incoming = makeRecord({
      id: "IN",
      originalClientRequestDate: "2026-04-10",
      statementAmount: 100000,
    });
    const outgoing = makeRecord({
      id: "OUT",
      originalClientRequestDate: "2026-04-11",
      statementAmount: -80000,
    });

    const m = inflowMetric([incoming, outgoing], FAKE_NOW);
    expect(m.count).toBe(1);
    expect(m.value).toBe(100000);
  });
});

describe("outflowMetric", () => {
  it("counts only negative amounts and reports a positive magnitude", () => {
    const incoming = makeRecord({
      id: "IN",
      originalClientRequestDate: "2026-04-10",
      statementAmount: 100000,
    });
    const outWindow = makeRecord({
      id: "OUT",
      originalClientRequestDate: "2026-04-11",
      statementAmount: -80000,
    });
    const outPrior = makeRecord({
      id: "OUT_PRIOR",
      originalClientRequestDate: "2026-03-11",
      statementAmount: -50000,
    });

    const m = outflowMetric([incoming, outWindow, outPrior], FAKE_NOW);
    expect(m.count).toBe(1);
    expect(m.value).toBe(80000); // magnitude, not -80000
    expect(m.countPrior).toBe(1);
    expect(m.valuePrior).toBe(50000);
  });
});

describe("throughputMetric", () => {
  it("only counts Completed records", () => {
    const completed = makeRecord({
      id: "DONE",
      status: "Completed",
      apexCompletionDate: "2026-04-10",
      statementAmount: 200000,
    });
    const submitted = makeRecord({
      id: "OPEN",
      status: "Submitted",
      apexCompletionDate: "2026-04-12",
      statementAmount: 999999,
    });

    const m = throughputMetric([completed, submitted], FAKE_NOW);
    expect(m.count).toBe(1);
    expect(m.value).toBe(200000);
  });
});

describe("rollingWindowSeries", () => {
  it("returns one entry per day for the requested window length", () => {
    const r = makeRecord({ originalClientRequestDate: "2026-04-15" });
    const series = rollingWindowSeries(
      [r],
      (rec) => rec.originalClientRequestDate,
      FAKE_NOW,
      30,
      7
    );
    expect(series.length).toBe(30);
  });

  it("rolling window includes records within trailing windowDays of each day", () => {
    const r = makeRecord({
      originalClientRequestDate: "2026-04-10",
      statementAmount: 1000,
    });
    const series = rollingWindowSeries(
      [r],
      (rec) => rec.originalClientRequestDate,
      FAKE_NOW,
      10,
      7
    );
    // April 10 lies within the 7-day window of April 10..16
    const containing = series.filter((s) => s.count > 0);
    expect(containing.length).toBeGreaterThan(0);
    expect(containing.every((s) => s.value === 1000)).toBe(true);
  });
});

describe("avgDaysByWeek", () => {
  it("bins completed records by completion week and averages days", () => {
    // Apr 6 (Mon) → Apr 12 (Sun) is week 0 if today is Apr 15 (Wed)
    const completedThisWeek = makeRecord({
      type: "Full",
      originalClientRequestDate: "2026-04-01",
      apexCompletionDate: "2026-04-13",
    });
    const series = avgDaysByWeek([completedThisWeek], FAKE_NOW, 4);
    expect(series.length).toBe(4);
    const populated = series.filter((s) => s.count > 0);
    expect(populated.length).toBe(1);
    expect(populated[0].avgDays).toBe(7);
  });

  it("excludes residuals", () => {
    const residualFast = makeRecord({
      type: RESIDUAL_TYPE,
      originalClientRequestDate: "2026-04-13",
      apexCompletionDate: "2026-04-14",
    });
    const series = avgDaysByWeek([residualFast], FAKE_NOW, 2);
    expect(series.every((s) => s.count === 0)).toBe(true);
  });
});

describe("cumulativeCompletedAum", () => {
  it("running total is monotonically non-decreasing", () => {
    const a = makeRecord({
      id: "A",
      apexCompletionDate: "2026-04-05",
      statementAmount: 100000,
    });
    const b = makeRecord({
      id: "B",
      apexCompletionDate: "2026-04-10",
      statementAmount: 50000,
    });
    const series = cumulativeCompletedAum([a, b], FAKE_NOW, 15);
    for (let i = 1; i < series.length; i++) {
      expect(series[i].total).toBeGreaterThanOrEqual(series[i - 1].total);
    }
    expect(series[series.length - 1].total).toBe(150000);
  });

  it("includes pre-window records in the starting total", () => {
    const old = makeRecord({
      id: "OLD",
      apexCompletionDate: "2026-01-01",
      statementAmount: 1000000,
    });
    const series = cumulativeCompletedAum([old], FAKE_NOW, 30);
    expect(series[0].total).toBe(1000000);
    expect(series[series.length - 1].total).toBe(1000000);
  });
});

describe("directionMix", () => {
  it("buckets by direction value with unset fallback", () => {
    const mix = directionMix([
      makeRecord({ id: "1", direction: "In" }),
      makeRecord({ id: "2", direction: "In" }),
      makeRecord({ id: "3", direction: "Out" }),
      makeRecord({ id: "4", direction: undefined }),
    ]);
    expect(mix).toEqual({ incoming: 2, outgoing: 1, unset: 1 });
  });
});

describe("stalledSnapshot", () => {
  // FAKE_NOW = 2026-04-15. Records with no custodian fall back to the
  // default 7-day SLA → warn after 8.75d, high after 12.25d.
  it("counts only non-terminal records past the warn threshold", () => {
    const fresh = makeRecord({
      id: "FRESH",
      status: "Submitted",
      originalClientRequestDate: "2026-04-13", // 2 days → on-track
    });
    const warning = makeRecord({
      id: "WARN",
      status: "Submitted",
      originalClientRequestDate: "2026-04-05", // 10 days → warn (>8.75)
    });
    const high = makeRecord({
      id: "HIGH",
      status: "Submitted",
      originalClientRequestDate: "2026-04-01", // 14 days → high (>12.25)
    });
    const terminalOld = makeRecord({
      id: "DEAD",
      status: "Rejected",
      originalClientRequestDate: "2026-03-01",
    });

    const snap = stalledSnapshot(
      [fresh, warning, high, terminalOld],
      FAKE_NOW
    );
    expect(snap.count).toBe(2);
    expect(snap.over10).toBe(1); // only `high` is past the high tier
    expect(snap.ids).toEqual(expect.arrayContaining(["WARN", "HIGH"]));
  });

  it("uses per-custodian SLA, not a flat threshold", () => {
    // FAKE_NOW = 2026-04-15T12:00:00Z, start = 2026-04-06 → 10 days open.
    // BNY SLA 8d:  warn>10,    high>14   → 10 > 10 is false → on-track.
    // Fid SLA 5d:  warn>6.25, high>8.75 → 10 > 8.75      → high.
    const tda = makeRecord({
      id: "BNY Investments",
      status: "Submitted",
      originalClientRequestDate: "2026-04-06",
      custodian: {
        id: "C1",
        name: "BNY Investments",
        acatFeeAmount: 0,
        avgProcessingDays: 8,
      },
    });
    const fid = makeRecord({
      id: "LKS",
      status: "Submitted",
      originalClientRequestDate: "2026-04-06",
      custodian: {
        id: "C2",
        name: "Fidelity",
        acatFeeAmount: 0,
        avgProcessingDays: 5,
      },
    });
    const snap = stalledSnapshot([tda, fid], FAKE_NOW);
    expect(snap.count).toBe(1);
    expect(snap.ids).toEqual(["LKS"]);
  });
});

describe("periodOverPeriodPct", () => {
  it("computes percent change", () => {
    expect(periodOverPeriodPct(120, 100)).toBe(20);
    expect(periodOverPeriodPct(80, 100)).toBe(-20);
  });

  it("returns null when prior is zero and current is nonzero", () => {
    expect(periodOverPeriodPct(5, 0)).toBeNull();
  });

  it("returns 0 when both are zero", () => {
    expect(periodOverPeriodPct(0, 0)).toBe(0);
  });

  it("keeps the correct sign when prior is negative (net outflow window)", () => {
    // Rising from a net-negative prior to a positive current is an increase.
    expect(periodOverPeriodPct(1_300_000, -930_115)).toBeGreaterThan(0);
    // Falling further negative is a decrease.
    expect(periodOverPeriodPct(-2_000_000, -1_000_000)).toBeLessThan(0);
    // -100 -> -50 is a rise (halving the deficit): (-50 - -100)/100 = +50%.
    expect(periodOverPeriodPct(-50, -100)).toBe(50);
  });
});
