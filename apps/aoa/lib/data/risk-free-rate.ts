import "server-only";
import { withUserScope, type Identity } from "@/lib/rls";
import { computeTwr, type TwrEngineInput, type TwrResult } from "@/lib/twr/engine";
import {
  RF_TENOR,
  summarizeRiskFreeWindow,
  type RiskFreeObservation,
  type RiskFreeWindow,
} from "@/lib/twr/risk-free-rate";

// Risk-free-rate READ seam (mirror.risk_free_rate) + the two-pass report
// orchestration that feeds the Sharpe ratio a real rate instead of the constant
// that used to be hard-coded at two call sites. The contract, the coverage
// threshold, and the pure window arithmetic live in lib/twr/risk-free-rate.ts;
// this is the server-only half (Prisma + RLS), split so the pure half stays safe
// to import from a component or the ingest route.
//
// mirror.risk_free_rate is PUBLIC MARKET DATA with a read-for-all-app-roles RLS
// policy (see the 20260802000000_mirror_risk_free_rate migration), so unlike the
// client-scoped mirrors there is no book-of-business filtering here — every
// authenticated caller sees the whole series.

type RawRateRow = { rate_date: string; rate_pct: unknown }; // numeric → Decimal

/**
 * RLS-scoped read of the stored series for one window, folded into the window
 * average + coverage verdict.
 *
 * DECIMAL TRAP (carried, see lib/data/account-aum.ts): `rate_pct` is a Postgres
 * numeric ⇒ a Prisma Decimal at runtime, which does not survive the RSC boundary.
 * The Number() coercion lives HERE, at the seam. `rate_date` is rendered to text
 * in SQL so no Date/timezone round-trip can shift a business day.
 *
 * A read failure DEGRADES rather than fails the report: it returns a
 * zero-observation window (⇒ Sharpe suppresses with the coverage footnote) and
 * logs a counts-free marker. A performance report must never 500 because a rate
 * lookup blipped — and it must never fall back to a stale constant either.
 */
export async function riskFreeWindow(
  identity: Identity,
  from: string,
  to: string,
  tenor: string = RF_TENOR,
): Promise<RiskFreeWindow> {
  let rows: RiskFreeObservation[] = [];
  try {
    const raw = await withUserScope(identity, (tx) =>
      tx.$queryRaw<RawRateRow[]>`
        SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_pct
        FROM mirror.risk_free_rate
        WHERE tenor = ${tenor}
          AND rate_date >= ${from}::date
          AND rate_date <= ${to}::date
        ORDER BY rate_date`,
    );
    rows = raw.map((r) => ({ rateDate: r.rate_date, ratePct: Number(r.rate_pct) }));
  } catch {
    // Counts-free marker — no window bounds (report metadata), no row values.
    console.error("[twr:rf] risk_free_rate read failed — Sharpe will suppress");
    rows = [];
  }
  return summarizeRiskFreeWindow(rows, from, to, { tenor });
}

/**
 * Compute a TWR report with the risk-free rate fed from stored Treasury data.
 * The single entry point BOTH report surfaces use, so the two-pass mechanics and
 * the suppression rule are not duplicated per page.
 *
 * PASS 1 runs the engine with NO rate. Everything except the Sharpe is already
 * final there, and it is how we learn the exact FILTERED risk-sample window
 * (`risk.sampleFrom`..`sampleTo`) — the days the vol/Sharpe are actually computed
 * over — without re-deriving the engine's sample selection here, where it could
 * drift. That window is deliberately NOT the whole report period and not
 * [inception, endDate]: neutralized in-kind days and rows under the engine's $1k
 * denominator guard are not part of the sample, and the averaged rate must match
 * the sample the Sharpe is computed over.
 *
 * Pass 1 also short-circuits the database read entirely when the Sharpe could not
 * show anyway (`risk.sharpeEligible` — under 12 months, under the observation
 * floor, or a zero-variance sample), which is the common case for young accounts.
 *
 * PASS 2 re-runs the engine with the window mean, so the returned result's
 * `rfAnnual` and `risk.sharpe` are guaranteed mutually consistent. The engine is
 * pure and the series is a few hundred days, so the second pass is free.
 *
 * When coverage is insufficient the PASS 1 result is returned unchanged: Sharpe
 * stays null and the returned `rf` carries the coverage evidence for the footnote.
 * It NEVER falls back to a constant.
 */
export async function computeTwrWithMarketRf(
  identity: Identity,
  input: TwrEngineInput,
): Promise<{ result: TwrResult; rf: RiskFreeWindow | null }> {
  const probe = computeTwr({ ...input, rfAnnual: null });
  const { sharpeEligible, sampleFrom, sampleTo } = probe.risk;
  if (!sharpeEligible || sampleFrom === null || sampleTo === null) {
    // Sharpe is suppressed for a non-rate reason (C1 sub-year / C4 floor /
    // zero-variance); the report's existing footnotes already explain it, and no
    // rate is needed or disclosed. `rf: null` says "rf was not the reason".
    return { result: probe, rf: null };
  }
  const rf = await riskFreeWindow(identity, sampleFrom, sampleTo);
  if (rf.rfAnnual === null) return { result: probe, rf };
  return { result: computeTwr({ ...input, rfAnnual: rf.rfAnnual }), rf };
}
