"use client";

import { useRef, useState, useTransition } from "react";
import { Button, Pill } from "@/components/ui";
import { usdCompact } from "@/lib/format";
import type { KnownAccountRow, KnownFolder } from "@/lib/data/asset-map-review";
import {
  confirmAccountOwners,
  rejectAccount,
} from "@/app/(authenticated)/asset-mapping-review/actions";
import styles from "./KnownAccountsList.module.css";

// The "already known" surface (S2, the acat-tracking grouped-by-status idiom) —
// accounts the operator does NOT have to act on, kept OUT of the action queue so
// it stays focused. Collapsed by default. Two kinds per account:
//   • CONFIRMED — human-attributed; read-only owner display.
//   • AUTO_LINKED — machine-decided; shows the machine's owner(s) with an optional
//     one-click "Confirm" (sign off → CONFIRMED, preserved by future reconciles)
//     or "Reject" (re-queue as rejected). Signing off reuses confirmAccountOwners
//     with the stored owner set; the folder is already resolved so no household
//     pick is needed. NO write happens here — the action re-gates + runs under RLS.
// PII: owner names + a MASKED account number are shown (the ops-only surface's
// purpose); the full number is never displayed or logged.

function ownerLabel(acct: KnownAccountRow): string {
  if (acct.isEntity) return "Entity — no person (trust / LLC / estate)";
  const names = acct.owners.map((o) => o.name || o.clientSfId || "—").filter(Boolean);
  return names.length > 0 ? names.join(" & ") : "—";
}

export function KnownAccountsList({ folders }: { folders: KnownFolder[] }) {
  if (folders.length === 0) return null;

  const total = folders.reduce((n, f) => n + f.accounts.length, 0);

  return (
    <div className={styles.wrap}>
      <div className={styles.groupHead}>
        <h2 className={styles.groupTitle}>Already known</h2>
        <span className={styles.count}>{total}</span>
      </div>
      <p className={styles.groupHint}>
        Accounts the system has already resolved — machine-linked or confirmed. No
        action needed; sign off or re-open a machine link if you want to.
      </p>
      <ul className={styles.folders}>
        {folders.map((folder) => (
          <li key={folder.sourceFolderId}>
            <details className={styles.folder}>
              <summary className={styles.folderSummary}>
                <span className={styles.folderName}>{folder.householdName ?? "—"}</span>
                <span className={styles.folderCount}>
                  {folder.accounts.length}{" "}
                  {folder.accounts.length === 1 ? "account" : "accounts"}
                </span>
              </summary>
              <ul className={styles.accounts}>
                {folder.accounts.map((acct, index) => (
                  <li key={acct.accountId ?? `historical-${index}`}>
                    <KnownAccountRowView acct={acct} />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KnownAccountRowView({
  acct,
}: {
  acct: KnownAccountRow;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const submittingRef = useRef(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (submittingRef.current || !acct.accountId) return;
    submittingRef.current = true;
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        submittingRef.current = false;
        setError(res.error ?? "The change could not be saved.");
      }
    });
  };

  // Sign off a machine link → CONFIRMED, reusing the stored owner set (the folder
  // is already resolved, so no household pick). Entity → empty owners + isEntity.
  const onConfirm = () =>
    run(() =>
      confirmAccountOwners(
        acct.accountId ?? "",
        acct.isEntity ? [] : acct.owners.map((o) => o.clientSfId).filter((s): s is string => !!s),
        acct.isEntity,
      ),
    );
  const onReject = () =>
    run(() => rejectAccount(acct.accountId ?? ""));

  const isAuto = acct.status === "AUTO_LINKED";

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.holder}>{acct.accountHolder ?? "—"}</div>
        <div className={styles.meta}>
          <Pill tone="gray">{acct.custodian}</Pill>
          <span className={styles.metaText}>{acct.accountNumberMasked}</span>
          {acct.totalValue != null && (
            <span className={styles.metaText}>{usdCompact(acct.totalValue)}</span>
          )}
          {isAuto ? (
            <Pill tone="amber">Machine-linked</Pill>
          ) : (
            <Pill tone="green">Confirmed</Pill>
          )}
        </div>
      </div>

      <div className={styles.owners}>
        <span className={styles.ownersLabel}>Owner(s)</span>
        <span className={styles.ownersValue}>{ownerLabel(acct)}</span>
      </div>

      {isAuto && !acct.accountId && (
        <p className={styles.actionHint}>
          This account is no longer in the current mapping. Refresh after the next import to review it.
        </p>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {isAuto && (
        <div className={styles.actions}>
          <Button size="sm" onClick={onConfirm} disabled={!acct.accountId || pending}>
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject} disabled={!acct.accountId || pending}>
            Reject
          </Button>
          <span className={styles.actionHint}>
            The system linked this automatically — confirm to sign off, or reject to
            re-open it.
          </span>
        </div>
      )}
    </div>
  );
}
