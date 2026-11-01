"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";

interface ConfirmDeleteAcatModalProps {
  recordId: string;
  clientName: string;
  open: boolean;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

const MIN_REASON_LENGTH = 3;

export default function ConfirmDeleteAcatModal({
  recordId,
  clientName,
  open,
  deleting,
  onCancel,
  onConfirm,
}: ConfirmDeleteAcatModalProps) {
  const [reason, setReason] = useState("");
  // Reset the reason whenever the modal transitions from open → closed.
  // Using the "previous render" pattern instead of an effect keeps us clear
  // of the React 19 set-state-in-effect lint rule.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setReason("");
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, deleting, onCancel]);

  if (!open) return null;

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= MIN_REASON_LENGTH && !deleting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-acat-title"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !deleting) onCancel();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-card-border bg-[var(--bg-card)] shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-card-border px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--danger-bg)] text-[color:var(--danger)]">
              <AlertTriangle size={16} />
            </span>
            <div>
              <h2
                id="delete-acat-title"
                className="text-base font-semibold text-foreground"
              >
                Delete ACAT record?
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                Record {recordId} for {clientName} will be hidden from the app
                but retained in the database.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="shrink-0 rounded p-1 text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground disabled:opacity-50"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4">
          <label
            htmlFor="delete-acat-reason"
            className="mb-1.5 block text-xs font-medium text-foreground"
          >
            Reason <span className="text-[color:var(--danger)]">*</span>
          </label>
          <textarea
            id="delete-acat-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            disabled={deleting}
            placeholder="Why is this record being deleted?"
            className="w-full resize-none rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
            autoFocus
          />
          <p className="mt-1 text-[11px] text-muted">
            Minimum {MIN_REASON_LENGTH} characters. This will be recorded in
            the audit log.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-card-border bg-surface px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-card-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => canSubmit && onConfirm(trimmed)}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-3 py-1.5 text-xs font-semibold text-[color:var(--danger)] transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
