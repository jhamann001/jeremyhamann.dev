import {
  Card,
  CardHeader,
  CardBody,
  SectionLabel,
  StatTile,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "@/components/ui";
import { fmtShortDate } from "@/lib/twr/engine";
import { FUNDING_METHODS, type FundingSummary } from "@/lib/data/account-funding";
import styles from "./NewFundingCard.module.css";

// "New Funding" section — external cash funding (ACH / Check / Wire) over the
// trailing 12 months, with a YTD callout. REAL data (card 6568) → NO
// PreviewBadge. Now client-level on the portrait's Core Financial section
// (aggregated across the client's Apex accounts); when events carry a source
// `account`, a per-account column is shown so a client-wide view stays legible.
//
// `noPrint` is OPT-IN (default false). It existed for the old performance-report
// context (kept the pixel-approved client PDF byte-identical); on the portrait
// the card prints normally, so callers there omit it.

// Funding amounts are precise cash movements, so we show cents (the print TWR
// report rounds to whole dollars; this screen-only card does not).
const usdCents = (n: number): string =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function NewFundingCard({
  summary,
  noPrint = false,
}: {
  summary: FundingSummary;
  /** When true, hide the card from print (legacy performance-report posture).
   *  Defaults to false — on the portrait the card prints normally. */
  noPrint?: boolean;
}) {
  const { events, byMethod, total, ytd } = summary;
  const hasFunding = total.count > 0;
  // Show the source-account column only when events actually carry an account
  // (the client-level view spans multiple accounts); the single-account path
  // leaves it undefined and the column stays hidden.
  const showAccountCol = events.some((e) => e.account);

  return (
    <Card className={noPrint ? "noPrint" : undefined}>
      <CardHeader>
        <div>
          <SectionLabel>New Funding · Trailing 12 Months</SectionLabel>
          <h2 className={styles.title}>External Cash Funding</h2>
        </div>
      </CardHeader>
      <CardBody>
        <div className={styles.methodGrid}>
          {FUNDING_METHODS.map((m) => (
            <StatTile
              key={m}
              label={`${m} · ${byMethod[m].count} ${
                byMethod[m].count === 1 ? "deposit" : "deposits"
              }`}
              value={usdCents(byMethod[m].amount)}
            />
          ))}
        </div>

        <div className={styles.ytdCallout}>
          <span className={styles.ytdLabel}>Year to date</span>
          <span className={styles.ytdValue}>{usdCents(ytd.amount)}</span>
          <span className={styles.ytdCount}>
            {ytd.count} {ytd.count === 1 ? "deposit" : "deposits"}
          </span>
        </div>

        {hasFunding ? (
          <details className={styles.details}>
            <summary className={styles.detailSummary}>
              <span>
                Transaction details · {total.count}{" "}
                {total.count === 1 ? "deposit" : "deposits"}
              </span>
              <span className={styles.chevron} aria-hidden>
                ›
              </span>
            </summary>
            <div className={styles.detailBody}>
              <Table className={styles.table}>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    {showAccountCol ? <TH>Account</TH> : null}
                    <TH>Method</TH>
                    <TH className={styles.amountCol}>Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {events.map((e, i) => (
                    // Append the array index so two same-date/same-amount deposits
                    // can't collide when activity_id is blank.
                    <TR
                      key={`${e.activityId || `${e.activityDate}-${e.amount}`}-${i}`}
                    >
                      <TD>{fmtShortDate(e.activityDate)}</TD>
                      {showAccountCol ? (
                        <TD className={styles.mutedCell}>{e.account ?? "—"}</TD>
                      ) : null}
                      <TD>{e.method}</TD>
                      <TD className={styles.amountCol}>{usdCents(e.amount)}</TD>
                    </TR>
                  ))}
                  <TR className={styles.totalRow}>
                    <TD colSpan={showAccountCol ? 2 : 1}>Total</TD>
                    <TD>
                      {total.count} {total.count === 1 ? "deposit" : "deposits"}
                    </TD>
                    <TD className={styles.amountCol}>{usdCents(total.amount)}</TD>
                  </TR>
                </TBody>
              </Table>
            </div>
          </details>
        ) : (
          <p className={styles.empty}>
            No ACH, check, or wire funding in the trailing 12 months.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
