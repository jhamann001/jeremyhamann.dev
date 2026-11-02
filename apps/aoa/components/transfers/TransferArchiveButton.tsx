"use client";

import { useState, useTransition } from "react";
import { archiveTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { TRANSFER_ARCHIVE_CONFIRM_COPY } from "@/lib/data/transfer-archive";
import styles from "./TransferArchiveButton.module.css";

// Manual soft-archive affordance (feat/transfer-archive-falloff, flag
// TRANSFER_ARCHIVE_ACTION) — the DealArchiveButton idiom, minus the reason
// dropdown: a manual transfer archive always stamps archived_reason='manual'
// (the reconciler owns the deal_lost/uncommitted stamps). Rendered on the
// transfer DETAIL page only (never on board cards), write roles + flag ON +
// not-already-archived only — the server page gates the render, and the
// archiveTransfer action re-gates flag + role + RLS regardless (defense in
// depth). Two-step INLINE confirm — no browser confirm(): step 1 is the
// Archive button; step 2 swaps in the locked copy with Archive/Cancel.
// Success redirects to /asset-transfer inside the action, so only failures
// return here (rendered as the error line).

export function TransferArchiveButton({ transferId }: { transferId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveTransfer(transferId);
      // Success redirects inside the action; only failures return.
      if (result && !result.ok)
        setError(result.errors[0]?.message ?? "Archive failed.");
    });
  };

  if (!confirming) {
    return (
      <div className={styles.wrap}>
        <button
          type="button"
          className={styles.archive}
          onClick={() => setConfirming(true)}
        >
          Archive transfer
        </button>
      </div>
    );
  }

  return (
    <div className={styles.wrap} role="alertdialog" aria-label="Confirm archive">
      <p className={styles.copy}>{TRANSFER_ARCHIVE_CONFIRM_COPY}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirm}
          onClick={confirm}
          disabled={pending}
        >
          {pending ? "Archiving…" : "Archive transfer"}
        </button>
        <button
          type="button"
          className={styles.cancel}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
