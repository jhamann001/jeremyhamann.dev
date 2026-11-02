"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import type { AccountDriftHistoryRow, DriftOverrideReason } from "@/lib/trade-requests/shared-types";
import { OVERRIDE_REASONS } from "@/lib/trade-requests/drift-view/model";
import styles from "./Drift.module.css";

// Port of the standalone OverrideModal (DriftTabV2.tsx:188-320): reason, a note that "other" requires, an
// optional re-check date, and Clear when an override exists. Shown to ADMIN and OPERATIONS only.
export function OverrideDialog({ row, saving, onSave, onClear, onClose }: {
  row: AccountDriftHistoryRow;
  saving: boolean;
  onSave: (reason: DriftOverrideReason, note: string, expiresOn: string | null) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const existing = row.override ?? null;
  const [reason, setReason] = useState<DriftOverrideReason | "">(existing?.reason ?? "");
  const [note, setNote] = useState<string>(existing?.note ?? "");
  const [expiresOn, setExpiresOn] = useState<string>(existing?.expiresOn ?? "");
  const noteRequired = reason === "other";
  const canSave = reason !== "" && (!noteRequired || note.trim().length > 0) && !saving;

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Set drift status override" className={styles.dialog}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <header className={styles.dialogHead}>
          <div>
            <h2>Override drift status</h2>
            <p>{row.accountTitle || row.accountId}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={styles.close} />
        </header>
        <div className={styles.dialogBody}>
          <label>
            <span>Reason</span>
            <select value={reason} onChange={(e) => setReason(e.target.value as DriftOverrideReason | "")} aria-label="Override reason">
              <option value="">Select a reason…</option>
              {OVERRIDE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          {reason !== "" && (
            <label>
              <span>Note{noteRequired ? " (required)" : " (optional)"}</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} aria-label="Override note"
                placeholder="Why is this account accepted off-target?" />
            </label>
          )}
          {reason !== "" && (
            <label>
              <span>Re-check on (optional) — the override expires after this date and we&apos;ll notify you to revisit it</span>
              <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} aria-label="Override expiry date" />
            </label>
          )}
        </div>
        <footer className={styles.dialogFoot}>
          <div>
            {existing && <button type="button" onClick={onClear} disabled={saving} className={styles.danger}>Clear override</button>}
          </div>
          <div className={styles.overrideActions}>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!canSave} onClick={() => onSave(reason as DriftOverrideReason, note, expiresOn === "" ? null : expiresOn)}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
