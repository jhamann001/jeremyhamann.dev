import type { TwrResult } from "@/lib/twr/engine";
import { usd, pct, fmtShortDate, fmtLongDate } from "@/lib/twr/engine";
import type { HouseholdMemberBreakdown } from "@/lib/twr/household";
import type { RiskFreeWindow } from "@/lib/twr/risk-free-rate";
import { GrowthChart } from "./GrowthChart";
import { PrintButton } from "./PrintButton";
import { HouseholdAccountsTable } from "./HouseholdAccountsTable";
import {
  KV,
  WaterfallRow,
  Watermark,
  pctOrDash,
  BasisIncompleteNote,
  RiskReturnPanel,
  RiskDisclosure,
  PresentationRoundingDisclosure,
  PRINT_CSS,
  signedTone,
} from "./report-shared";
import styles from "./report.module.css";

// HOUSEHOLD-level Portfolio Performance Report — the approved 3-page layout
// (Cover / Performance Overview / Portfolio Analytics) with household framing:
// the numbers come from computeTwr over the SUMMED member balance series
// (aggregate-then-chain — the household is one portfolio), plus a per-account
// "Accounts" breakdown on page 3.
//
// CLIENT-FACING LABEL RULE (the owner): narrative copy says "your N Cedar Ridge
// accounts" — the custodian's name ("Apex") must NEVER appear in narrative
// text. Custodian naming stays ONLY in the fine-print methodology disclosure.

export function HouseholdPerformanceReport({
  reportId,
  householdName,
  memberCount,
  members,
  result,
  rf,
  reportDate,
}: {
  reportId: string;
  householdName: string;
  memberCount: number;
  members: HouseholdMemberBreakdown[];
  result: TwrResult;
  /** The risk-free-rate window the Sharpe was computed over (source + dates +
   *  average + coverage), for the methodology disclosure. null when no rate was
   *  needed because the Sharpe is suppressed for a non-rate reason. */
  rf: RiskFreeWindow | null;
  reportDate: string;
}) {
  const label = householdName;
  const rid = reportId;
  const incepStr = fmtShortDate(result.inception);
  const endStr = fmtShortDate(result.endDate);
  const asOfLong = fmtLongDate(result.asOf);
  const a = result.analytics;
  const acctPhrase = `your ${memberCount} Cedar Ridge account${memberCount === 1 ? "" : "s"}`;

  const strategyNote = `This report combines ${acctPhrase} into a single household portfolio. Returns are daily time-weighted and reflect advisory fees actually charged to the accounts. Since-inception covers ${incepStr} (first funding) – ${endStr}. The table shows completed calendar quarters, year to date, and since inception.`;

  // Cash Flow block: engine-computed external-flow summary — at the household
  // level these are ONLY flows that crossed the household boundary (transfers
  // between the household's own accounts are internal by construction).
  const cf = result.cashflow;
  const cfSubtitle = cf.inKind
    ? "External flows (in-kind transfers valued at receipt)"
    : "External deposits & withdrawals (flows between your accounts excluded)";

  const realizedNull = a.realizedSt == null && a.realizedLt == null;

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
          <span>Household Performance Report</span>
        </div>
      </div>

      {/* Page 2 — Performance Overview (household series) */}
      <div className={styles.page}>
        <div className={styles.top}>
          <span className={styles.pill}>{label}</span>
          <Watermark small />
        </div>
        <h2 className={styles.title}>
          Household Performance <b>Overview</b>
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
              <td className={styles.l}>Household (after fees charged)</td>
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
            Cumulative household return, indexed to $100,000 at inception.
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

      {/* Page 3 — Portfolio Analytics + Accounts breakdown */}
      <div className={styles.page}>
        <div className={styles.top}>
          <span className={styles.pill}>{label}</span>
          <Watermark small />
        </div>
        <h2 className={styles.title}>
          Household <b>Analytics</b>
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
                  tone={signedTone(a.realizedSt ?? 0)}
                />
                <KV
                  k="Realized G/L — YTD (long-term)"
                  v={usd(a.realizedLt ?? 0)}
                  tone={signedTone(a.realizedLt ?? 0)}
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
          <KV k="Net cash flow (YTD)" v={usd(cf.netYtd)} tone={signedTone(cf.netYtd)} />
          <KV
            k="Net cash flow (since inception)"
            v={usd(cf.netIncep)}
            tone={signedTone(cf.netIncep)}
          />
        </div>

        <div className={styles.foot}>
          <span className={styles.rid}>Report ID: {rid}</span>
          <span>Prepared for {label} · Page 3</span>
        </div>
      </div>

      {/* Page 4 — Accounts breakdown + Methodology. Split from page 3: the
          Analytics sections + the accounts table + disclosures exceed one fixed
          11in sheet, and overflowing content collides with the absolutely-
          positioned footer (Report ID / page number). */}
      <div className={styles.page}>
        <div className={styles.top}>
          <span className={styles.pill}>{label}</span>
          <Watermark small />
        </div>
        <h2 className={styles.title}>
          Household <b>Accounts</b>
        </h2>
        <div className={styles.hr} />

        <div className={styles.sec}>
          <h3 className={styles.h3}>
            Accounts <span className={styles.muted}>— {acctPhrase.replace("your ", "")}</span>
          </h3>
          <HouseholdAccountsTable members={members} />
        </div>

        <div className={styles.sec}>
          <div className={styles.disc}>
            <b>Methodology &amp; disclosures.</b> Returns are time-weighted (daily),
            computed by Cedar Ridge Wealth from Apex Clearing custodial balances and
            settled activity; each day&rsquo;s return is (end value − net external
            flow − start value) ÷ start value, geometrically linked. Advisory fees
            and reimbursements, when present, are included in custodial balances and
            therefore reflected in returns; the combined net amount actually charged
            is shown on this report. Dividend yield is trailing-twelve-month cash
            dividend income divided by average daily household value over the same
            window. Cost basis and
            unrealized gain/loss are derived from custodial open tax lots
            (deduplicated); realized gain/loss is derived from custodial closed tax
            lots (deduplicated, latest snapshot), with wash-sale adjustments as
            reported by the custodian. This report aggregates your {memberCount}{" "}
            Cedar Ridge account{memberCount === 1 ? "" : "s"} into a single household
            portfolio; the household return is computed on combined daily balances,
            so transfers between your accounts do not affect performance — only
            flows entering or leaving the household are treated as external. Each
            account&rsquo;s since-inception return in the Accounts table is computed
            on that account&rsquo;s own balance series. No market benchmark is
            shown.
            <RiskDisclosure
              risk={result.risk}
              rf={rf}
              subject="this household's"
            />{" "}
            Past performance is not indicative of future results.{" "}
            <PresentationRoundingDisclosure /> Figures are unaudited and subject
            to custodial reconciliation.
          </div>
        </div>

        <div className={styles.foot}>
          <span className={styles.rid}>Report ID: {rid}</span>
          <span>Prepared for {label} · Page 4</span>
        </div>
      </div>
    </div>
  );
}
