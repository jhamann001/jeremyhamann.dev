import { Card, CardHeader, CardBody, Pill } from "@/components/ui";
import type { PillTone } from "@/components/ui";
import { usd, usdCents, usdFromCents } from "@/lib/format";
import type { AcatToneKind } from "@/lib/data/acat-lane";
import { resolveAcatStatus } from "@/lib/data/acat-status-catalog";
import type { AcatStatus, AcatStatusAsset } from "@/lib/data/acat-status";
import styles from "./AcatStatusCard.module.css";

// Live ACAT-status card (ticket) — renders the REDACTED projection the ACAT
// tracker returns for a transfer's linked acatTransferId. No clientName /
// wealthAdvisor is present; account / cusip / DTCC numbers arrive pre-masked
// and are shown verbatim (never unmasked here). Purely presentational — the
// fetch + graceful degrade live in <AcatStatusSection> / lib/data/acat-status.ts.

// Status tone → Pill tone. The friendly label + tone come from the canonical
// status catalog (ticket) — the SAME source the ACAT Tracking list and drawer
// use — so this card's pill always matches the tab it was opened from.
const TONE: Record<AcatToneKind, PillTone> = {
  accepted: "green",
  submitted: "amber",
  rejected: "red",
  neutral: "gray",
};

const qty = (n: number | null): string =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 4 });

const dash = (s: string | null): string => (s == null || s === "" ? "—" : s);

/** A row's actual-vs-expected mismatch or an explicit tracker `issue` flag. */
function assetFlagged(a: AcatStatusAsset): boolean {
  if (a.issue) return true;
  if (a.expectedQty != null && a.actualQty != null)
    return a.actualQty !== a.expectedQty;
  return false;
}

export function AcatStatusCard({ status, summaryOnly = false }: { status: AcatStatus; summaryOnly?: boolean }) {
  const flaggedCount = status.assets.filter(assetFlagged).length;
  const statusMeta = resolveAcatStatus(status.status);

  if (summaryOnly) {
    return (
      <div className={styles.compact} aria-label="Live ACAT status">
        <div>
          <span className={styles.eyebrow}>Live ACAT status · from tracker</span>
          <span className={styles.title}>{dash(status.transferringContra)}</span>
        </div>
        <Pill tone={TONE[statusMeta.tone]} dot>{statusMeta.label}</Pill>
        {flaggedCount > 0 && <Pill tone="amber">{flaggedCount} of {status.assets.length} positions need attention</Pill>}
        <span className={styles.empty}>Details in Information &amp; linked records below.</span>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <span className={styles.eyebrow}>Live ACAT status · from tracker</span>
          <h2 className={styles.title}>
            {dash(status.direction)}
            {status.type ? ` · ${status.type}` : ""}
          </h2>
        </div>
        <span className={styles.headerPill}>
          <Pill tone={TONE[statusMeta.tone]} dot>
            {statusMeta.label}
          </Pill>
        </span>
      </CardHeader>
      <CardBody>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Transferring firm</dt>
            <dd>{dash(status.transferringContra)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Account type</dt>
            <dd>{dash(status.accountType)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Apex account</dt>
            <dd className={styles.mono}>{dash(status.apexAccountId)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Statement account</dt>
            <dd className={styles.mono}>{dash(status.statementAccountNumber)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>DTCC number</dt>
            <dd className={styles.mono}>{dash(status.dtccNumber)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Control number</dt>
            <dd className={styles.mono}>{dash(status.controlNumber)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Method</dt>
            <dd>{dash(status.methodRequested)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>ACAT date</dt>
            <dd>{dash(status.acatDate)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Statement amount</dt>
            <dd>
              {status.statementAmount == null
                ? "—"
                : usdFromCents(status.statementAmount)}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Fee</dt>
            <dd>
              {status.feeCharged == null
                ? "—"
                : status.feeCharged
                  ? `Charged${status.feeAmount != null ? ` · ${usd(status.feeAmount)}` : ""}`
                  : "None"}
            </dd>
          </div>
        </dl>

        <div className={styles.assetsHead}>
          <span className={styles.assetsTitle}>Positions</span>
          {flaggedCount > 0 && (
            <Pill tone="amber">
              {flaggedCount} of {status.assets.length} need attention
            </Pill>
          )}
        </div>

        {status.assets.length === 0 ? (
          <p className={styles.empty}>No asset lines on this ACAT yet.</p>
        ) : (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className={styles.num}>Expected</th>
                  <th className={styles.num}>Actual</th>
                  <th>Issue</th>
                  <th className={styles.num}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {status.assets.map((a, i) => {
                  const flagged = assetFlagged(a);
                  return (
                    <tr
                      key={`${a.symbol ?? a.cusip ?? "row"}-${i}`}
                      className={flagged ? styles.rowFlagged : undefined}
                    >
                      <td>
                        <span className={styles.symbol}>{dash(a.symbol)}</span>
                        {a.description && (
                          <span className={styles.desc}>{a.description}</span>
                        )}
                        {a.cusip && (
                          <span className={styles.cusip}>{a.cusip}</span>
                        )}
                      </td>
                      <td className={styles.num}>{qty(a.expectedQty)}</td>
                      <td className={styles.num}>{qty(a.actualQty)}</td>
                      <td>
                        {a.issue ? (
                          <Pill tone="red">{a.issue}</Pill>
                        ) : (
                          <span className={styles.mapped}>
                            <span aria-hidden>✓</span> Mapped
                          </span>
                        )}
                      </td>
                      <td className={styles.num}>
                        {a.amount == null ? "—" : usdCents(a.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
