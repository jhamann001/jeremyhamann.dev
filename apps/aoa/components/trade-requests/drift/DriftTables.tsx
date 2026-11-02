"use client";

import { useState, type KeyboardEvent } from "react";
import { Card } from "@/components/ui";
import type { AccountDriftHistoryRow, AccountDriftRunRow, AccountDriftStatus, DriftOverrideReason } from "@/lib/trade-requests/shared-types";
import {
  BUCKET_LABEL, OVERRIDE_REASON_SHORT, STATUS_LABEL, STATUS_TONE, formatSignedUsd, formatUsd, suggestOverride,
  templateSumIssuePct, truncTitle, type Bucket, type HouseholdGroup,
} from "@/lib/trade-requests/drift-view/model";
import { AccountDetail } from "./AccountDetail";
import styles from "./Drift.module.css";

// The account table and household cards (standalone DriftTabV2.tsx:367-468, 498-550, 1820-2386). Every cell
// carries its column name as `data-label`, which phone widths show beside the value instead of a header row.

export type DetailState = { detailRun: AccountDriftRunRow | null; detailLoading: boolean; detailError: string | null };

function StatusPill({ status }: { status: AccountDriftStatus }) {
  return <span className={styles.pill} data-tone={STATUS_TONE[status]} aria-label={STATUS_LABEL[status]}>{STATUS_LABEL[status]}</span>;
}

function BucketPill({ bucket, emphasised }: { bucket: Bucket | null; emphasised: boolean }) {
  if (bucket === null) return <span className={styles.muted}>—</span>;
  return <span className={styles.pill} data-tone={emphasised ? "caution" : "neutral"}>{BUCKET_LABEL[bucket]}</span>;
}

function SignedUsdCell({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className={styles.muted}>—</span>;
  return <span className={value < 0 ? styles.loss : styles.gain}>{formatSignedUsd(value)}</span>;
}

function AccountFlags({ row }: { row: AccountDriftHistoryRow }) {
  const transferPct = typeof row.transferInPct === "number" ? row.transferInPct : null;
  const showTransfer = transferPct !== null && transferPct >= 1;
  const showTransition = row.transitionConfirmed || row.transitionCandidate;
  const badTemplateTotal = templateSumIssuePct(row);
  if (!showTransfer && !showTransition && badTemplateTotal === null) return null;
  return (
    <div className={styles.chips}>
      {badTemplateTotal !== null && (
        <span className={styles.chip} data-tone="danger"
          title="The Meridian template's weights don't add up to 100%, so this account's drift numbers are distorted. Fix the template in Meridian.">
          ⚠ Template sums to {badTemplateTotal.toFixed(badTemplateTotal % 1 === 0 ? 0 : 1)}%
        </span>
      )}
      {showTransfer && <span className={styles.chip} data-tone="info">🔄 Transfer-in {Math.round(transferPct as number)}%</span>}
      {showTransition && <span className={styles.chip} data-tone="caution">{row.transitionConfirmed ? "🔄 Active transition" : "Transition candidate"}</span>}
    </div>
  );
}

function OverrideCell({ row, canOverride, onEdit, onAccept }: {
  row: AccountDriftHistoryRow;
  canOverride: boolean;
  onEdit: () => void;
  onAccept: (reason: DriftOverrideReason, note: string) => void;
}) {
  const ov = row.override ?? null;
  if (ov) {
    return (
      <div className={styles.overrideCell}>
        <span className={styles.pill} data-tone="neutral"
          title={`${ov.note ? ov.note + " — " : ""}set by ${ov.setByName}${ov.expiresOn ? `, expires ${ov.expiresOn}` : ""}`}>
          ✓ {OVERRIDE_REASON_SHORT[ov.reason]}
        </span>
        {canOverride && <button type="button" onClick={onEdit} className={styles.smallLink}>Edit</button>}
      </div>
    );
  }
  if (!canOverride) return <span className={styles.muted}>—</span>;
  const suggestion = suggestOverride(row);
  if (suggestion) {
    return (
      <div className={styles.overrideCell}>
        <span className={styles.pill} data-tone="info" title={suggestion.note}>Likely {OVERRIDE_REASON_SHORT[suggestion.reason]}</span>
        <div className={styles.overrideActions}>
          <button type="button" onClick={() => onAccept(suggestion.reason, suggestion.note)} className={styles.smallLink}>Accept</button>
          <button type="button" onClick={onEdit} className={styles.smallLink}>Set…</button>
        </div>
      </div>
    );
  }
  return <button type="button" onClick={onEdit} className={styles.smallLink}>Set override</button>;
}

function Chevron({ open }: { open: boolean }) {
  return <span className={open ? styles.chevronOpen : styles.chevron} aria-hidden="true" />;
}

function rowKeyDown(onToggle: () => void) {
  return (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };
}

function rowTone(row: AccountDriftHistoryRow): string | undefined {
  return row.status === "out" || row.status === "uninvested" ? row.status : undefined;
}

const ACCOUNT_HEADERS = ["Account", "Template", "Household", "Total value", "Worst bucket", "Δpp", "Unrealized G/L", "Realized G/L YTD", "Status", "Override"];
const NUMERIC = new Set(["Total value", "Δpp", "Unrealized G/L", "Realized G/L YTD"]);

function AccountRow({ row, isExpanded, detail, onToggle, canOverride, onEditOverride, onAcceptOverride }: {
  row: AccountDriftHistoryRow;
  isExpanded: boolean;
  detail: DetailState;
  onToggle: () => void;
  canOverride: boolean;
  onEditOverride: () => void;
  onAcceptOverride: (reason: DriftOverrideReason, note: string) => void;
}) {
  return (
    <>
      <tr className={styles.row} data-drift-row={row.accountId} data-tone={row.override ? undefined : rowTone(row)}
        data-overridden={row.override ? "true" : undefined} aria-expanded={isExpanded} tabIndex={0}
        onClick={onToggle} onKeyDown={rowKeyDown(onToggle)}>
        <td className={styles.expander} data-label=""><Chevron open={isExpanded} /></td>
        <td data-col="account" data-label="Account">
          <div className={styles.title}>
            <span>{truncTitle(row.accountTitle)}</span>
            <span className={styles.accountId}>{row.accountId}</span>
            <AccountFlags row={row} />
          </div>
        </td>
        <td data-col="template" data-label="Template">
          {row.templateName ? <span className={styles.template}>{row.templateName}</span> : <span className={styles.muted}>—</span>}
        </td>
        <td data-col="household" data-label="Household">{row.householdName || "unmapped"}</td>
        <td data-col="value" data-label="Total value" className={styles.num}>{formatUsd(row.totalValueUsd)}</td>
        <td data-col="bucket" data-label="Worst bucket"><BucketPill bucket={row.worstBucket} emphasised={row.status === "out"} /></td>
        <td data-col="delta" data-label="Δpp" className={`${styles.num} ${row.status === "out" ? styles.strong : ""}`}>
          {row.maxBucketDeltaPct === null ? "—" : row.maxBucketDeltaPct.toFixed(2)}
        </td>
        <td data-col="unrealized" data-label="Unrealized G/L" className={styles.num}><SignedUsdCell value={row.unrealizedGainUsd} /></td>
        <td data-col="realized" data-label="Realized G/L YTD" className={styles.num}><SignedUsdCell value={row.realizedGainYtdUsd} /></td>
        <td data-col="status" data-label="Status"><StatusPill status={row.status} /></td>
        <td data-col="override" data-label="Override" onClick={(e) => e.stopPropagation()}>
          <OverrideCell row={row} canOverride={canOverride} onEdit={onEditOverride} onAccept={onAcceptOverride} />
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={11} className={styles.detailCell} data-label="">
            <AccountDetail row={row} {...detail} />
          </td>
        </tr>
      )}
    </>
  );
}

export function AccountsView({ rows, expandedAccountId, detail, onToggle, isFiltered, totalRowCount, canOverride, onEditOverride, onAcceptOverride }: {
  rows: AccountDriftHistoryRow[];
  expandedAccountId: string | null;
  detail: DetailState;
  onToggle: (row: AccountDriftHistoryRow) => void;
  isFiltered: boolean;
  totalRowCount: number;
  canOverride: boolean;
  onEditOverride: (row: AccountDriftHistoryRow) => void;
  onAcceptOverride: (row: AccountDriftHistoryRow, reason: DriftOverrideReason, note: string) => void;
}) {
  return (
    <Card className={styles.tableCard}>
      <table className={`${styles.table} ${styles.stack}`} data-drift-table="accounts">
        <thead>
          <tr>
            <th className={styles.expander} aria-label="Expand row" />
            {ACCOUNT_HEADERS.map((h) => <th key={h} className={NUMERIC.has(h) ? styles.num : undefined}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AccountRow key={row.accountId} row={row} isExpanded={expandedAccountId === row.accountId} detail={detail}
              onToggle={() => onToggle(row)} canOverride={canOverride} onEditOverride={() => onEditOverride(row)}
              onAcceptOverride={(reason, note) => onAcceptOverride(row, reason, note)} />
          ))}
        </tbody>
      </table>
      <div className={styles.footer}>
        <span data-drift-footer>{isFiltered ? `Showing ${rows.length} of ${totalRowCount} accounts` : `${rows.length} accounts`}</span>
      </div>
    </Card>
  );
}

const HOUSEHOLD_HEADERS = ["Account", "Template", "Total value", "Worst bucket", "Δpp", "Unrealized G/L", "Realized G/L YTD", "Status"];

function HouseholdAccountRow({ row, isExpanded, detail, onToggle }: {
  row: AccountDriftHistoryRow;
  isExpanded: boolean;
  detail: DetailState;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={styles.row} data-drift-row={row.accountId} data-tone={rowTone(row)} aria-expanded={isExpanded} tabIndex={0}
        onClick={onToggle} onKeyDown={rowKeyDown(onToggle)}>
        <td className={styles.expander} data-label=""><Chevron open={isExpanded} /></td>
        <td data-col="account" data-label="Account">
          <div className={styles.title}>
            <span>{truncTitle(row.accountTitle)}</span>
            <span className={styles.accountId}>{row.accountId}</span>
            <AccountFlags row={row} />
          </div>
        </td>
        <td data-col="template" data-label="Template">
          {row.templateName ? <span className={styles.template}>{row.templateName}</span> : <span className={styles.muted}>—</span>}
        </td>
        <td data-col="value" data-label="Total value" className={styles.num}>{formatUsd(row.totalValueUsd)}</td>
        <td data-col="bucket" data-label="Worst bucket"><BucketPill bucket={row.worstBucket} emphasised={row.status === "out"} /></td>
        <td data-col="delta" data-label="Δpp" className={`${styles.num} ${row.status === "out" ? styles.strong : ""}`}>
          {row.maxBucketDeltaPct === null ? "—" : row.maxBucketDeltaPct.toFixed(2)}
        </td>
        <td data-col="unrealized" data-label="Unrealized G/L" className={styles.num}><SignedUsdCell value={row.unrealizedGainUsd} /></td>
        <td data-col="realized" data-label="Realized G/L YTD" className={styles.num}><SignedUsdCell value={row.realizedGainYtdUsd} /></td>
        <td data-col="status" data-label="Status"><StatusPill status={row.status} /></td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={9} className={styles.detailCell} data-label="">
            <AccountDetail row={row} {...detail} />
          </td>
        </tr>
      )}
    </>
  );
}

function HouseholdCard({ group, expandedAccountId, detail, onToggle }: {
  group: HouseholdGroup;
  expandedAccountId: string | null;
  detail: DetailState;
  onToggle: (row: AccountDriftHistoryRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasIssue = group.outCount > 0 || group.uninvestedCount > 0;
  return (
    <Card className={styles.household}>
      <button type="button" className={styles.householdHead} onClick={() => setOpen((prev) => !prev)} aria-expanded={open} data-drift-household>
        <span>
          <Chevron open={open} />
          <span className={styles.householdName}>{group.household}</span>
          <span className={styles.muted}>{formatUsd(group.totalValue)}</span>
        </span>
        <span className={styles.pill} data-tone={hasIssue ? "caution" : "ok"}>
          {hasIssue
            ? `${group.outCount} of ${group.accounts.length} out · max ${group.worstDelta.toFixed(2)}pp`
            : `All in tolerance · ${group.accounts.length} acct`}
        </span>
      </button>
      {open && (
        <table className={`${styles.table} ${styles.stack}`}>
          <thead>
            <tr>
              <th className={styles.expander} aria-label="Expand row" />
              {HOUSEHOLD_HEADERS.map((h) => <th key={h} className={NUMERIC.has(h) ? styles.num : undefined}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {group.accounts.map((row) => (
              <HouseholdAccountRow key={row.accountId} row={row} isExpanded={expandedAccountId === row.accountId} detail={detail}
                onToggle={() => onToggle(row)} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function HouseholdsView({ groups, expandedAccountId, detail, onToggle }: {
  groups: HouseholdGroup[];
  expandedAccountId: string | null;
  detail: DetailState;
  onToggle: (row: AccountDriftHistoryRow) => void;
}) {
  return (
    <div className={styles.households} data-drift-table="households">
      {groups.map((group) => (
        <HouseholdCard key={group.household} group={group} expandedAccountId={expandedAccountId} detail={detail} onToggle={onToggle} />
      ))}
    </div>
  );
}
