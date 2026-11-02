"use client";

import { useEffect, useRef, useState } from "react";
import { loadAccountExclusions } from "@/app/(authenticated)/trade-requests/new/actions";
import { Button, Pill } from "@/components/ui";
import {
  EXCLUSIONS_COPY,
  accountExclusionGroups,
  formatExclusionSide,
  formatRestrictionReason,
  manageAccountRestrictionsShown,
  type ExclusionsByEntity,
} from "@/lib/trade-requests/new-request-exclusions";
import { useNewRequestDraft } from "../NewRequestDraft";
import { ManageExclusionsDialog } from "./ManageExclusionsDialog";
import styles from "./Exclusions.module.css";

type Load = { status: "idle" | "loading" } | { status: "loaded"; key: string; byAccount: ExclusionsByEntity } | { status: "failed"; key: string };

/**
 * Account-level standing exclusions of the selected accounts (AC-92, AC-111),
 * with Manage Account Restrictions (AC-121); re-read after that dialog closes
 * with a saved change (AC-146).
 */
export function AccountExclusionsPanel() {
  const { context } = useNewRequestDraft();
  const groups = accountExclusionGroups(context);
  const accountIds = groups.map((group) => group.accountId);
  const idsKey = JSON.stringify(accountIds);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    const ids = JSON.parse(idsKey) as string[];
    if (ids.length === 0) {
      setLoad({ status: "idle" });
      return;
    }
    setLoad({ status: "loading" });
    loadAccountExclusions(ids)
      .then((result) => {
        if (sequence.current === current) setLoad(result.ok ? { status: "loaded", key: idsKey, byAccount: result.data } : { status: "failed", key: idsKey });
      })
      .catch(() => {
        if (sequence.current === current) setLoad({ status: "failed", key: idsKey });
      });
  }, [idsKey, refresh]);

  const settled = (load.status === "loaded" || load.status === "failed") && load.key === idsKey;
  const loading = accountIds.length > 0 && !settled;
  const byAccount = load.status === "loaded" && settled ? load.byAccount : {};
  const rows = groups.map((group) => ({ ...group, exclusions: byAccount[group.accountId] ?? [] }));
  const count = rows.reduce((total, row) => total + row.exclusions.length, 0);
  const showClient = context.draft.clientIds.length > 1;

  return (
    <div className={styles.panel} role="region" aria-labelledby="new-request-account-exclusions" data-testid="account-exclusions">
      <div className={styles.panelHead}>
        <div>
          <Pill tone="info">{EXCLUSIONS_COPY.reviewBeforeSubmit}</Pill>
          <p id="new-request-account-exclusions" className={styles.panelTitle}>
            {EXCLUSIONS_COPY.accountPanelTitle} <span className={styles.panelCount}>({count} total)</span>
          </p>
        </div>
        {manageAccountRestrictionsShown(context) && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <span aria-hidden="true">⚙ </span>{EXCLUSIONS_COPY.manageAccountRestrictions}
          </Button>
        )}
      </div>
      <p className={styles.panelLead}>{EXCLUSIONS_COPY.accountPanelLead}</p>
      {loading && <p className={styles.muted} role="status">{EXCLUSIONS_COPY.accountLoading}</p>}
      {settled && load.status === "failed" && <p className={styles.danger} role="alert">{EXCLUSIONS_COPY.accountLoadFailed}</p>}
      {!loading && !(settled && load.status === "failed") && count === 0 && <p className={styles.muted}>{EXCLUSIONS_COPY.accountEmpty}</p>}
      {settled && load.status === "loaded" && count > 0 && (
        <div className={styles.groups}>
          {rows.filter((row) => row.exclusions.length > 0).map((row) => (
            <div key={row.accountId} className={styles.group}>
              <p className={styles.groupTitle}>{row.accountNumber}{showClient ? ` — ${row.clientName}` : ""}</p>
              <div className={`${styles.grid} ${styles.gridHead}`} aria-hidden="true">
                <span>{EXCLUSIONS_COPY.ticker}</span><span>{EXCLUSIONS_COPY.lock}</span><span>{EXCLUSIONS_COPY.reason}</span>
              </div>
              <ul className={styles.gridRows} aria-label={`${row.accountNumber} exclusions`}>
                {row.exclusions.map((entry) => (
                  <li key={entry.id} className={`${styles.grid} ${styles.gridRow}`}>
                    <span className={styles.ticker}>{entry.ticker}</span>
                    <span className={styles.lock}>{formatExclusionSide(entry)}</span>
                    <span className={styles.reason}>{formatRestrictionReason(entry.reason) || EXCLUSIONS_COPY.noReason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {open && manageAccountRestrictionsShown(context) && (
        <ManageExclusionsDialog
          scope="account"
          entities={groups.map((group) => ({
            id: group.accountId,
            label: group.clientName ? `${group.accountNumber} — ${group.clientName}` : group.accountNumber,
            shortLabel: group.accountNumber,
          }))}
          onClose={() => setOpen(false)}
          onSavedChanges={() => setRefresh((n) => n + 1)}
        />
      )}
    </div>
  );
}
