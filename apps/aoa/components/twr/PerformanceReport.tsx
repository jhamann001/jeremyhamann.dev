import type { TwrResult } from "@/lib/twr/engine";
import { usd, pct, fmtShortDate, fmtLongDate } from "@/lib/twr/engine";
import type { TwrIdentity } from "@/lib/twr/warehouse";
import type { RiskFreeWindow } from "@/lib/twr/risk-free-rate";
import { GrowthChart } from "./GrowthChart";
import { PrintButton } from "./PrintButton";
import {
  KV,
  WaterfallRow,
  Watermark,
  pctOrDash,
  BasisIncompleteNote,
  TransferredAccountAnalyticsNote,
  RiskReturnPanel,
  RiskDisclosure,
  PresentationRoundingDisclosure,
  PRINT_CSS,
} from "./report-shared";
import styles from "./report.module.css";

// The approved 3-page Portfolio Performance Report (Cover / Performance
// Overview / Portfolio Analytics), rendered as React. Layout + copy are ported
// byte-faithfully from report_engine.js render(); numbers come from the pure
// engine (computeTwr). Net of fees, NO benchmark (household-located sleeve).
// Shared presentational atoms (Watermark/KV/WaterfallRow/print CSS) live in
// report-shared.tsx, shared with the household-level report.

export function PerformanceReport({
  reportId,
  identity,
  result,
  rf,
  reportDate,
}: {
  reportId: string;
  identity: TwrIdentity;
  result: TwrResult;
  /** The risk-free-rate window the Sharpe was computed over (source + dates +
   *  average + coverage), for the methodology disclosure. null when no rate was
   *  needed because the Sharpe is suppressed for a non-rate reason. */
  rf: RiskFreeWindow | null;
  reportDate: string;
}) {
  const label = `${identity.clientName} — ${identity.accountType}`;
  const rid = reportId;
  const incepStr = fmtShortDate(result.inception);
  const endStr = fmtShortDate(result.endDate);
  const asOfLong = fmtLongDate(result.asOf);
  const a = result.analytics;

  const transferHistoryNote = result.cashflow.inKind
    ? " This account began with an in-kind transfer; predecessor-account performance is not included. Use the household report for continuous relationship history."
    : "";
  const strategyNote = `Account: ${identity.strategy}. Returns are daily time-weighted and reflect advisory fees actually charged to the account. Since-inception covers ${incepStr} (funding) – ${endStr}. The table shows completed calendar quarters, year to date, and since inception.${transferHistoryNote}`;

  // Cash Flow block: engine-computed external-flow summary (same daily flows
  // the TWR neutralizes), guaranteed to tie to the waterfall's "Net
  // contributions". In-kind sleeves' "contributions" are valued securities
  // journals — the subtitle says so (same branch the waterfall label uses).
  const cf = result.cashflow;
  const cfSubtitle = cf.inKind
    ? "External flows (in-kind transfers valued at receipt)"
    : "External deposits & withdrawals";
  // Signed-money tone: green positive, red negative, plain $0.
  const cfTone = (n: number): "pos" | "neg" | undefined =>
    n > 0 ? "pos" : n < 0 ? "neg" : undefined;

  const realizedNull = a.realizedSt == null && a.realizedLt == null;
  // Realized rows: green positive, red negative, plain $0 (a real "no realized
  // gains this year" carries no tone — only null renders the "—" row).
  const rglTone = (n: number): "pos" | "neg" | undefined =>
    n > 0 ? "pos" : n < 0 ? "neg" : undefined;

  return (
    <div className={`${styles.report} ${styles.screen}`}>
      <style>{PRINT_CSS}</style>
      <div className={styles.toolbar}>
        <PrintButton />
      </div>

      {/* Page 1 — Cover */}
      <div className={`${styles.page} ${styles.cover}`}>
        <Watermark />
        <h1 className={styles.coverTitle}>
          Portfolio Performance
          <br />
          Report
        </h1>
        <div className={styles.rule} />
        <div className={styles.lbl}>Prepared For</div>
        <div className={styles.val}>{label}</div>
        <div className={styles.lbl}>Report Date</div>
        <div className={styles.val}>{reportDate}</div>
        <div className={styles.foot}>
          <span className={styles.rid}>Report ID: {rid}</span>
          <span>Performance Report</span>
        </div>
      </div>

      {/* Page 2 — Performance Overview */}
      <div className={styles.page}>
        <div className={styles.top}>
          <span className={styles.pill}>{label}</span>
          <Watermark small />
        </div>
        <h2 className={styles.title}>
          Performance <b>Overview</b>
        </h2>
        <div className={styles.hr} />

        <h3 className={styles.h3}>
          Performance Summary <span className={styles.muted}>— time-weighted return</span>
        </h3>
        <table className={styles.perf}>
          <thead>
            <tr>
              <th className={styles.l}>Return</th>
              {result.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={styles.l}>Portfolio (after fees charged)</td>
              {result.cells.map((cell) => (
                <td key={cell.label} className={styles.port}>
                  {cell.value === null ? "—" : pct(cell.value)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <div className={styles.note} style={{ marginTop: 8 }}>
          {strategyNote}
        </div>

        <div className={styles.sec}>
          <h3 className={styles.h3}>Growth of $100,000</h3>
          <div className={`${styles.note} ${styles.noteTight}`}>
            Cumulative account return, indexed to $100,000 at inception.
          </div>
          <div className={styles.chartFrame}>
            <GrowthChart points={result.growthOf100k} />
          </div>
        </div>

        <div className={styles.sec}>
          <h3 className={styles.h3}>Change in Value</h3>
          <div className={styles.kvBox}>
            {result.waterfall.map((row) => (
              <WaterfallRow key={row.label} row={row} />
            ))}
          </div>
        </div>

        <div className={styles.foot}>
          <span className={styles.rid}>Report ID: {rid}</span>
          <span>Prepared for {label} · Page 2</span>
        </div>
      </div>

      {/* Page 3 — Portfolio Analytics */}
      <div className={styles.page}>
        <div className={styles.top}>
          <span className={styles.pill}>{label}</span>
          <Watermark small />
        </div>
        <h2 className={styles.title}>
          Portfolio <b>Analytics</b>
        </h2>
        <div className={styles.hr} />

        <div className={styles.cols}>
          <div>
            <h3 className={styles.h3}>Account Values &amp; Gains</h3>
            <div className={`${styles.note} ${styles.noteTight}`}>As of {asOfLong}</div>
            <KV k="Current Value" v={usd(a.currentValue)} />
            <KV k="Cost Basis" v={a.basisUnreconciled ? "—" : usd(a.costBasis)} />
            <KV
              k="Unrealized Gain/Loss"
              v={
                a.basisUnreconciled
                  ? "—"
                  : `${usd(a.unrealizedGl)} (${pctOrDash(a.unrealizedPct, 2)})`
              }
              tone={
                a.basisUnreconciled
                  ? undefined
                  : a.unrealizedGl >= 0
                    ? "pos"
                    : "neg"
              }
            />
            {realizedNull ? (
              <KV k="Realized G/L — YTD" v="—" />
            ) : (
              <>
                <KV
                  k="Realized G/L — YTD (short-term)"
                  v={usd(a.realizedSt ?? 0)}
                  tone={rglTone(a.realizedSt ?? 0)}
                />
                <KV
                  k="Realized G/L — YTD (long-term)"
                  v={usd(a.realizedLt ?? 0)}
                  tone={rglTone(a.realizedLt ?? 0)}
                />
              </>
            )}
            <KV k="Dividend Income (TTM)" v={usd(a.dividendTtm)} />
            <KV k="Dividend Yield (TTM)" v={pctOrDash(a.dividendYield, 2)} />
            <KV
              k="Advisory Fee (AUM) — paid"
              v={usd(a.advisoryFee)}
              tone={a.advisoryFee > 0 ? "neg" : undefined}
            />
            {a.basisIncomplete && <BasisIncompleteNote />}
            {a.basisUnreconciled && <TransferredAccountAnalyticsNote />}
          </div>
          <RiskReturnPanel risk={result.risk} />
        </div>

        <div className={styles.sec}>
          <h3 className={styles.h3}>Cash Flow</h3>
          <div className={`${styles.note} ${styles.noteTight}`}>{cfSubtitle}</div>
          <KV
            k="Contributions (YTD)"
            v={usd(cf.contributionsYtd)}
            tone={cf.contributionsYtd > 0 ? "pos" : undefined}
          />
          <KV
            k="Withdrawals (YTD)"
            v={usd(cf.withdrawalsYtd)}
            tone={cf.withdrawalsYtd < 0 ? "neg" : undefined}
          />
          <KV k="Net cash flow (YTD)" v={usd(cf.netYtd)} tone={cfTone(cf.netYtd)} />
          <KV
            k="Net cash flow (since inception)"
            v={usd(cf.netIncep)}
            tone={cfTone(cf.netIncep)}
          />
        </div>

        <div className={styles.sec}>
          <div className={styles.disc}>
            <b>Methodology &amp; disclosures.</b> Returns are time-weighted (daily),
            computed by Cedar Ridge Wealth from Apex Clearing custodial balances and
            settled activity; each day&rsquo;s return is (end value − net external
            flow − start value) ÷ start value, geometrically linked. Advisory fees
            and reimbursements, when present, are included in custodial balances and
            therefore reflected in returns; the net amount actually charged is shown
            on this report. Dividend yield is trailing-twelve-month cash dividend
            income divided by average daily account value over the same window. Cost
            basis and unrealized gain/loss are derived from custodial
            open tax lots (deduplicated); realized gain/loss is derived from
            custodial closed tax lots (deduplicated, latest snapshot), with
            wash-sale adjustments as reported by the custodian. This account is one sleeve of a household allocation
            (assets are located across accounts for tax efficiency), so its results
            reflect that sleeve&rsquo;s role rather than a standalone strategy; no
            market benchmark is shown.
            <RiskDisclosure risk={result.risk} rf={rf} />{" "}
            Past performance is not indicative of future
            results. <PresentationRoundingDisclosure /> Figures are unaudited and
            subject to custodial reconciliation.
          </div>
        </div>

        <div className={styles.foot}>
          <span className={styles.rid}>Report ID: {rid}</span>
          <span>Prepared for {label} · Page 3</span>
        </div>
      </div>
    </div>
  );
}
