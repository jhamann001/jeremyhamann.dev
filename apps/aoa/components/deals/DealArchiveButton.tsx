"use client";

import { useState, useTransition } from "react";
import { archiveDeal } from "@/app/(authenticated)/deals/actions";
import {
  ARCHIVE_CONFIRM_COPY,
  ARCHIVE_NOTE_MAX,
  ARCHIVE_REASONS,
} from "@/lib/data/deal-archive";
import styles from "./DealArchiveButton.module.css";

// D7 soft delete (WO ticket): the "Delete" affordance on the deal detail
// (modal + full page — DealDetail renders it once for both, write roles only).
// Two-step INLINE confirm — no browser confirm(): step 1 is the Delete button;
// step 2 swaps in the locked ARCHIVE_CONFIRM_COPY with Remove/Cancel — plus,
// since D8 (WO ticket), the WHY: a reason dropdown (ARCHIVE_REASONS, the
// mockup list) and an optional note, stored in archived_reason and the
// deal.archive audit payload. Confirm calls the archiveDeal server action (one
// withUserScope tx + deal.archive audit row); success redirects to /deals
// inside the action, so only failures return here (rendered as the
// DealForm-style error line). The DB polices the write regardless — a VIEWER
// invoking the action directly gets the clean rejection, never a 500.

export function DealArchiveButton({ dealId }: { dealId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState<string>(ARCHIVE_REASONS[0]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveDeal(dealId, reason, note);
      // Success redirects inside the action; only failures return.
      if (result && !result.ok)
        setError(result.errors[0]?.message ?? "Delete failed.");
    });
  };

  if (!confirming) {
    return (
      <div className={styles.wrap}>
        <button
          type="button"
          className={styles.delete}
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      </div>
    );
  }

  return (
    <div className={styles.wrap} role="alertdialog" aria-label="Confirm removal">
      <p className={styles.copy}>{ARCHIVE_CONFIRM_COPY}</p>
      <div className={styles.reasonFields}>
        <label className={styles.reasonField}>
          <span className={styles.reasonLabel}>
            Why are you deleting this deal?
          </span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={pending}
          >
            {ARCHIVE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.reasonField}>
          <span className={styles.reasonLabel}>Note (optional)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Context for the audit log"
            maxLength={ARCHIVE_NOTE_MAX}
            disabled={pending}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.confirm}
          onClick={confirm}
          disabled={pending}
        >
          {pending ? "Removing…" : "Remove deal"}
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
