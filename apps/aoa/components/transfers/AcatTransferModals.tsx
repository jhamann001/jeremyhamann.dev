"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import styles from "./AcatTransferDrawer.module.css";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';

/** Tab stays inside the dialog and Escape closes only the dialog. */
export function dialogKeyDown(
  event: KeyboardEvent<HTMLElement>,
  dialog: RefObject<HTMLElement | null>,
  onEscape: () => void,
  locked: boolean,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!locked) onEscape();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.stopPropagation();
  if (event.key !== "Tab") return;
  const found = dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
  if (!found || found.length === 0) return;
  const focusable = Array.from(found).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

export function useFirstFocus(dialog: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    return () => previous?.focus();
  }, [dialog]);
}

export type FinalizeValues = { apexCompletionDate: string; controlNumber: string; rejectionReason: string };

export function FinalizeDialog({ mode, name, initial, reconLabel, feeLabel, saving, error, onCancel, onConfirm }: {
  mode: "Completed" | "Rejected";
  name: string;
  initial: FinalizeValues;
  reconLabel: string;
  feeLabel: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (values: FinalizeValues) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState(initial);
  useFirstFocus(dialog);
  const completing = mode === "Completed";
  const valid = completing ? values.apexCompletionDate !== "" : values.rejectionReason.trim() !== "";
  const placeholderControl = values.controlNumber.trim().toLowerCase() === "to come";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !saving) onConfirm(values);
  }

  return (
    <div className={styles.dialogScrim}>
      <form ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} data-acat-dialog=""
        className={styles.dialog} onSubmit={submit}
        onKeyDown={(e) => dialogKeyDown(e, dialog, onCancel, saving)}>
        <div className={styles.dialogHead}>
          <h2 id={titleId} className={styles.dialogTitle}>{completing ? "Complete transfer" : "Reject transfer"}</h2>
        </div>
        <div className={styles.dialogBody}>
          <p className={styles.cardSub}>
            {completing
              ? `Confirm the closeout details for ${name}.`
              : `Capture why ${name}'s transfer was rejected.`}
          </p>
          {completing ? (
            <>
              <label className={styles.label}>
                Apex Completion Date <span className={styles.required}>*</span>
                <input type="date" className={styles.input} value={values.apexCompletionDate}
                  onChange={(e) => setValues({ ...values, apexCompletionDate: e.target.value })} />
              </label>
              <label className={styles.label}>
                Control #
                <input type="text" className={styles.input} value={values.controlNumber}
                  placeholder="Enter the final control number"
                  onChange={(e) => setValues({ ...values, controlNumber: e.target.value })} />
              </label>
              {placeholderControl && (
                <p className={styles.warnBox}>
                  Replace “To Come” with the final control number, or clear it if this workflow does not receive one.
                </p>
              )}
              <div className={styles.summary}>
                <div><p className={styles.summaryLabel}>Security recon</p><p className={styles.summaryValue}>{reconLabel}</p></div>
                <div><p className={styles.summaryLabel}>Fee review</p><p className={styles.summaryValue}>{feeLabel}</p></div>
              </div>
            </>
          ) : (
            <label className={styles.label}>
              Rejection Reason <span className={styles.required}>*</span>
              <textarea className={styles.input} rows={4} value={values.rejectionReason}
                placeholder="What caused the rejection?"
                onChange={(e) => setValues({ ...values, rejectionReason: e.target.value })} />
            </label>
          )}
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </div>
        <div className={styles.dialogFoot}>
          <button type="button" className={styles.secondaryButton} disabled={saving} onClick={onCancel}>Cancel</button>
          <button type="submit" className={styles.primaryButton} disabled={!valid || saving}>
            {saving ? "Saving…" : error ? "Retry" : completing ? "Confirm Complete" : "Confirm Rejection"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DeleteDialog({ recordId, name, saving, error, onCancel, onConfirm }: {
  recordId: string;
  name: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState("");
  useFirstFocus(dialog);
  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= 3 && !saving;

  return (
    <div className={styles.dialogScrim}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} data-acat-dialog=""
        className={styles.dialog} onKeyDown={(e) => dialogKeyDown(e, dialog, onCancel, saving)}>
        <div className={styles.dialogHead}>
          <h2 id={titleId} className={styles.dialogTitle}>Delete ACAT record?</h2>
          <p className={styles.cardSub}>
            Record {recordId} for {name} will be hidden from the app but retained in the database.
          </p>
        </div>
        <div className={styles.dialogBody}>
          <label className={styles.label}>
            Reason <span className={styles.required}>*</span>
            <textarea className={styles.input} rows={3} maxLength={500} disabled={saving} value={reason}
              placeholder="Why is this record being deleted?" onChange={(e) => setReason(e.target.value)} />
          </label>
          <p className={styles.cardSub}>Minimum 3 characters. This will be recorded in the audit log.</p>
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </div>
        <div className={styles.dialogFoot}>
          <button type="button" className={styles.secondaryButton} disabled={saving} onClick={onCancel}>Cancel</button>
          <button type="button" className={styles.dangerButton} disabled={!canSubmit}
            onClick={() => canSubmit && onConfirm(trimmed)}>
            {saving ? "Deleting…" : error ? "Retry" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
