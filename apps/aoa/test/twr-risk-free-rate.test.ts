import { describe, it, expect, vi, beforeEach } from "vitest";

// rf-as-data: the risk-free rate that feeds the Sharpe ratio is no longer a
// hard-coded constant. This suite covers the three moving parts:
//   1. the PURE window arithmetic (mean + coverage) — lib/twr/risk-free-rate.ts
//   2. the RLS-scoped read + two-pass orchestration — lib/data/risk-free-rate.ts
//   3. Sharpe SUPPRESSION on insufficient coverage (never a constant fallback)

import {
  MIN_RF_COVERAGE,
  RF_SOURCE,
  RF_TENOR,
  countWeekdays,
  summarizeRiskFreeWindow,
  type RiskFreeObservation,
} from "@/lib/twr/risk-free-rate";

// `server-only` throws outside an RSC bundle; `@/lib/rls` would pull in the real
// Prisma client. Both are stubbed. NOTE (partial-mock trap): lib/rls's only
// runtime export used here is withUserScope — `Identity` is a type, erased at
// compile time — so this factory is COMPLETE, not partial.
vi.mock("server-only", () => ({}));
const { withUserScopeSpy } = vi.hoisted(() => ({ withUserScopeSpy: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));

import { computeTwrWithMarketRf, riskFreeWindow } from "@/lib/data/risk-free-rate";
import { computeTwr, type TwrEngineInput } from "@/lib/twr/engine";

const ID = { role: "ADVISOR", email: "a@example.com" };

/** Every weekday in [from, to] carrying `ratePct` — a fully-covered window. */
function weekdaySeries(from: string, to: string, ratePct: number | ((i: number) => number)) {
  const out: RiskFreeObservation[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  let t = Date.parse(`${from}T00:00:00Z`);
  let i = 0;
  while (t <= end) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push({
        rateDate: d.toISOString().slice(0, 10),
        ratePct: typeof ratePct === "number" ? ratePct : ratePct(i),
      });
      i++;
    }
    t += 86400000;
  }
  return out;
}

describe("countWeekdays (pure)", () => {
  it("counts Mon–Fri inclusive, across partial weeks", () => {
    // 2026-01-05 is a Monday.
    expect(countWeekdays("2026-01-05", "2026-01-09")).toBe(5); // Mon–Fri
    expect(countWeekdays("2026-01-05", "2026-01-11")).toBe(5); // + Sat/Sun
    expect(countWeekdays("2026-01-05", "2026-01-12")).toBe(6); // + next Mon
    expect(countWeekdays("2026-01-10", "2026-01-11")).toBe(0); // weekend only
    expect(countWeekdays("2026-01-05", "2026-01-05")).toBe(1); // single weekday
  });

  it("a full calendar year has ~261 weekdays (the coverage denominator)", () => {
    const n = countWeekdays("2025-07-01", "2026-06-30");
    expect(n).toBeGreaterThan(255);
    expect(n).toBeLessThan(266);
  });

  it("is 0 for a reversed or malformed window (never negative, never throws)", () => {
    expect(countWeekdays("2026-01-09", "2026-01-05")).toBe(0);
    expect(countWeekdays("not-a-date", "2026-01-05")).toBe(0);
    expect(countWeekdays("2026-1-5", "2026-01-09")).toBe(0);
  });
});

describe("summarizeRiskFreeWindow (pure) — mean + coverage", () => {
  const FROM = "2025-07-01";
  const TO = "2026-06-30";

  it("full coverage → the arithmetic mean, as percent AND as the engine's decimal", () => {
    const rows = weekdaySeries(FROM, TO, (i) => (i % 2 === 0 ? 3.8 : 4.0));
    const w = summarizeRiskFreeWindow(rows, FROM, TO);
    expect(w.observations).toBe(rows.length);
    expect(w.coverage).toBeCloseTo(1, 10);
    expect(w.sufficient).toBe(true);
    expect(w.meanPct).toBeCloseTo(
      rows.reduce((s, r) => s + r.ratePct, 0) / rows.length,
      10,
    );
    // rfAnnual is the DECIMAL form the engine consumes: 3.90% → 0.039.
    expect(w.rfAnnual).toBeCloseTo((w.meanPct as number) / 100, 12);
    expect(w.from).toBe(FROM);
    expect(w.to).toBe(TO);
    expect(w.tenor).toBe(RF_TENOR);
    expect(w.source).toBe(RF_SOURCE);
  });

  it("real-world holiday gaps (~96% coverage) still average — that is what the 0.90 floor is for", () => {
    const all = weekdaySeries(FROM, TO, 3.9);
    const rows = all.filter((_, i) => i % 26 !== 0); // drop ~1 in 26 ≈ 96% left
    const w = summarizeRiskFreeWindow(rows, FROM, TO);
    expect(w.coverage).toBeGreaterThan(MIN_RF_COVERAGE);
    expect(w.sufficient).toBe(true);
    expect(w.meanPct).toBeCloseTo(3.9, 10);
  });

  it("PARTIAL coverage below the floor → meanPct/rfAnnual null (suppress, never a constant)", () => {
    const all = weekdaySeries(FROM, TO, 3.9);
    const rows = all.slice(0, Math.floor(all.length * 0.7)); // ~70%
    const w = summarizeRiskFreeWindow(rows, FROM, TO);
    expect(w.observations).toBe(rows.length);
    expect(w.coverage).toBeLessThan(MIN_RF_COVERAGE);
    expect(w.sufficient).toBe(false);
    expect(w.meanPct).toBeNull();
    expect(w.rfAnnual).toBeNull();
    // The evidence for the footnote survives even though the rate does not.
    expect(w.expectedBusinessDays).toBeGreaterThan(w.observations);
  });

  it("coverage exactly at the floor is SUFFICIENT (>=, not >)", () => {
    // A 5-weekday window with 0 missing = 1.0; construct exactly 0.9 with 10/…
    const from = "2026-01-05"; // Monday
    const to = "2026-01-30"; // 20 weekdays
    const all = weekdaySeries(from, to, 4.0);
    expect(all).toHaveLength(20);
    const at90 = summarizeRiskFreeWindow(all.slice(0, 18), from, to); // 18/20 = 0.90
    expect(at90.coverage).toBeCloseTo(0.9, 10);
    expect(at90.sufficient).toBe(true);
    const at85 = summarizeRiskFreeWindow(all.slice(0, 17), from, to); // 0.85
    expect(at85.sufficient).toBe(false);
    expect(at85.meanPct).toBeNull();
  });

  it("ZERO coverage → nulls, coverage 0, no division by zero", () => {
    const w = summarizeRiskFreeWindow([], FROM, TO);
    expect(w.observations).toBe(0);
    expect(w.coverage).toBe(0);
    expect(w.sufficient).toBe(false);
    expect(w.meanPct).toBeNull();
    expect(w.rfAnnual).toBeNull();
    expect(Number.isFinite(w.expectedBusinessDays)).toBe(true);
  });

  it("a missing day is NEVER treated as 0.00% — it lowers coverage instead", () => {
    // 5 weekdays; only 3 have a rate, all 4.00. Coverage 0.6 < floor → suppress.
    const from = "2026-01-05";
    const to = "2026-01-09";
    const partial = summarizeRiskFreeWindow(
      [
        { rateDate: "2026-01-05", ratePct: 4 },
        { rateDate: "2026-01-06", ratePct: 4 },
        { rateDate: "2026-01-07", ratePct: 4 },
      ],
      from,
      to,
    );
    expect(partial.observations).toBe(3);
    expect(partial.sufficient).toBe(false);
    // Had the two blanks been stored as 0.00, the mean would have been 2.40%.
    // Nothing here can produce that: the mean is over PRESENT days only.
    const full = summarizeRiskFreeWindow(weekdaySeries(from, to, 4), from, to);
    expect(full.meanPct).toBeCloseTo(4, 10);
    expect(full.meanPct).not.toBeCloseTo(2.4, 1);
  });

  it("drops out-of-window rows, duplicate dates, malformed dates and non-finite rates", () => {
    const from = "2026-01-05";
    const to = "2026-01-09";
    const w = summarizeRiskFreeWindow(
      [
        { rateDate: "2026-01-05", ratePct: 4 },
        { rateDate: "2026-01-05", ratePct: 99 }, // duplicate → ignored (first wins)
        { rateDate: "2026-01-06", ratePct: 4 },
        { rateDate: "2026-01-07", ratePct: 4 },
        { rateDate: "2026-01-08", ratePct: 4 },
        { rateDate: "2026-01-09", ratePct: 4 },
        { rateDate: "2026-02-02", ratePct: 99 }, // after `to` → ignored
        { rateDate: "2025-12-31", ratePct: 99 }, // before `from` → ignored
        { rateDate: "garbage", ratePct: 4 }, // malformed → ignored
        { rateDate: "2026-01-12", ratePct: Number.NaN }, // non-finite → ignored
      ],
      from,
      to,
    );
    expect(w.observations).toBe(5);
    expect(w.meanPct).toBeCloseTo(4, 10); // the 99s never touched the mean
  });
});

describe("riskFreeWindow — RLS-scoped read seam", () => {
  // BRACED body on purpose: `() => withUserScopeSpy.mockReset()` would implicitly
  // RETURN the mock, and Vitest treats a function returned from beforeEach as a
  // teardown callback — it would then invoke the spy with no arguments after every
  // test, running the mock implementation with `fn` undefined.
  beforeEach(() => {
    withUserScopeSpy.mockReset();
  });

  it("queries mirror.risk_free_rate for the tenor + window and coerces the numeric", async () => {
    const queryRaw = vi.fn(async (..._a: unknown[]) => [
      { rate_date: "2026-01-05", rate_pct: "3.90" }, // Decimal → string at runtime
      { rate_date: "2026-01-06", rate_pct: "3.88" },
      { rate_date: "2026-01-07", rate_pct: "3.90" },
      { rate_date: "2026-01-08", rate_pct: "3.92" },
      { rate_date: "2026-01-09", rate_pct: "3.90" },
    ]);
    withUserScopeSpy.mockImplementation(
      async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: queryRaw }),
    );

    const w = await riskFreeWindow(ID, "2026-01-05", "2026-01-09");
    expect(withUserScopeSpy).toHaveBeenCalledOnce();
    expect(withUserScopeSpy.mock.calls[0][0]).toEqual(ID); // caller identity, RLS-scoped
    const sql = (queryRaw.mock.calls[0]![0] as unknown as TemplateStringsArray).join(" ");
    expect(sql).toContain("FROM mirror.risk_free_rate");
    expect(sql).toContain("ORDER BY rate_date");
    // Values are bound as parameters, never concatenated.
    expect(queryRaw.mock.calls[0]!.slice(1)).toEqual([RF_TENOR, "2026-01-05", "2026-01-09"]);
    expect(w.observations).toBe(5);
    expect(w.meanPct).toBeCloseTo(3.9, 10);
    expect(w.rfAnnual).toBeCloseTo(0.039, 12);
  });

  it("a read failure DEGRADES to zero coverage (never throws, never a constant)", async () => {
    withUserScopeSpy.mockRejectedValue(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation((..._a: unknown[]) => {});
    const w = await riskFreeWindow(ID, "2026-01-05", "2026-01-09");
    expect(w.observations).toBe(0);
    expect(w.rfAnnual).toBeNull();
    expect(w.sufficient).toBe(false);
    // Counts-free marker only — no dates, no values.
    expect(err.mock.calls[0]![0]).not.toContain("2026-01-05");
    err.mockRestore();
  });
});

describe("computeTwrWithMarketRf — two-pass wiring + Sharpe suppression", () => {
  const addDays = (d: string, n: number): string => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };

  /** A Sharpe-eligible series: 90 counted returns spread over `totalDays`. */
  function input(totalDays: number): TwrEngineInput {
    const start = "2025-01-01";
    const rets = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 0.002 : 0));
    let mv = 100000;
    const daily = [{ date: start, mv, externalCf: 0 }];
    rets.forEach((r, i) => {
      mv = mv * (1 + r);
      daily.push({
        date: addDays(start, Math.round(((i + 1) * totalDays) / rets.length)),
        mv,
        externalCf: 0,
      });
    });
    return {
      daily,
      asOf: daily[daily.length - 1].date,
      costBasis: 100000,
      costBasisAsOf: start,
      positionsMv: mv,
      dividendTtm: 0,
      advisoryFeeNet: 0,
      realizedSt: null,
      realizedLt: null,
    };
  }

  function mockRows(rows: { rate_date: string; rate_pct: string }[]) {
    withUserScopeSpy.mockImplementation(
      async (_id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: async () => rows }),
    );
  }

  /** Every weekday in the window at a constant rate — full coverage. */
  const fullCoverage = (from: string, to: string, pct: string) =>
    weekdaySeries(from, to, Number(pct)).map((r) => ({
      rate_date: r.rateDate,
      rate_pct: pct,
    }));

  // BRACED body on purpose: `() => withUserScopeSpy.mockReset()` would implicitly
  // RETURN the mock, and Vitest treats a function returned from beforeEach as a
  // teardown callback — it would then invoke the spy with no arguments after every
  // test, running the mock implementation with `fn` undefined.
  beforeEach(() => {
    withUserScopeSpy.mockReset();
  });

  it("averages over the RISK SAMPLE window and feeds it to the Sharpe", async () => {
    const inp = input(450);
    const probe = computeTwr({ ...inp, rfAnnual: null });
    const from = probe.risk.sampleFrom as string;
    const to = probe.risk.sampleTo as string;
    mockRows(fullCoverage(from, to, "3.90"));

    const { result, rf } = await computeTwrWithMarketRf(ID, inp);
    // The window queried is exactly the sample the risk stats are computed over.
    expect(rf?.from).toBe(from);
    expect(rf?.to).toBe(to);
    expect(rf?.meanPct).toBeCloseTo(3.9, 10);
    expect(result.rfAnnual).toBeCloseTo(0.039, 12);
    // …and the Sharpe now reflects the fed rate, not the old 4.2% constant.
    expect(result.risk.sharpe).not.toBeNull();
    const at042 = computeTwr({ ...inp, rfAnnual: 0.042 });
    expect(result.risk.sharpe).not.toBeCloseTo(at042.risk.sharpe as number, 6);
    // Non-risk output is untouched by the rate.
    expect(result.twrSinceInception).toBeCloseTo(probe.twrSinceInception, 12);
  });

  it("INSUFFICIENT coverage → Sharpe null with coverage evidence, NO constant fallback", async () => {
    const inp = input(450);
    const probe = computeTwr({ ...inp, rfAnnual: null });
    const all = fullCoverage(
      probe.risk.sampleFrom as string,
      probe.risk.sampleTo as string,
      "3.90",
    );
    mockRows(all.slice(0, Math.floor(all.length * 0.5))); // ~50% coverage

    const { result, rf } = await computeTwrWithMarketRf(ID, inp);
    expect(rf?.sufficient).toBe(false);
    expect(rf?.rfAnnual).toBeNull();
    expect(result.rfAnnual).toBeNull();
    expect(result.risk.sharpe).toBeNull();
    // Suppression is attributable to the RATE: the sample itself was eligible.
    expect(result.risk.sharpeEligible).toBe(true);
    // Volatility (which needs no rate) is NOT suppressed by a rate gap.
    expect(result.risk.vol).not.toBeNull();
  });

  it("ZERO stored rates → Sharpe null (the state before the feed's first run)", async () => {
    mockRows([]);
    const { result, rf } = await computeTwrWithMarketRf(ID, input(450));
    expect(rf?.observations).toBe(0);
    expect(result.risk.sharpe).toBeNull();
    expect(result.rfAnnual).toBeNull();
  });

  it("skips the rate lookup entirely when the Sharpe could not show anyway (sub-year)", async () => {
    const { result, rf } = await computeTwrWithMarketRf(ID, input(364));
    expect(result.risk.periodBasis).toBe("cumulative");
    expect(result.risk.sharpe).toBeNull();
    // rf null ⇒ "the rate was not the reason" — and no DB round-trip was spent.
    expect(rf).toBeNull();
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });
});
