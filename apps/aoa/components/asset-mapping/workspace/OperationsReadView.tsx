import { Fragment, type ReactNode } from "react";
import type {
  AssetMapAccountTypeOverride,
  AssetMapAccountView,
  AssetMapHouseholdLiveExtras,
  AssetMapHouseholdView,
} from "@/lib/data/asset-map";
import { Button, Card, CardBody, CardHeader, Pill, StatTile, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import type { PillTone, StatusTone } from "@/components/ui";
import { utcDateTimeLabel } from "@/lib/display-date";
import { usdCents } from "@/lib/format";
import {
  COPY,
  LOT_TERM_LABEL,
  NOT_PROVIDED,
  costBasisBanner,
  costBasisPillLabel,
  costBasisPillTone,
  docStatusTone,
  granularityLabel,
  hasTaxLots,
  isCashPosition,
  lotTerm,
  ownerLabel,
  positionColumnCount,
  positionStatus,
  positionStatusTone,
  rolloverNoteFor,
  routingNotes,
  showCostBasisColumn,
  statusCounts,
  transferringLabel,
} from "./workspace-model";
import { accountLabel, editKey, positionLabel, transferringFromView, type EditState } from "./edits/edit-model";
import type { EditIntent } from "./edits/run-edit";
import { AccountOverflowMenu, AccountTypeConfirm, AccountTypeControl, DeleteAccountConfirm } from "./edits/AccountEditControls";
import { DeletePositionButton, PositionStatusControl, TransferringControl } from "./edits/PositionEditControls";
import { EditFailureText } from "./edits/EditFeedback";
import styles from "./AssetMappingWorkspace.module.css";

export type ReadViewProps = {
  household: AssetMapHouseholdView;
  liveExtras: AssetMapHouseholdLiveExtras | null;
  collapsedAccounts: string[];
  expandedLots: string[];
  onToggleAccount: (id: string) => void;
  onToggleLots: (id: string) => void;
};

export type OperationsEditProps = {
  state: EditState;
  onEdit: (intent: EditIntent) => void;
  onAskRemoveAccount: (accountId: string, label: string) => void;
  onAskAccountType: (accountId: string, fromType: string | null, fromOther: string | null, accountType: string, accountTypeOther: string | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

export function statusTone(status: string | null): PillTone {
  return positionStatusTone(status);
}

export const POSITION_HEADERS = {
  asset: "Extracted Asset",
  shares: "Shares",
  value: "Value",
  costBasis: "Cost Basis",
  classification: "Classification",
  status: "Rule Engine Status",
  transferring: "Transferring",
  routing: "Routing Logic Applied",
} as const;

function shares(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function stalenessTitle(acc: AssetMapAccountView): string {
  return acc.statementDate
    ? `Statement dated ${acc.statementDate} — ${acc.statementAgeDays} days old. Holdings/values may be out of date; verify before relying on them.`
    : "Statement is older than the freshness window; verify values are current.";
}

function manualBadgeText(o: AssetMapAccountTypeOverride): string {
  return ["Manual", o.by, utcDateTimeLabel(o.at)].filter(Boolean).join(" · ");
}

function Notice({ tone, title, children }: { tone: StatusTone; title?: string; children: ReactNode }) {
  return (
    <div className={styles.notice} data-tone={tone}>
      {title ? <span className={styles.noticeTitle}>{title}</span> : null}
      {children}
    </div>
  );
}

export function OperationsReadView({
  household,
  liveExtras,
  collapsedAccounts,
  expandedLots,
  onToggleAccount,
  onToggleLots,
  edits,
  destinations,
  accountTransfer,
  linkCard,
}: ReadViewProps & {
  edits?: OperationsEditProps | null;
  destinations?: ReactNode;
  accountTransfer?: (account: AssetMapAccountView) => ReactNode;
  linkCard?: ReactNode;
}) {
  const counts = statusCounts(household);
  const showIngestion = household.docsTotal != null || household.docsExtracted != null;
  return (
    <div className={styles.section}>
      {showIngestion ? (
        <details key={household.id} className={styles.disclosure} data-section="documents">
          <summary className={styles.disclosureSummary}>
            <strong>{`Document Ingestion — ${household.docsTotal ?? 0} total, ${household.docsExtracted ?? 0} extracted`}</strong>
          </summary>
          <div className={styles.disclosureBody}>
            {(liveExtras?.docResults ?? []).map((doc, idx) => (
              <div key={idx} className={styles.docRow}>
                <span>{doc.filename}</span>
                <span className={styles.badges}>
                  {doc.status === "extracted" ? (
                    <span className={styles.muted}>{`${doc.accountsExtracted} acct, ${doc.positionsExtracted} pos`}</span>
                  ) : null}
                  {doc.reason ? <span className={styles.muted}>{doc.reason}</span> : null}
                  <Pill tone={docStatusTone(doc.status)}>{doc.status ?? "—"}</Pill>
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className={styles.tiles}>
        <StatTile label="Total Positions" value={counts.total} />
        <StatTile label="ACAT Eligible" value={counts.acat} tone="ok" />
        <StatTile label="Manual Review" value={counts.review} tone="caution" />
        <StatTile label="Unsupported" value={counts.unsupported} tone="blocked" />
        <StatTile label="Liquidate" value={counts.liquidate} tone="attention" />
        <StatTile label="ACH/WIRE" value={counts.transfer} tone="info" />
      </div>
      {linkCard ?? null}
      {destinations ?? null}

      {household.accounts.map((acc) => {
        const expanded = !collapsedAccounts.includes(acc.id);
        const costBasisLabel = costBasisPillLabel(acc);
        const showCB = showCostBasisColumn(acc);
        const typeKey = editKey("accountType", acc.id);
        const removeKey = editKey("removeAccount", acc.id);
        const confirm = edits?.state.confirm?.accountId === acc.id ? edits.state.confirm : null;
        const columns = positionColumnCount(acc, Boolean(edits));
        const banner = costBasisBanner(acc);
        const notices = [
          acc.validationStatus === "WARNING" && acc.validationIssues.length > 0 ? (
            <Notice key="validation" tone="caution" title="Extraction Validation Warning">
              <ul className={styles.list}>
                {acc.validationIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </Notice>
          ) : null,
          banner ? (
            <Notice key="costBasis" tone="caution">
              {`Cost basis missing for ${banner.missing} of ${banner.securities} securities: `}
              <strong>{banner.names.join(", ") + (banner.more > 0 ? `, +${banner.more} more` : "")}</strong>
              {". The tax transition analysis will treat these as unknown basis."}
            </Notice>
          ) : null,
          acc.isRollover ? (
            <Notice key="rollover" tone="rollover">
              {rolloverNoteFor(acc.id, liveExtras)}
            </Notice>
          ) : null,
          acc.isInherited ? (
            <Notice key="inherited" tone="caution" title="Inherited / Beneficiary Account">
              {acc.inheritedNotes ?? COPY.inheritedFallback}
            </Notice>
          ) : null,
          acc.apexRestriction ? (
            <Notice key="apex" tone="blocked" title="Apex Policy Engine Hard-Block">
              {acc.apexRestriction}
            </Notice>
          ) : null,
        ].filter((n) => n != null);
        return (
          <Card key={acc.id} data-account-card="" data-expanded={expanded ? "true" : "false"}>
            <CardHeader>
              <div className={styles.accountGrid} data-account-grid="">
                <button
                  type="button"
                  className={styles.accountHead}
                  aria-expanded={expanded}
                  title={expanded ? COPY.collapseAccount : COPY.expandAccount}
                  onClick={() => onToggleAccount(acc.id)}
                >
                  <span className={styles.chevron} aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                  <strong>{acc.custodian}</strong>
                  <span>{acc.accountType}</span>
                  {acc.accountTypeOverride ? (
                    <span data-account-type-manual="" title={manualBadgeText(acc.accountTypeOverride)}>
                      <Pill tone="info">{manualBadgeText(acc.accountTypeOverride)}</Pill>
                    </span>
                  ) : null}
                  {acc.isRollover ? <Pill tone="rollover">Rollover</Pill> : null}
                  {acc.validationStatus && acc.validationStatus !== "VALID" ? (
                    <Pill tone={acc.validationStatus === "WARNING" ? "caution" : "danger"}>{acc.validationStatus}</Pill>
                  ) : null}
                  {acc.isStale ? (
                    <span title={stalenessTitle(acc)}>
                      <Pill tone="caution">{acc.statementAgeDays != null ? `${acc.statementAgeDays}d old` : "stale"}</Pill>
                    </span>
                  ) : null}
                  {costBasisLabel != null ? <Pill tone={costBasisPillTone(acc)}>{costBasisLabel}</Pill> : null}
                </button>
                <strong className={styles.accountValue}>{usdCents(acc.totalValue)}</strong>
                <span className={styles.accountMeta}>
                  <span>{acc.accountNumberMasked}</span>
                  <span className={acc.accountHolder?.trim() ? undefined : styles.muted}>{ownerLabel(acc)}</span>
                  {acc.custodianIntel ? (
                    <>
                      <span>{`DTCC: ${acc.custodianIntel.dtccNumber || "N/A"}`}</span>
                      <span>{acc.custodianIntel.acatTimeline || "Unknown"}</span>
                    </>
                  ) : null}
                </span>
                <span className={styles.accountActions}>
                  {accountTransfer ? accountTransfer(acc) : null}
                  {edits ? (
                    <AccountOverflowMenu
                      pending={edits.state.pending.includes(removeKey)}
                      onDelete={() => edits.onAskRemoveAccount(acc.id, accountLabel(acc))}
                    />
                  ) : null}
                </span>
                {edits ? (
                  <div className={styles.editRow} data-account-edit-row="">
                    <AccountTypeControl
                      currentType={acc.accountType}
                      currentOther={acc.accountTypeOther}
                      pending={edits.state.pending.includes(typeKey)}
                      onRequest={(accountType, accountTypeOther) =>
                        edits.onAskAccountType(acc.id, acc.accountType, acc.accountTypeOther, accountType, accountTypeOther)
                      }
                    />
                    {edits.state.failure?.key === typeKey || edits.state.failure?.key === removeKey ? (
                      <EditFailureText text={edits.state.failure.text} />
                    ) : null}
                    {confirm?.kind === "accountType" ? (
                      <AccountTypeConfirm
                        from={confirm.from}
                        accountType={confirm.accountType}
                        accountTypeOther={confirm.accountTypeOther}
                        onConfirm={edits.onConfirm}
                        onCancel={edits.onCancel}
                      />
                    ) : null}
                    {confirm?.kind === "removeAccount" ? (
                      <DeleteAccountConfirm label={confirm.label} onConfirm={edits.onConfirm} onCancel={edits.onCancel} />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </CardHeader>
            {expanded || notices.length > 0 ? (
              <CardBody>
                {notices}
                {expanded ? (
                  <div className={styles.tableScroll} data-scroll="horizontal">
                    <Table className={styles.positions}>
                      <THead>
                        <TR>
                          <TH>{POSITION_HEADERS.asset}</TH>
                          <TH>{POSITION_HEADERS.shares}</TH>
                          <TH>{POSITION_HEADERS.value}</TH>
                          {showCB ? <TH>{POSITION_HEADERS.costBasis}</TH> : null}
                          <TH>{POSITION_HEADERS.classification}</TH>
                          <TH>{POSITION_HEADERS.status}</TH>
                          <TH>{POSITION_HEADERS.transferring}</TH>
                          <TH>{POSITION_HEADERS.routing}</TH>
                          {edits ? <TH aria-label="Actions" /> : null}
                        </TR>
                      </THead>
                      <TBody>
                        {acc.positions.map((p) => {
                          const status = positionStatus(p);
                          const lotsOpen = expandedLots.includes(p.id);
                          const notes = routingNotes(p);
                          return (
                            <Fragment key={p.id}>
                              <TR>
                                <TD>
                                  <strong>{p.symbol || "—"}</strong>
                                  <div className={styles.muted}>{p.description}</div>
                                  {hasTaxLots(p) ? (
                                    <span className={styles.rowToggles}>
                                      <Button variant="ghost" size="sm" onClick={() => onToggleLots(p.id)}>
                                        {lotsOpen ? "Hide tax lots" : `Show ${p.lots.length} tax lots`}
                                      </Button>
                                    </span>
                                  ) : null}
                                </TD>
                                <TD>{shares(p.quantity)}</TD>
                                <TD>{usdCents(p.marketValue)}</TD>
                                {showCB ? (
                                  <TD>
                                    {p.costBasis != null ? (
                                      <>
                                        {usdCents(p.costBasis)}
                                        {granularityLabel(p) != null ? (
                                          <span className={styles.granularity}>{granularityLabel(p)}</span>
                                        ) : null}
                                      </>
                                    ) : !isCashPosition(p) ? (
                                      <span className={styles.notProvided}>{NOT_PROVIDED}</span>
                                    ) : (
                                      "—"
                                    )}
                                  </TD>
                                ) : null}
                                <TD>{p.assetType || "—"}</TD>
                                <TD>
                                  {edits ? (
                                    <>
                                      <PositionStatusControl
                                        value={status}
                                        pending={edits.state.pending.includes(editKey("positionStatus", p.id))}
                                        onSave={(s) => edits.onEdit({ kind: "positionStatus", positionId: p.id, status: s })}
                                      />
                                      {edits.state.failure?.key === editKey("positionStatus", p.id) ? (
                                        <EditFailureText text={edits.state.failure.text} />
                                      ) : null}
                                    </>
                                  ) : status ? (
                                    <Pill tone={statusTone(status)}>{status}</Pill>
                                  ) : (
                                    "—"
                                  )}
                                </TD>
                                <TD>
                                  {edits ? (
                                    <>
                                      <TransferringControl
                                        value={transferringFromView(p.transferring)}
                                        pending={edits.state.pending.includes(editKey("positionTransferring", p.id))}
                                        onSave={(value) => edits.onEdit({ kind: "positionTransferring", positionId: p.id, value })}
                                      />
                                      {edits.state.failure?.key === editKey("positionTransferring", p.id) ? (
                                        <EditFailureText text={edits.state.failure.text} />
                                      ) : null}
                                    </>
                                  ) : (
                                    transferringLabel(p.transferring)
                                  )}
                                </TD>
                                <TD className={styles.routingCell}>{notes ?? "—"}</TD>
                                {edits ? (
                                  <TD>
                                    <DeletePositionButton
                                      label={positionLabel(p)}
                                      pending={edits.state.pending.includes(editKey("removePosition", p.id))}
                                      onDelete={() => edits.onEdit({ kind: "removePosition", positionId: p.id, label: positionLabel(p) })}
                                    />
                                    {edits.state.failure?.key === editKey("removePosition", p.id) ? (
                                      <EditFailureText text={edits.state.failure.text} />
                                    ) : null}
                                  </TD>
                                ) : null}
                              </TR>
                              {lotsOpen && hasTaxLots(p) ? (
                                <TR>
                                  <TD colSpan={columns} className={styles.lots}>
                                    <div className={styles.noticeTitle}>Tax lots (as printed on statement)</div>
                                    <ul className={styles.list}>
                                      {p.lots.map((lot, i) => {
                                        const term = lotTerm(lot.acquisitionDate, acc.statementDate);
                                        return (
                                          <li key={i}>
                                            {`Acquired ${lot.acquisitionDate || "—"} · ${shares(lot.quantity)} sh · basis ${lot.costBasis != null ? usdCents(lot.costBasis) : "—"}${term ? ` · ${LOT_TERM_LABEL[term]}` : ""}`}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </TD>
                                </TR>
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </TBody>
                    </Table>
                  </div>
                ) : null}
              </CardBody>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
