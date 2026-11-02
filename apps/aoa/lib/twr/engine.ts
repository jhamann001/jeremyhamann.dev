// Cedar Ridge Wealth — account-level daily Time-Weighted Return (TWR) engine.
//
// PURE compute. No network, no DB, no I/O.
//
// PROVENANCE (historically true, and the reason the fixtures pin what they pin):
// ported byte-faithfully from the approved standalone generator
// (twr_engine.mjs, itself ported from the approved report_engine.js), so this
// reproduces the approved Whitcombe/Ashdown/Thornbury/Marlowe report math exactly.
//
// THIS IS NOW THE ONLY IMPLEMENTATION. The standalone generator was RETIRED on
// 2026-07-29 (archived at ~/.claude/skills/twr-report.retired/, see its
// RETIRED.md) precisely because it had diverged: it computed the unrealized %
// unconditionally and so would print a runaway or Infinity%/NaN% figure on a
// $0-basis IRA/ACAT account where this engine correctly suppresses it
// (basisIncomplete / UNREALIZED_PCT_MATERIALITY below). There is therefore NO
// remaining "keep the two engines in sync" obligation — do not re-create one.
// The approved reference inputs live on as test/fixtures/{marlowe,whitcombe}
// .input.json and remain the verification anchor for any change here.
//
// Methodology (Cedar Ridge standard — described in full in
// docs/compliance/performance-report-methodology.md; the original spec text is
// archived at ~/.claude/skills/twr-report.retired/SKILL.archived.md):
//   Daily TWR: r_t = (MV_t - CF_t - MV_{t-1}) / MV_{t-1}, geometrically linked.
//   MV = total_equity. NET OF FEES (the advisory fee is already inside
//   total_equity — it is a line item, not an external flow). Reported per
//   calendar quarter (four most recent COMPLETED quarters as of as-of), YTD, and
//   since inception (first funded day). Annualized = (1+TWR)^(365/cal_days)-1.
//   External flows are neutralized; in-kind ($0-journal) dates neutralize the
//   whole day's equity step. NO benchmark (household-located sleeve). The
//   growth-of-$100k curve is the COMPOUNDED daily-return index (net of fees),
//   NOT MV/beginning-MV, so it is correct for in-kind-funded sleeves.

export const TWR_FUNDED_THRESHOLD = 1000;
const THRESH = TWR_FUNDED_THRESHOLD; // tiny-denominator guard: never divide by a base < $1k

/** True when an in-kind journal is the step that moves a funded account into
 * its closing cash stub. Requiring journal evidence avoids treating every
 * legitimately small ending account as a consolidation. */
export function hasClosingInKindTransfer(
  series: readonly { date: string; mv: number }[],
  flowDates: ReadonlySet<string>,
): boolean {
  return series.some(
    (point, index) =>
      index > 0 &&
      series[index - 1].mv > TWR_FUNDED_THRESHOLD &&
      point.mv <= TWR_FUNDED_THRESHOLD &&
      flowDates.has(point.date),
  );
}
// NO DEFAULT RISK-FREE RATE — deliberately. `DEFAULT_RF = 0.042` and
// `DEFAULT_RF_AS_OF = "2026-07"` (risk-stats v2, C5) were REMOVED. They were the
// one manually-maintained assumption inside the calculation path: re-basing the
// rate meant a code change + redeploy at two hand-synced call sites, and by
// 2026-07-28 the disclosed 4.2% was ~30bp stale (the actual 3-month Treasury par
// yield that day was 3.90%). A compliance review flagged it. rf is now DATA — the
// MEAN 3-month Treasury par yield over the risk window, read from
// mirror.risk_free_rate (see lib/twr/risk-free-rate.ts).
//
// A fallback constant is NOT reintroduced here: it would silently resurrect
// exactly the staleness we are eliminating. An ABSENT rf ⇒ Sharpe SUPPRESSES
// (null), the same posture the 12-month (C1) and min-observation (C4) rules
// already take. Never a constant, never a guess.
// Minimum counted (post-filter) daily returns required for vol/Sharpe — fewer
// than this is not a reliable risk estimate (risk-stats v2, C4).
export const MIN_RISK_OBS = 60;

/** Expected empty-state signal: the series never produced a funded daily return. */
export class TwrInsufficientHistoryError extends Error {
  constructor() {
    super("No funded daily returns — check the daily series / funding date.");
    this.name = "TwrInsufficientHistoryError";
  }
}

// Unrealized-return materiality guard. When an account has ANY open lot with
// $0/missing cost basis (extremely common for IRAs — brokers aren't required to
// track IRA basis, and ACAT'd-in lots routinely import with $0 basis) the
// recorded basis is understated, so (MV − basis) / basis overstates the
// unrealized %. We only SUPPRESS the % when it is also implausibly high (> this
// threshold) — a single trivial $0-basis lot in an otherwise well-tracked
// account must NOT hide a legitimate ~20% figure. 150% is far above any
// plausible sleeve-level unrealized return but well below the runaway figures a
// missing large-position basis produces (e.g. Aaliyah Bartoletti's Roth read +675%).
const UNREALIZED_PCT_MATERIALITY = 150;

/** One day of the balance series. `externalCf` is the signed net external cash
 *  flow that day (deposits +, withdrawals −); internal activity stays in MV. */
export type TwrDailyPoint = {
  date: string; // YYYY-MM-DD
  mv: number; // total_equity
  externalCf: number; // signed external flow
};

export type TwrEngineInput = {
  daily: TwrDailyPoint[];
  asOf: string; // YYYY-MM-DD
  /** Annualized risk-free rate for Sharpe, as a DECIMAL (0.039 = 3.90%). This is
   *  the MEAN rate over the report's risk window, supplied by the caller from
   *  mirror.risk_free_rate (lib/twr/risk-free-rate.ts). There is NO default:
   *  omitted/null ⇒ Sharpe is suppressed rather than computed against a stale
   *  constant. */
  rfAnnual?: number | null;
  /** In-kind journal dates: the whole equity step that day is an external
   *  in-kind flow (the day's market return neutralizes to 0). */
  flowDates?: string[];
  /** Single-day snapshot-glitch repairs: date → corrected MV. */
  glitchFix?: Record<string, number>;
  /** Count of deterministic source-balance repairs applied by the data layer.
   *  Stored in the immutable result for audit provenance; never client-entered. */
  balanceRepairCount?: number;
  /** Change-in-Value framing: begin the waterfall at $0 and fold the first
   *  funded balance into "Net contributions" (in-kind-funded sleeves). */
  beginningZero?: boolean;
  /** Label the contributions line "Net contributions (in-kind)". */
  contribInkind?: boolean;
  // ---- analytics scalars (as of `asOf`) ----
  costBasis: number;
  costBasisAsOf: string;
  /** Count of open lots with $0/missing recorded cost basis (card 6471,
   *  cost_basis <= 0). When > 0 the recorded `costBasis` is understated, so the
   *  unrealized % is unreliable. Defaults to 0 (complete basis) when a caller
   *  doesn't supply it, so existing callers/tests are unaffected. */
  zeroBasisLots?: number;
  positionsMv: number;
  dividendTtm: number;
  advisoryFeeNet: number; // FEE debits netted against reimbursement CREDITs (>= 0)
  realizedSt: number | null; // null → single "Realized G/L — YTD: —" row
  realizedLt: number | null;
};

export type TwrReturnCell = { label: string; value: number | null };
export type TwrGrowthPoint = { label: string; value: number };
export type TwrWaterfallRow = {
  label: string;
  value: number;
  tone: "" | "pos" | "neg" | "tot";
};

// risk-stats v2 (see docs/blueprints/twr-risk-stats-v2.md): the risk block's
// v2 semantics. The RETURN table / growth / waterfall / cashflow are untouched.
export type TwrRisk = {
  /** Cumulative since-inception TWR when periodBasis === "cumulative"
   *  (calDays < 365), annualized ((1+cum)^(365/calDays)−1) when "annualized".
   *  Always a number — under 12 months it IS the cumulative TWR (identical to
   *  twrSinceInception), relabeled. */
  annReturn: number;
  /** "annualized" when calDays >= 365, else "cumulative" (C1: no sub-year
   *  annualization). */
  periodBasis: "annualized" | "cumulative";
  /** Annualized volatility over the FILTERED risk sample (neutralized in-kind
   *  days excluded); null under the MIN_RISK_OBS floor (C4). */
  vol: number | null;
  /** Daily-native Sharpe over the filtered sample; null under 12 months (C1),
   *  under the MIN_RISK_OBS floor (C4), when the sample stdev is 0, or when no
   *  risk-free rate was supplied (rf-as-data: no fallback constant). */
  sharpe: number | null;
  /** True when everything EXCEPT the risk-free rate permits a Sharpe: >= 12
   *  months (C1), >= MIN_RISK_OBS post-filter observations (C4), and a non-zero
   *  sample stdev. Exposed so the rf resolver can decide whether a rate lookup is
   *  even needed, and so the disclosure can tell "Sharpe omitted because the
   *  history is short" apart from "Sharpe omitted because the rate feed has a
   *  gap" — WITHOUT re-implementing the engine's gating conditions elsewhere. */
  sharpeEligible: boolean;
  /** First / last date of the FILTERED risk sample (the days the vol and Sharpe
   *  are actually computed over), YYYY-MM-DD; both null when the sample is empty.
   *  This is the window the risk-free rate must be averaged over — see
   *  lib/twr/risk-free-rate.ts. It is NOT the same as [inception, endDate]:
   *  neutralized in-kind days at either edge, and rows below the $1k denominator
   *  guard, are not part of the sample. */
  sampleFrom: string | null;
  sampleTo: string | null;
  /** <= 0 — unchanged (curve-based, full compounding; descriptive). */
  maxDrawdown: number;
  /** Null only when the filtered sample is empty (degenerate all-neutralized). */
  bestDay: number | null;
  worstDay: number | null;
  /** Percent of the FILTERED sample; null only when the sample is empty. */
  positiveDays: number | null;
  /** C2: counted daily returns whose whole equity step was valued as in-kind
   *  flow (step 3) — excluded from vol/positiveDays/best/worst; still
   *  compounded into cum/monthly/curve. */
  neutralizedDays: number;
  /** Counted daily returns post-filter (drives the C4 floor + tests). */
  riskSampleSize: number;
};

export type TwrAnalytics = {
  currentValue: number;
  costBasis: number;
  costBasisAsOf: string;
  unrealizedGl: number;
  // null when the denominator is 0/absent (e.g. ACAT'd-in lots read $0 cost
  // basis, or a not-yet-funded sleeve has $0 ending value): never fabricate a
  // percent from a 0 base — the report renders these as "—". A real 0% (numerator
  // 0 over a non-zero base) stays 0, not null.
  unrealizedPct: number | null;
  // True when one or more open lots have $0/missing recorded cost basis AND that
  // materially distorts the unrealized % (total basis 0 → pct null, or the raw
  // pct exceeds the materiality threshold). In that state `unrealizedPct` is
  // forced to null and the report renders the % as "—" with an informational
  // footnote — the dollar `unrealizedGl` is still shown. This is a calm,
  // expected condition (common for IRAs), NOT an error.
  basisIncomplete: boolean;
  /** A closed/dust account still carries positive open-lot basis. The lot
   *  snapshot no longer reconciles to the ending account after an in-kind
   *  closing transfer, so basis and unrealized dollar/percent figures are
   *  omitted rather than presented as a false near-100% loss. */
  basisUnreconciled?: boolean;
  realizedSt: number | null;
  realizedLt: number | null;
  dividendTtm: number;
  dividendYield: number | null;
  advisoryFee: number;
};

/** External cash-flow summary for the report's "Cash Flow" block. Sums the
 *  SAME effective daily external flows the TWR neutralizes (in-kind journal
 *  days are already valued as the day's equity step), split by sign.
 *  Withdrawals are SIGNED (<= 0). Since-inception matches the waterfall's
 *  "Net contributions" convention exactly: flows strictly after the inception
 *  day, plus — under beginningZero framing — the inception-day funded balance
 *  folded in as a contribution, so netIncep always equals the waterfall row.
 *  YTD = flows in the as-of calendar year on/before as-of (same calendar-year
 *  convention as the YTD return). */
export type TwrCashflowSummary = {
  contributionsYtd: number;
  withdrawalsYtd: number; // signed (<= 0)
  netYtd: number;
  contributionsIncep: number;
  withdrawalsIncep: number; // signed (<= 0)
  netIncep: number;
  /** Mirrors input.contribInkind — flows are valued securities journals. */
  inKind: boolean;
};

export type TwrResult = {
  inception: string;
  endDate: string;
  asOf: string;
  calDays: number;
  /** The rate the Sharpe was computed with (decimal), or null when none was
   *  supplied — in which case `risk.sharpe` is null too. */
  rfAnnual: number | null;
  /** Present only when the data layer repaired one or more source snapshots. */
  balanceRepairCount?: number;
  netContributions: number;
  // performance summary table
  columns: string[];
  returns: (number | null)[];
  cells: TwrReturnCell[];
  twrSinceInception: number;
  ytd: number | null;
  // growth-of-$100k (net-of-fees compounded index): Incep + month-end points
  growthOf100k: TwrGrowthPoint[];
  // change-in-value waterfall
  waterfall: TwrWaterfallRow[];
  // external cash-flow summary (ties to the waterfall's "Net contributions")
  cashflow: TwrCashflowSummary;
  analytics: TwrAnalytics;
  risk: TwrRisk;
};

// Percentage of `num` over `denom`, but null when the denominator is 0 (or
// null/NaN) — dividing by a legitimately-zero base (a fully ACAT'd-in $0-basis
// account, a $0 ending value) yields Infinity/NaN that must not reach the report.
// A non-zero base with a 0 numerator still returns a real 0%.
const pctOf = (num: number, denom: number): number | null =>
  denom == null || denom === 0 || Number.isNaN(denom) ? null : (num / denom) * 100;

const daysBetween = (a: string, b: string): number =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

const yearBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
};

// Last calendar day of quarter q (0..3) in year y, as YYYY-MM-DD.
const QUARTER_END_MD = ["03-31", "06-30", "09-30", "12-31"] as const;

// The four most recent COMPLETED calendar quarters as of asOf. A quarter counts
// as completed when asOf is on/after its final calendar day — so a 6/30 report
// includes Q2, but a mid-quarter as-of (e.g. through-latest on Jul 8) does NOT
// show a days-old partial quarter dressed up as a full one; the in-progress
// quarter's days are still reflected in YTD and Since-Inception.
function quartersEndingAt(asOf: string): { label: string; months: string[] }[] {
  const y = +asOf.slice(0, 4);
  const m = +asOf.slice(5, 7);
  const q = Math.floor((m - 1) / 3); // 0..3 — quarter containing asOf
  // Step back one quarter unless asOf IS the quarter's final day.
  const lastComplete = asOf >= `${y}-${QUARTER_END_MD[q]}` ? y * 4 + q : y * 4 + q - 1;
  const out: { label: string; months: string[] }[] = [];
  for (let i = 3; i >= 0; i--) {
    const A = lastComplete - i;
    const yy = Math.floor(A / 4);
    const qq = ((A % 4) + 4) % 4;
    const startM = qq * 3 + 1;
    const months = [0, 1, 2].map(
      (k) => `${yy}-${String(startM + k).padStart(2, "0")}`,
    );
    out.push({ label: `Q${qq + 1} '${String(yy).slice(2)}`, months });
  }
  return out;
}

/** Compute the full TWR report model from a fully-specified input. Throws if
 *  the series has no funded daily returns. */
export function computeTwr(input: TwrEngineInput): TwrResult {
  // rf-as-data: no `?? DEFAULT_RF`. A missing rate stays missing all the way to
  // the Sharpe guard below, which suppresses.
  const rfAnnual = input.rfAnnual ?? null;
  const asOf = input.asOf;

  // 1) normalize + sort daily series
  let daily = input.daily
    .map((r) => ({ d: r.date, mv: +r.mv, cf: r.externalCf == null ? 0 : +r.externalCf }))
    .sort((a, b) => a.d.localeCompare(b.d));

  // 2) snapshot-glitch repairs (carry the corrected value on the named dates)
  const gf = input.glitchFix ?? {};
  daily = daily.map((r) => (gf[r.d] != null ? { ...r, mv: +gf[r.d] } : r));

  // 3) effective cash flow per day. On in-kind journal dates the whole equity
  //    step is an external in-kind flow: cf := MV - prevMV → that day's return
  //    neutralizes to 0 (no market return attributed).
  //    risk-stats v2 (C2): the neutralized flag marks exactly the days whose
  //    cf was overwritten here — the ground truth for the risk-sample filter
  //    (NEVER inferred from r === 0; a genuinely flat market day must stay in
  //    the risk sample).
  const flowSet = new Set(input.flowDates ?? []);
  const eff: { d: string; mv: number; cf: number; neutralized: boolean }[] = [];
  let prev: number | null = null;
  for (const r of daily) {
    let cf = r.cf;
    let neutralized = false;
    if (prev !== null && flowSet.has(r.d)) {
      cf = r.mv - prev;
      neutralized = true;
    }
    eff.push({ d: r.d, mv: r.mv, cf, neutralized });
    prev = r.mv;
  }

  // 4) daily returns + cumulative growth (clock starts at first funded day)
  prev = null;
  let cum = 1;
  const dret: { d: string; r: number; ym: string; neutralized: boolean }[] = [];
  const curve: { d: string; cum: number }[] = [];
  for (const r of eff) {
    // Symmetric tiny-denominator guard: only compute/count a daily return when
    // BOTH endpoints clear the threshold. A return must not be computed ACROSS
    // the tiny-balance boundary in EITHER direction. The old guard checked only
    // the prior day (`prev > THRESH`), which is asymmetric: on a small cash stub
    // it would skip the up-leg out of the stub ($1k→$2k, prev not > $1k) but
    // still count the down-leg back into it ($2k→$1k, prev IS > $1k), leaving a
    // phantom return and anchoring inception at a stub glitch. Requiring the
    // current MV to clear the threshold too makes both legs of such a round-trip
    // cancel. (For real funded accounts, whose balances sit well above $1k, this
    // is identical to the prior behavior.)
    if (prev !== null && prev > THRESH && r.mv > THRESH) {
      const ret = (r.mv - r.cf - prev) / prev;
      dret.push({ d: r.d, r: ret, ym: r.d.slice(0, 7), neutralized: r.neutralized });
      cum *= 1 + ret;
      curve.push({ d: r.d, cum });
    }
    prev = r.mv;
  }
  if (!dret.length) {
    throw new TwrInsufficientHistoryError();
  }

  const baseIdx = eff.findIndex((x) => x.d === dret[0].d) - 1;
  const base = eff[baseIdx];
  const bmv = base.mv;
  const incepDate = base.d;
  const lastRow = eff[eff.length - 1];
  const emv = lastRow.mv;
  const endDate = lastRow.d;
  const netflowAfter = eff
    .filter((x) => x.d > incepDate)
    .reduce((s, x) => s + x.cf, 0);

  // 5) monthly TWR + month-end growth-of-$100k index (compounded daily returns)
  const monthly: Record<string, number> = {};
  const monthEndGrowth: Record<string, number> = {};
  for (const x of dret) monthly[x.ym] = (monthly[x.ym] ?? 1) * (1 + x.r);
  for (const p of curve) monthEndGrowth[p.d.slice(0, 7)] = 100000 * p.cum;
  const mret: Record<string, number> = Object.fromEntries(
    Object.entries(monthly).map(([k, v]) => [k, (v - 1) * 100]),
  );
  const chain = (ms: string[]): number | null => {
    let x = 1;
    let any = false;
    for (const m of ms)
      if (mret[m] !== undefined) {
        x *= 1 + mret[m] / 100;
        any = true;
      }
    return any ? (x - 1) * 100 : null;
  };

  const twr = (cum - 1) * 100;
  const quarters = quartersEndingAt(asOf);
  const ytdMonths: string[] = [];
  for (let m = 1; m <= +asOf.slice(5, 7); m++) {
    ytdMonths.push(`${asOf.slice(0, 4)}-${String(m).padStart(2, "0")}`);
  }
  const ytd = chain(ytdMonths);
  const columns = [...quarters.map((q) => q.label), "YTD", "Since Incep."];
  const returns = [...quarters.map((q) => chain(q.months)), ytd, twr];
  const cells: TwrReturnCell[] = columns.map((label, i) => ({
    label,
    value: returns[i],
  }));

  // 6) risk — risk-stats v2 (see docs/blueprints/twr-risk-stats-v2.md):
  //    C1 no sub-year annualization, C2 neutralized in-kind days excluded from
  //    the risk sample (still compounded), C3 daily-native Sharpe, C4
  //    min-observation floor. maxDrawdown stays curve-based (full compounding —
  //    neutralized days are flat and cannot create or mask a drawdown).
  const riskSample = dret.filter((x) => !x.neutralized); // C2 sample
  const riskRs = riskSample.map((x) => x.r);
  const neutralizedDays = dret.length - riskRs.length;
  const n = riskRs.length; // riskSampleSize
  const riskMean = n > 0 ? riskRs.reduce((a, b) => a + b, 0) / n : 0;
  const riskStdev =
    n > 1
      ? Math.sqrt(riskRs.reduce((a, b) => a + (b - riskMean) ** 2, 0) / (n - 1))
      : 0;
  let peak = 0;
  let mdd = 0;
  for (const p of curve) {
    if (p.cum > peak) peak = p.cum;
    const dd = (p.cum - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  const calDays = daysBetween(incepDate, endDate);
  // C1: annualize only at >= 365 calendar days (byte-identical to v1 there);
  // under a year the figure IS the cumulative since-inception TWR, relabeled.
  const annualized = calDays >= 365;
  const annReturn = annualized
    ? (Math.pow(cum, 365 / calDays) - 1) * 100
    : (cum - 1) * 100; // === twrSinceInception
  const vol = n >= MIN_RISK_OBS ? riskStdev * Math.sqrt(252) * 100 : null; // C4
  // C3: daily-native Sharpe = (mean daily excess) / (daily stdev) × √252 over
  // the SAME filtered sample. rf_daily = rf_annual/252 was chosen over
  // (1+rf_annual)^(1/252) − 1 — the difference is ~2 × 10⁻⁶/day at 4%,
  // immaterial at 2-decimal display precision; the simple arithmetic form is
  // used. Suppressed under 12 months (C1), under the floor (C4), and when the
  // sample stdev is 0 (a zero-variance sample must not divide to ±Infinity).
  //
  // rf-as-data: because mean(rᵢ − rf/252) = mean(rᵢ) − rf/252, subtracting the
  // PERIOD-MEAN rate here is exactly equivalent to subtracting each day's own
  // rate and then averaging — which is why the caller supplies the window mean
  // rather than a spot rate (see lib/twr/risk-free-rate.ts).
  const sharpeEligible = annualized && n >= MIN_RISK_OBS && riskStdev > 0;
  const sharpe =
    sharpeEligible && rfAnnual !== null
      ? ((riskMean - rfAnnual / 252) / riskStdev) * Math.sqrt(252)
      : null;
  const risk: TwrRisk = {
    annReturn,
    periodBasis: annualized ? "annualized" : "cumulative",
    vol,
    sharpe,
    sharpeEligible,
    sampleFrom: n > 0 ? riskSample[0].d : null,
    sampleTo: n > 0 ? riskSample[n - 1].d : null,
    maxDrawdown: mdd * 100,
    // Descriptive stats over the filtered sample; null (never −Infinity/NaN)
    // in the degenerate all-days-neutralized case where the sample is empty.
    bestDay: n > 0 ? Math.max(...riskRs) * 100 : null,
    worstDay: n > 0 ? Math.min(...riskRs) * 100 : null,
    positiveDays: n > 0 ? (riskRs.filter((x) => x > 0).length / n) * 100 : null,
    neutralizedDays,
    riskSampleSize: n,
  };

  // 7) change-in-value waterfall (matches the approved report exactly)
  const fee = Math.abs(input.advisoryFeeNet);
  const income = input.dividendTtm;
  const beginVal = input.beginningZero ? 0 : bmv;
  const netContrib = netflowAfter + (input.beginningZero ? bmv : 0);
  const apprec = emv - beginVal - netContrib - income + fee; // invariant plug
  const incepStr = fmtShortDate(incepDate);
  const endStr = fmtShortDate(endDate);
  const contribLbl = input.contribInkind
    ? "Net contributions (in-kind)"
    : "Net contributions";
  const waterfall: TwrWaterfallRow[] = [
    { label: `Beginning value (${incepStr})`, value: beginVal, tone: "" },
    { label: contribLbl, value: netContrib, tone: "" },
    { label: "Dividend income", value: income, tone: "pos" },
    {
      label: "Market appreciation",
      value: apprec,
      tone: apprec >= 0 ? "pos" : "neg",
    },
    {
      label: "Advisory fee (AUM)",
      value: fee > 0 ? -fee : 0,
      tone: fee > 0 ? "neg" : "",
    },
    { label: `Ending value (${endStr})`, value: emv, tone: "tot" },
  ];

  // 7b) external cash-flow summary. Same effective flows the TWR neutralizes
  //     (`eff` — in-kind journal days already valued as the equity step),
  //     strictly after the inception day (the inception-day funding lives in
  //     bmv), split by sign. Under beginningZero framing the funded balance
  //     bmv is folded in as a contribution — EXACTLY the waterfall's
  //     netContrib — so "Net cash flow (since inception)" agrees with the
  //     waterfall's "Net contributions" row by construction.
  const asOfYear = asOf.slice(0, 4);
  let contributionsYtd = 0;
  let withdrawalsYtd = 0;
  let contributionsIncep = 0;
  let withdrawalsIncep = 0;
  for (const x of eff) {
    if (x.d <= incepDate || x.cf === 0) continue;
    const inYtd = x.d.slice(0, 4) === asOfYear && x.d <= asOf;
    if (x.cf > 0) {
      contributionsIncep += x.cf;
      if (inYtd) contributionsYtd += x.cf;
    } else {
      withdrawalsIncep += x.cf;
      if (inYtd) withdrawalsYtd += x.cf;
    }
  }
  if (input.beginningZero) {
    contributionsIncep += bmv;
    if (incepDate.slice(0, 4) === asOfYear && incepDate <= asOf) {
      contributionsYtd += bmv;
    }
  }
  const cashflow: TwrCashflowSummary = {
    contributionsYtd,
    withdrawalsYtd,
    netYtd: contributionsYtd + withdrawalsYtd,
    contributionsIncep,
    withdrawalsIncep,
    netIncep: contributionsIncep + withdrawalsIncep,
    inKind: !!input.contribInkind,
  };

  // 8) analytics panel
  const closingInKindTransfer = hasClosingInKindTransfer(
    eff.map((x) => ({ date: x.d, mv: x.mv })),
    flowSet,
  );
  const basisUnreconciled = closingInKindTransfer && input.costBasis > 0;
  const unrl = input.positionsMv - input.costBasis;
  // Raw unrealized % as computed historically. When basis is incomplete AND the
  // figure is materially distorted, suppress it (expose null) rather than
  // fabricate a misleading percent from an understated basis — see
  // UNREALIZED_PCT_MATERIALITY. The dollar figure (unrl) is always kept as-is.
  const rawUnrealizedPct = pctOf(unrl, input.costBasis);
  const zeroBasisLots = input.zeroBasisLots ?? 0;
  const basisIncomplete =
    !basisUnreconciled &&
    zeroBasisLots > 0 &&
    (rawUnrealizedPct === null || rawUnrealizedPct > UNREALIZED_PCT_MATERIALITY);
  // A trailing-income rate should reflect the capital that was actually present
  // while that income was earned. Ending value systematically understates the
  // rate for accounts funded throughout the year. Use the observed custodial
  // daily values from the later of inception or the TTM boundary; snapshot
  // glitch repairs above are therefore reflected in this denominator too.
  const dividendCutoff = yearBefore(asOf);
  const dividendBalanceSample = eff.filter(
    (x) => x.d >= incepDate && x.d > dividendCutoff && x.d <= asOf,
  );
  const averageTtmBalance = dividendBalanceSample.length
    ? dividendBalanceSample.reduce((sum, x) => sum + x.mv, 0) /
      dividendBalanceSample.length
    : 0;
  const analytics: TwrAnalytics = {
    currentValue: emv,
    // Preserve the exact source values in the immutable calculation snapshot;
    // basisUnreconciled is the presentation/control signal that prevents these
    // stale raw fields from appearing as client analytics.
    costBasis: input.costBasis,
    costBasisAsOf: input.costBasisAsOf,
    unrealizedGl: unrl,
    unrealizedPct:
      basisUnreconciled || basisIncomplete ? null : rawUnrealizedPct,
    basisIncomplete,
    basisUnreconciled: basisUnreconciled || undefined,
    realizedSt: input.realizedSt,
    realizedLt: input.realizedLt,
    dividendTtm: income,
    dividendYield: basisUnreconciled ? null : pctOf(income, averageTtmBalance),
    advisoryFee: fee,
  };

  // 9) growth curve for the chart: Incep ($100k) + one point per funded month
  const months = Object.keys(monthEndGrowth).sort();
  const MON = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const growthOf100k: TwrGrowthPoint[] = [
    { label: "Incep", value: 100000 },
    ...months.map((m) => ({
      label: MON[+m.slice(5) - 1],
      value: monthEndGrowth[m],
    })),
  ];

  return {
    inception: incepDate,
    endDate,
    asOf,
    calDays,
    rfAnnual,
    ...(input.balanceRepairCount && input.balanceRepairCount > 0
      ? { balanceRepairCount: input.balanceRepairCount }
      : {}),
    netContributions: netflowAfter,
    columns,
    returns,
    cells,
    twrSinceInception: twr,
    ytd,
    growthOf100k,
    waterfall,
    cashflow,
    analytics,
    risk,
  };
}

// ----------------------------------------------------------------- formatting
export const usd = (n: number): string =>
  (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");

export const pct = (n: number): string =>
  (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%";

export function fmtShortDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function fmtLongDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
