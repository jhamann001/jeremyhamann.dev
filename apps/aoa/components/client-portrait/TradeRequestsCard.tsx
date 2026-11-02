import { Card, Pill } from "@/components/ui";
import { usd } from "@/lib/format";
import { resolveTradeRequestStatus } from "@/lib/data/trade-request-status-catalog";
import type { TradeRequestSummary } from "@/lib/data/trade-requests";
import styles from "./TradeRequestsCard.module.css";

// Presentational "Trade requests" panel for the Client Portrait. Renders the
// REDACTED projection the Trade-Request app returns (account numbers arrive
// pre-masked and are shown verbatim — never unmasked here; no clientName). The
// fetch + graceful degrade live in <TradeRequestsSection> / lib/data/trade-requests.ts.
// Real data → NO PreviewBadge (matches the portrait's real-data sections).

const dash = (s: string | null): string => (s == null || s === "" ? "—" : s);

/** Safe date part of an ISO timestamp — no `new Date()` (avoids tz/SSR skew). */
const fmtDate = (iso: string | null): string =>
  iso && iso.length >= 10 ? iso.slice(0, 10) : "—";

/** Masked account list for a request — prefer the explicit selectedAccounts,
 *  fall back to the per-account metadata. Values are pre-masked at the source. */
function accountsLabel(r: TradeRequestSummary): string {
  const accts =
    r.selectedAccounts.length > 0
      ? r.selectedAccounts
      : r.accounts.map((a) => a.accountNumber).filter((n): n is string => !!n);
  return accts.length > 0 ? accts.join(", ") : "—";
}

export function TradeRequestsCard({
  requests,
}: {
  requests: TradeRequestSummary[];
}) {
  // Most-recent first — defensive copy (never mutate the prop array); the
  // endpoint already sorts but we do not rely on it.
  const sorted = [...requests].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );

  return (
    <Card>
      <details className={styles.disclosure}>
        <summary className={styles.summary}>
          <div className={styles.titleGroup}>
            <span className={styles.eyebrow}>
              Trade requests · from Trade-Request app
            </span>
            <h2 className={styles.title}>Trade requests</h2>
          </div>
          <span className={styles.headerMeta}>
            <Pill tone="gray">
              {sorted.length} {sorted.length === 1 ? "request" : "requests"}
            </Pill>
            <span className={styles.chevron} aria-hidden>
              ›
            </span>
          </span>
        </summary>
        <div className={styles.detailBody}>
          {sorted.length === 0 ? (
            <p className={styles.empty}>No trade requests.</p>
          ) : (
            <ul className={styles.list}>
              {sorted.map((r) => {
                const meta = resolveTradeRequestStatus(r.status);
                return (
                  <li key={r.id} className={styles.row}>
                    <div className={styles.rowMain}>
                      <Pill tone={meta.tone} dot>
                        {meta.label}
                      </Pill>
                      <span className={styles.tradeType}>
                        {dash(r.tradeType)}
                      </span>
                      <span className={styles.muted}>{usd(r.totalValue)}</span>
                      <span className={styles.date}>
                        {fmtDate(r.createdAt)}
                      </span>
                    </div>
                    <div className={styles.accountLine}>
                      {accountsLabel(r)} · {dash(r.advisor)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </details>
    </Card>
  );
}
