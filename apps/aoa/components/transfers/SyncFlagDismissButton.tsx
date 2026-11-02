"use client";

import { useState, useTransition } from "react";
import { dismissSyncFlag } from "@/app/(authenticated)/asset-transfer/actions";
import styles from "./SyncFlagDismissButton.module.css";

// "Dismiss — keep this transfer" (transfer-syncflag-surface): the keep-side
// resolution of the needs-review banner, next to the archive button (the
// remove-side). One click clears sync_flag via the dismissSyncFlag action —
// no confirm step (unlike TransferArchiveButton): dismissing is low-stakes,
// and while the deal condition persists the reconciler re-flags on its next
// run, so a mistaken dismiss self-corrects. Rendered inside the detail page's
// review banner for write roles only (the server action re-gates role + RLS
// regardless — defense in depth). Success revalidates in the action, so the
// banner (and the board chip) disappear on the refreshed render; only
// failures return here (rendered as the error line).

export function SyncFlagDismissButton({ transferId }: { transferId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dismiss = () => {
    setError(null);
    startTransition(async () => {
      const result = await dismissSyncFlag(transferId);
      // Success returns void (the revalidated page drops the banner).
      if (result && !result.ok)
        setError(result.errors[0]?.message ?? "Dismiss failed.");
    });
  };

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.dismiss}
        onClick={dismiss}
        disabled={pending}
      >
        {pending ? "Dismissing…" : "Dismiss — keep this transfer"}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
