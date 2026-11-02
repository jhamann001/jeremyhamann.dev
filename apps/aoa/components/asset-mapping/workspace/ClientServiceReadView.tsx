import type { AssetMapAccountView, AssetMapPositionView } from "@/lib/data/asset-map";
import { Card, CardBody, CardHeader, Pill, StatTile } from "@/components/ui";
import { usdCents } from "@/lib/format";
import {
  COPY,
  clientServiceSummary,
  documentsNotProcessed,
  positionStatus,
  rolloverNoteFor,
  routingNotes,
  type ClientServiceSummary,
  type SummaryItem,
} from "./workspace-model";
import { statusTone, type ReadViewProps } from "./OperationsReadView";
import styles from "./AssetMappingWorkspace.module.css";

// Must match the account card's wording in the operations view.
export const OWNER_NOT_IDENTIFIED = "Owner not identified";
export const ALL_ASSETS_CLEARED = "All assets cleared";
export const ROLLOVER_ASSET_LIMIT = 5;

function accountTitle(item: SummaryItem): string {
  const a = item.account;
  return [a.custodian, a.accountType, a.accountNumberMasked ? `(${a.accountNumberMasked})` : null]
    .filter(Boolean)
    .join(" ");
}

export function ownerLine(account: AssetMapAccountView): string {
  const holder = account.accountHolder?.trim();
  return holder ? `Owner: ${holder}` : OWNER_NOT_IDENTIFIED;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function positionCountLabel(account: AssetMapAccountView): string {
  return plural(account.positions.length, "position", "positions");
}

export type ClientServiceCounts = { rollover: number; needsReview: number; unsupported: number };

export function clientServiceCounts(s: ClientServiceSummary): ClientServiceCounts {
  return { rollover: s.rollover.length, needsReview: s.action.length, unsupported: s.unsupported.length };
}

export function readinessSentence(s: ClientServiceSummary): string {
  const c = clientServiceCounts(s);
  return (
    `${s.percentReady}% of the household value is ready for ACAT transfer. ` +
    `${plural(c.rollover, "account requires", "accounts require")} rollover, ` +
    `${plural(c.needsReview, "account needs", "accounts need")} review, and ` +
    `${plural(c.unsupported, "account is", "accounts are")} unsupported.`
  );
}

export function rolloverAssets(item: SummaryItem): AssetMapPositionView[] {
  return item.account.positions.filter((p) => !item.problemPositions.includes(p));
}

export function allAssetsCleared(s: ClientServiceSummary): boolean {
  const items = [...s.ready, ...s.rollover, ...s.action, ...s.unsupported];
  return (
    s.action.length === 0 &&
    s.unsupported.length === 0 &&
    items.some((i) => i.account.positions.length > 0) &&
    items.every((i) => i.problemPositions.length === 0)
  );
}

function OwnerLine({ account }: { account: AssetMapAccountView }) {
  return <div className={styles.muted}>{ownerLine(account)}</div>;
}

function ProblemPositions({ positions }: { positions: AssetMapPositionView[] }) {
  return (
    <ul className={styles.list}>
      {positions.map((p) => {
        const status = positionStatus(p);
        return (
          <li key={p.id} className={styles.docRow}>
            <span className={styles.badges}>
              {status ? <Pill tone={statusTone(status)}>{status}</Pill> : null}
              <strong>{p.symbol || "—"}</strong>
              <span className={styles.muted}>{p.description}</span>
              <span>{routingNotes(p)}</span>
            </span>
            <span>{usdCents(p.marketValue)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RolloverAssets({ item }: { item: SummaryItem }) {
  const assets = rolloverAssets(item);
  if (assets.length === 0) return null;
  const hidden = assets.length - ROLLOVER_ASSET_LIMIT;
  return (
    <div>
      <strong>Assets to roll over</strong>
      <ul className={styles.list}>
        {assets.slice(0, ROLLOVER_ASSET_LIMIT).map((p) => (
          <li key={p.id} className={styles.docRow}>
            <span className={styles.badges}>
              <strong>{p.symbol || "—"}</strong>
              <span className={styles.muted}>{p.description}</span>
            </span>
            <span>{usdCents(p.marketValue)}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? <p className={styles.muted}>{`and ${hidden} more`}</p> : null}
    </div>
  );
}

function DataQualityIssues({ account }: { account: AssetMapAccountView }) {
  if (account.validationIssues.length === 0) return null;
  return (
    <div className={styles.notice}>
      <span className={styles.noticeTitle}>Data quality issues</span>
      <ul className={styles.list}>
        {account.validationIssues.map((issue, i) => (
          <li key={i}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}

// In this view `collapsedAccounts` membership means EXPANDED: Action Plan and
// Unsupported groups start closed, as in the current app.
export function ClientServiceReadView({ household, liveExtras, collapsedAccounts, onToggleAccount }: ReadViewProps) {
  const s = clientServiceSummary(household);
  const unprocessed = documentsNotProcessed(liveExtras);
  const cleared = allAssetsCleared(s);
  return (
    <div className={styles.section}>
      <Card>
        <CardHeader>
          <h3>Transfer Readiness</h3>
        </CardHeader>
        <CardBody>
          <p>{readinessSentence(s)}</p>
          {cleared ? <Pill tone="ok">{ALL_ASSETS_CLEARED}</Pill> : null}
          <div className={styles.toggle}>
            <StatTile label="Ready to ACAT" value={usdCents(s.transferReadyValue)} />
            {s.rollover.length > 0 ? <StatTile label="Requires Rollover" value={usdCents(s.rolloverValue)} /> : null}
          </div>
        </CardBody>
      </Card>

      {s.hasExtractionQualityNotice ? (
        <div className={styles.notice}>
          <span className={styles.noticeTitle}>Extraction Quality Notice</span>
          One or more accounts have data quality warnings (e.g., value mismatches between reported totals and
          extracted positions). These accounts appear under Action Plan below and should be verified before
          proceeding.
        </div>
      ) : null}

      <section className={styles.section}>
        <h3>Ready for ACAT Transfer</h3>
        {s.ready.length === 0 ? (
          <p className={styles.muted}>No accounts are fully ready for automated ACAT transfer.</p>
        ) : (
          <ul className={styles.list}>
            {s.ready.map((item) => (
              <li key={item.account.id}>
                <div className={styles.docRow}>
                  <span>{accountTitle(item)}</span>
                  <strong>{usdCents(item.account.totalValue)}</strong>
                </div>
                <OwnerLine account={item.account} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {s.rollover.length > 0 ? (
        <section className={styles.section}>
          <h3>Rollover Required</h3>
          <ul className={styles.list}>
            {s.rollover.map((item) => (
              <li key={item.account.id}>
                <div className={styles.docRow}>
                  <span>{accountTitle(item)}</span>
                  <strong>{usdCents(item.account.totalValue)}</strong>
                </div>
                <OwnerLine account={item.account} />
                <div className={styles.notice}>{rolloverNoteFor(item.account.id, liveExtras)}</div>
                <DataQualityIssues account={item.account} />
                <RolloverAssets item={item} />
                {item.problemPositions.length > 0 ? (
                  <div>
                    <strong>Exceptions</strong>
                    <ProblemPositions positions={item.problemPositions} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.section}>
        <h3>Action Plan (Exceptions &amp; Manual Items)</h3>
        {s.action.length === 0 ? (
          <p className={styles.muted}>No accounts require manual action or review.</p>
        ) : (
          <ul className={styles.list}>
            {s.action.map((item) => {
              const expanded = collapsedAccounts.includes(item.account.id);
              return (
                <li key={item.account.id}>
                  <button
                    type="button"
                    className={styles.accountHead}
                    aria-expanded={expanded}
                    onClick={() => onToggleAccount(item.account.id)}
                  >
                    <span>{accountTitle(item)}</span>
                    {item.account.validationStatus ? <Pill tone="caution">{item.account.validationStatus}</Pill> : null}
                  </button>
                  <OwnerLine account={item.account} />
                  {expanded ? (
                    <>
                      <DataQualityIssues account={item.account} />
                      <ProblemPositions positions={item.problemPositions} />
                    </>
                  ) : (
                    <div className={styles.muted}>{positionCountLabel(item.account)}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {s.unsupported.length > 0 ? (
        <section className={styles.section}>
          <h3>Unsupported Accounts</h3>
          <ul className={styles.list}>
            {s.unsupported.map((item) => {
              const expanded = collapsedAccounts.includes(item.account.id);
              return (
                <li key={item.account.id}>
                  <button
                    type="button"
                    className={styles.accountHead}
                    aria-expanded={expanded}
                    onClick={() => onToggleAccount(item.account.id)}
                  >
                    <span>{accountTitle(item)}</span>
                    <span>{`Unsupported: ${item.account.apexRestriction}`}</span>
                  </button>
                  <OwnerLine account={item.account} />
                  {expanded ? (
                    <>
                      <DataQualityIssues account={item.account} />
                      <ProblemPositions positions={item.problemPositions} />
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {unprocessed.length > 0 ? (
        <section className={styles.section}>
          <h3>{COPY.documentsNotProcessed}</h3>
          <ul className={styles.list}>
            {unprocessed.map((doc, idx) => (
              <li key={idx} className={styles.docRow}>
                <span>{doc.filename}</span>
                <span className={styles.badges}>
                  <span className={styles.muted}>{doc.reason}</span>
                  <span>{doc.status}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
