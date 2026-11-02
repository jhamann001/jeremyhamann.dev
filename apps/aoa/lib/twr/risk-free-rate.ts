// Risk-free-rate contract + PURE window arithmetic for the TWR performance
// reports' Sharpe ratio.
//
// WHY THIS EXISTS. The Sharpe ratio's risk-free rate used to be a CONSTANT
// hard-coded at two call sites (`rfAnnual: 0.042` in lib/twr/warehouse.ts and
// lib/twr/household.ts, backed by `DEFAULT_RF` in ./engine.ts). Re-basing it took
// a code change + redeploy in two hand-synced places, and by 2026-07-28 the
// disclosed 4.2% was ~30bp stale (the actual 3-month Treasury par yield that day
// was 3.90%). A compliance review flagged it as the ONE manually-maintained
// assumption inside the calculation path. It is now DATA, read from
// mirror.risk_free_rate, which an n8n workflow populates from the US Treasury
// daily par yield curve via /api/ingest/risk-free-rate.
//
// AOA NEVER CALLS TREASURY FROM THE REPORT PATH. Report generation reads only
// STORED rows, so a report is reproducible after the fact — that is the whole
// point of moving the rate out of code. Do not add an outbound HTTP call here.
//
// PERIOD-AVERAGE, NOT SPOT. A Sharpe over a window is an excess-return statistic
// over that window, so it takes the MEAN risk-free rate over the window, not
// today's rate. This is exact rather than approximate: because
//     mean(rᵢ − rf_daily) = mean(rᵢ) − mean(rf_daily)
// subtracting the window-mean rate once (what the engine does) is algebraically
// identical to subtracting each day's own rate and then averaging. It is also
// defensible: "the average 3-month Treasury par yield from A to B" is a figure a
// reader can reproduce from the public source.
//
// MODULE SPLIT (deliberate — the client-imports-server-seam trap): this file is
// PURE and carries NO `server-only` and no Prisma import, so the report
// components and the ingest route can use the contract constants freely. The
// RLS-scoped database read and the two-pass orchestration live in the server-only
// sibling, lib/data/risk-free-rate.ts.

/** The yield-curve column this feed stores (Treasury's "3 Mo"). */
export const RF_TENOR = "3M";
/** `mirror.risk_free_rate.source` written by the n8n Treasury feed. */
export const RF_SOURCE = "us-treasury-daily-par-yield";
/** Human-readable source for the client-facing report disclosure. */
export const RF_SOURCE_LABEL = "U.S. Treasury daily par yield curve rates";
/** Human-readable tenor for the client-facing report disclosure. */
export const RF_TENOR_LABEL = "3-month";

/**
 * Minimum share of the window's business days that must carry a rate before the
 * mean is trusted; below it the Sharpe SUPPRESSES rather than average a gappy
 * series. There is no constant fallback — see ./engine.ts.
 *
 * Why 0.90. `expectedBusinessDays` counts WEEKDAYS, but Treasury does not publish
 * on ~10 federal holidays a year, so even a perfectly-covered year reads
 * ≈ 250/261 ≈ 0.96. The 0.90 floor therefore leaves roughly three weeks of real
 * slack on a one-year window: enough to absorb the holiday calendar plus a short
 * feed outage, but not a multi-week gap. That tolerance is safe because the series
 * is slow-moving — above 90% coverage the sampled mean sits within a basis point
 * or two of the full-window mean, while even a 10bp rf error moves the Sharpe by
 * only ~0.01–0.02 at typical volatilities, at or below the 2-decimal display
 * precision. A multi-week gap, by contrast, can bias the mean materially if rates
 * trended through it — precisely the case that must suppress.
 */
export const MIN_RF_COVERAGE = 0.9;

/** One stored business-day rate. `ratePct` is a PERCENT (3.9 = 3.90%). */
export type RiskFreeObservation = { rateDate: string; ratePct: number };

/** The averaged risk-free rate for one window, plus the coverage evidence the
 *  disclosure and the suppression rule both need. */
export type RiskFreeWindow = {
  /** Window bounds (inclusive), YYYY-MM-DD — the risk sample's first/last day. */
  from: string;
  to: string;
  tenor: string;
  source: string;
  /** Distinct business days in the window that carry a rate. */
  observations: number;
  /** Weekdays in the window (see MIN_RF_COVERAGE for why weekdays, not a
   *  holiday-aware trading calendar). */
  expectedBusinessDays: number;
  /** observations / expectedBusinessDays, clamped to 1. */
  coverage: number;
  /** Mean rate over the window as a PERCENT (3.9 = 3.90%); null when coverage is
   *  below MIN_RF_COVERAGE. */
  meanPct: number | null;
  /** `meanPct` as the DECIMAL the engine wants (0.039 = 3.90%); null likewise. */
  rfAnnual: number | null;
  /** False ⇒ Sharpe suppresses with a coverage footnote. */
  sufficient: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const utcDay = (d: string): number => Date.parse(`${d}T00:00:00Z`);

/**
 * Weekdays (Mon–Fri) in [from, to] inclusive. Closed-form, so a decade-long
 * window costs nothing. 0 when either bound is malformed or from > to.
 */
export function countWeekdays(from: string, to: string): number {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return 0;
  const a = utcDay(from);
  const b = utcDay(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  const days = Math.round((b - a) / 86400000) + 1;
  const fullWeeks = Math.floor(days / 7);
  let count = fullWeeks * 5;
  const startDow = new Date(a).getUTCDay(); // 0 = Sun
  for (let i = fullWeeks * 7; i < days; i++) {
    const dow = (startDow + i) % 7;
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/**
 * PURE: fold stored observations into the window average + coverage verdict.
 *
 * Defensive by construction — rows outside the window, duplicate dates, and
 * non-finite rates are dropped rather than allowed to skew the mean. A missing
 * day is never treated as 0: the ingest route refuses to store a blank Treasury
 * cell as 0.00%, and nothing here invents one either. A day with no rate simply
 * lowers coverage, which is what the suppression rule reads.
 */
export function summarizeRiskFreeWindow(
  rows: RiskFreeObservation[],
  from: string,
  to: string,
  opts: { tenor?: string; source?: string } = {},
): RiskFreeWindow {
  const seen = new Set<string>();
  let sum = 0;
  for (const r of rows) {
    if (!ISO_DATE.test(r.rateDate)) continue;
    if (r.rateDate < from || r.rateDate > to) continue;
    if (typeof r.ratePct !== "number" || !Number.isFinite(r.ratePct)) continue;
    if (seen.has(r.rateDate)) continue;
    seen.add(r.rateDate);
    sum += r.ratePct;
  }
  const observations = seen.size;
  const expectedBusinessDays = countWeekdays(from, to);
  const coverage =
    expectedBusinessDays === 0 ? 0 : Math.min(1, observations / expectedBusinessDays);
  const sufficient = observations > 0 && coverage >= MIN_RF_COVERAGE;
  const meanPct = sufficient ? sum / observations : null;
  return {
    from,
    to,
    tenor: opts.tenor ?? RF_TENOR,
    source: opts.source ?? RF_SOURCE,
    observations,
    expectedBusinessDays,
    coverage,
    meanPct,
    rfAnnual: meanPct === null ? null : meanPct / 100,
    sufficient,
  };
}
