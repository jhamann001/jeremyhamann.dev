import type { TwrRisk, TwrWaterfallRow } from "@/lib/twr/engine";
import { usd, fmtShortDate } from "@/lib/twr/engine";
import {
  PRESENTATION_ROUNDING_DISCLOSURE,
  signedMetricTone,
} from "@/lib/twr/report-presentation";
// PURE module (no `server-only`, no Prisma) — safe to import from a component;
// the RLS read seam lives in lib/data/risk-free-rate.ts.
import {
  RF_SOURCE_LABEL,
  RF_TENOR_LABEL,
  type RiskFreeWindow,
} from "@/lib/twr/risk-free-rate";
import styles from "./report.module.css";

// Shared presentational atoms for the TWR Portfolio Performance Reports
// (account-level PerformanceReport + household-level
// HouseholdPerformanceReport). Extracted verbatim from PerformanceReport so
// both reports render the SAME approved look.

// A percent metric that is null when its denominator was 0/absent (the engine
// never fabricates a percent from a 0 base — e.g. a $0-cost-basis ACAT'd-in
// account) renders as an em-dash, consistent with the "—" realized-G/L row. A
// real 0% (0 numerator over a non-zero base) still prints "0.00%".
export function pctOrDash(n: number | null, digits: number): string {
  return n == null ? "—" : `${n.toFixed(digits)}%`;
}

/** pctOrDash's unitless sibling — a suppressed (null) metric renders as an
 *  em-dash (used for the Sharpe ratio under risk-stats v2). */
export function numOrDash(n: number | null, digits: number): string {
  return n == null ? "—" : n.toFixed(digits);
}

/** Signed-money tone: green positive, red negative, plain $0. */
export const signedTone = (n: number): "pos" | "neg" | undefined =>
  n > 0 ? "pos" : n < 0 ? "neg" : undefined;

/** Calm, informational footnote shown under Account Values when one or more
 *  holdings have no cost basis on record (common for IRAs — brokers aren't
 *  required to track IRA basis, and ACAT'd-in lots often import with $0 basis).
 *  In that state the unrealized return % is unreliable, so the report omits it
 *  (renders "—") while still showing the unrealized dollar figure. Rendered the
 *  same on screen and in the Print → PDF layout. */
export function BasisIncompleteNote() {
  return (
    <div className={styles.footnote}>
      Cost basis incomplete — one or more holdings have no basis on record
      (common for IRAs); unrealized return % is omitted.
    </div>
  );
}

/** Calm disclosure for a funded account that now ends as a closing cash stub
 * while the weekly open-lot feed still carries basis. The stale values are
 * suppressed by the report presentation and this explains why. */
export function TransferredAccountAnalyticsNote() {
  return (
    <div className={styles.footnote}>
      Account substantially transferred or closed — custodial open-lot basis
      does not reconcile to the ending positions, so cost basis and unrealized
      gain/loss are omitted. Use the household report for continuous performance
      across accounts.
    </div>
  );
}

/** Calm, informational footnote for the Risk & Return panel when the account's
 *  performance history is under one year (risk-stats v2, C1): returns are
 *  shown cumulative and the Sharpe ratio is omitted. Mirrors
 *  BasisIncompleteNote's structure/class exactly. */
export function UnderOneYearNote() {
  return (
    <div className={styles.footnote}>
      Performance history under one year — annualized returns are not shown.
    </div>
  );
}

/** Calm, informational footnote for the Risk & Return panel when fewer than
 *  MIN_RISK_OBS counted (post-filter) daily returns exist (risk-stats v2, C4):
 *  volatility and Sharpe are omitted. Mirrors BasisIncompleteNote's
 *  structure/class exactly. */
export function InsufficientHistoryNote() {
  return (
    <div className={styles.footnote}>
      Insufficient history for reliable risk statistics.
    </div>
  );
}

/** The Risk & Return panel — shared verbatim between the account and household
 *  reports (their v1 markup was byte-identical; risk-stats v2's conditional
 *  rendering must not be maintained twice).
 *
 *  Suppression → rendering map (risk-stats v2, docs/blueprints/
 *  twr-risk-stats-v2.md §3.5):
 *  - periodBasis "cumulative" → row label "Cumulative Return (since
 *    inception)", Sharpe "—", UnderOneYearNote.
 *  - vol null (min-observation floor) → Vol + Sharpe "—",
 *    InsufficientHistoryNote.
 *  - bestDay null (degenerate all-neutralized sample) → Best/Worst Day +
 *    Positive Days "—" (covered by the floor footnote — n = 0 < floor).
 *  Max drawdown / best / worst / positive days remain visible under the floor
 *  BY DESIGN: they are descriptive statistics of what happened, not estimates
 *  of a population parameter.
 *
 *  The return row uses the metric's actual sign: negative returns must never be
 *  presented in the positive/green tone. */
export function RiskReturnPanel({ risk }: { risk: TwrRisk }) {
  return (
    <div>
      <h3 className={styles.h3}>Risk &amp; Return</h3>
      <div className={`${styles.note} ${styles.noteTight}`}>
        Since inception, from daily returns
      </div>
      <KV
        k={
          risk.periodBasis === "annualized"
            ? "Annualized Return"
            : "Cumulative Return (since inception)"
        }
        v={`${risk.annReturn.toFixed(2)}%`}
        tone={signedMetricTone(risk.annReturn)}
      />
      <KV k="Annualized Volatility" v={pctOrDash(risk.vol, 2)} />
      <KV k="Sharpe Ratio" v={numOrDash(risk.sharpe, 2)} />
      <KV k="Maximum Drawdown" v={`${risk.maxDrawdown.toFixed(2)}%`} tone="neg" />
      <KV
        k="Best / Worst Day"
        v={
          risk.bestDay == null || risk.worstDay == null
            ? "—"
            : `+${risk.bestDay.toFixed(2)}% / ${risk.worstDay.toFixed(2)}%`
        }
      />
      <KV k="Positive Days" v={pctOrDash(risk.positiveDays, 1)} />
      {risk.periodBasis === "cumulative" && <UnderOneYearNote />}
      {risk.vol == null && <InsufficientHistoryNote />}
    </div>
  );
}

/** Client-facing disclosure for independently rounded display values. */
export function PresentationRoundingDisclosure() {
  return <>{PRESENTATION_ROUNDING_DISCLOSURE}</>;
}

/** Methodology-disclosure sentences for the risk block (risk-stats v2, C5+C6),
 *  rendered inline INSIDE each report's existing `styles.disc` paragraph (a
 *  fragment of sentence text so each report keeps its own surrounding copy).
 *
 *  RISK-FREE RATE (rf-as-data). This used to print an ASSUMED rate and a hand-
 *  maintained as-of month ("an assumed risk-free rate of 4.2% (as of Jul 2026)")
 *  — the disclosure of a constant that had drifted ~30bp from the market. It now
 *  states the SOURCE, the WINDOW averaged, and the COMPUTED AVERAGE, so a reader
 *  can reproduce the figure from the public Treasury series. `rf` carries that
 *  evidence (see lib/twr/risk-free-rate.ts):
 *   - rf with a rate + a shown Sharpe → source/window/average sentence.
 *   - rf present but insufficient coverage → the Sharpe is suppressed BECAUSE of
 *     the rate feed, and the sentence says exactly that (never a silent fallback).
 *   - rf null → the rate was not the reason the Sharpe is missing (short history /
 *     observation floor); the existing sentences below already explain it, so
 *     nothing is said about the rate at all. */
export function RiskDisclosure({
  risk,
  rf,
  subject = "this account's",
}: {
  risk: TwrRisk;
  rf: RiskFreeWindow | null;
  subject?: string;
}) {
  const parts: string[] = [];
  if (risk.sharpe != null) {
    parts.push(
      "The Sharpe ratio uses mean daily excess return and daily-return standard deviation, annualized using 252 trading days.",
    );
  }
  if (rf && rf.meanPct != null && risk.sharpe != null) {
    parts.push(
      `Its risk-free input is the average ${RF_TENOR_LABEL} U.S. Treasury par yield over the measured period — ${rf.meanPct.toFixed(
        2,
      )}% from ${fmtShortDate(rf.from)} to ${fmtShortDate(rf.to)}, the mean of ${
        rf.observations
      } daily observations (source: ${RF_SOURCE_LABEL}).`,
    );
  } else if (rf && rf.meanPct == null) {
    parts.push(
      `The Sharpe ratio is omitted — ${RF_TENOR_LABEL} U.S. Treasury par yield data is incomplete for the measured period (${
        rf.observations
      } of ${rf.expectedBusinessDays} business days), so no reliable average risk-free rate could be computed.`,
    );
  }
  if (risk.neutralizedDays > 0) {
    parts.push(
      `${risk.neutralizedDays} transfer day${
        risk.neutralizedDays === 1 ? "" : "s"
      } excluded from market returns and risk statistics (in-kind transfer days carry no market return).`,
    );
  }
  if (risk.periodBasis === "cumulative") {
    parts.push(
      `Because ${subject} performance history is under one year, returns are shown cumulative (not annualized) and the Sharpe ratio is omitted.`,
    );
  }
  if (risk.vol == null) {
    parts.push(
      "Volatility and Sharpe ratio are omitted — insufficient history for reliable risk statistics.",
    );
  }
  // Nothing to add (a fully-normal, fully-covered sub-year report can hit this):
  // return an empty fragment rather than a stray leading space in the paragraph.
  if (parts.length === 0) return null;
  return <>{` ${parts.join(" ")}`}</>;
}

// Global print rules that can't live in the CSS Module (bare `body` / shared
// `.noPrint` selectors aren't "pure"): hide the app chrome and set the paper
// so the browser Print → Save-as-PDF yields the approved look. Self-contained,
// mirroring the standalone generator's inlined <style>. Static string (no
// interpolation) — React renders it verbatim, no innerHTML.
export const PRINT_CSS = `@media print {
  @page { size: Letter; margin: 0; }
  body { visibility: hidden !important; background: #fff !important; }
  .noPrint { display: none !important; }
}`;

export function Watermark({ small }: { small?: boolean }) {
  return (
    <span className={`${styles.wm} ${small ? styles.wmSmall : ""}`}>
      CEDAR_RIDGE<span>WEALTH</span>
    </span>
  );
}

export function KV({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "pos" | "neg";
}) {
  const toneCls = tone === "pos" ? styles.pos : tone === "neg" ? styles.neg : "";
  return (
    <div className={styles.kv}>
      <span className={styles.k}>{k}</span>
      <span className={`${styles.v} ${toneCls}`}>{v}</span>
    </div>
  );
}

export function WaterfallRow({ row }: { row: TwrWaterfallRow }) {
  const isTot = row.tone === "tot";
  const toneCls =
    row.tone === "pos" ? styles.pos : row.tone === "neg" ? styles.neg : "";
  return (
    <div className={`${styles.kv} ${isTot ? styles.tot : ""}`}>
      <span className={styles.k}>{row.label}</span>
      <span className={`${styles.v} ${isTot ? "" : toneCls}`}>{usd(row.value)}</span>
    </div>
  );
}
