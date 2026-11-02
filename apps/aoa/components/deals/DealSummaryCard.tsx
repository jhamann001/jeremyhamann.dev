import Link from "next/link";
import type { DealRow } from "@/lib/data/deal-types";
import { stageLabel } from "@/lib/data/deal-types";
import { usd } from "@/lib/format";
import { toDateStr } from "@/lib/market-calendar";
import { Pill, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import { ExpectedCloseDate } from "./ExpectedCloseDate";
import { stageTone } from "./stage-tone";
import styles from "./DealSummaryCard.module.css";

type DealCardRow = Pick<
  DealRow,
  | "id"
  | "name"
  | "client_first_name"
  | "client_last_name"
  | "stage"
  | "amount"
  | "close_date"
  | "account_type"
  | "transferring_firm"
>;

type DealCardSummary = {
  outstandingCount: number;
  outstandingAmount: number;
  fundedCount: number;
  fundedAmount: number;
};

/** Shared presentation only: callers retain their own scoped data, row order,
 * summary, and client/deal label choice. This stays a server component. */
export function DealSummaryCard({
  deals,
  summary,
  labelMode,
  emptyMessage,
}: {
  deals: readonly DealCardRow[];
  summary: DealCardSummary;
  labelMode: "deal" | "client";
  emptyMessage: string;
}) {
  // One server snapshot for every row; no browser clock or midnight race.
  const todayEt = toDateStr(new Date());

  return (
    <details className={styles.dealsCard}>
      <summary className={styles.summary}>
        <h2 className={styles.cardTitle}>Deals</h2>
        <span className={styles.summaryStats}>
          <span><strong>{summary.outstandingCount}</strong> outstanding · <strong>{usd(summary.outstandingAmount)}</strong></span>
          <span><strong>{summary.fundedCount}</strong> funded · <strong>{usd(summary.fundedAmount)}</strong></span>
        </span>
        <span className={styles.disclosure} aria-hidden="true">＋</span>
      </summary>
      <div className={styles.body} role="region" aria-label="Deals" tabIndex={0}>
        {deals.length === 0 ? (
          <p className={styles.empty}>{emptyMessage}</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Deal / Client</TH>
                <TH>Account type</TH>
                <TH>Transferring firm</TH>
                <TH>Stage</TH>
                <TH style={{ textAlign: "right" }}>Amount</TH>
                <TH>Exp. close</TH>
              </TR>
            </THead>
            <TBody>
              {deals.map((deal) => {
                const clientName = `${deal.client_first_name} ${deal.client_last_name}`.trim();
                const label = labelMode === "client" ? clientName || deal.name : deal.name;
                return (
                  <TR key={deal.id}>
                    <TD className={styles.dealCell}>
                      <Link className={styles.dealLink} href={`/deals/${deal.id}`}>
                        {label}
                      </Link>
                    </TD>
                    <TD className={styles.mutedCell}>{deal.account_type?.trim() || "—"}</TD>
                    <TD className={styles.mutedCell}>{deal.transferring_firm?.trim() || "—"}</TD>
                    <TD>
                      <Pill tone={stageTone(deal.stage)} dot>
                        {stageLabel(deal.stage)}
                      </Pill>
                    </TD>
                    <TD className={styles.amountCell}>{usd(deal.amount)}</TD>
                    <TD className={styles.mutedCell}>
                      <ExpectedCloseDate date={deal.close_date} stage={deal.stage} todayEt={todayEt} />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
        <div className={styles.footer}>
          <Link className={styles.allDealsLink} href="/deals">
            View all deals →
          </Link>
        </div>
      </div>
    </details>
  );
}
