"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { AcatRecord, AcatStatus } from "@/lib/types";
import { getReconStatus } from "@/lib/acat-derivations";

interface FinalizeAcatModalProps {
  acat: AcatRecord;
  targetStatus: Extract<AcatStatus, "Completed" | "Rejected"> | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (updates: Record<string, unknown>) => Promise<boolean>;
}

export default function FinalizeAcatModal({
  acat,
  targetStatus,
  saving,
  onCancel,
  onConfirm,
}: FinalizeAcatModalProps) {
  const [apexCompletionDate, setApexCompletionDate] = useState(
    acat.apexCompletionDate ?? ""
  );
  const [controlNumber, setControlNumber] = useState(acat.controlNumber ?? "");
  const [rejectionReason, setRejectionReason] = useState(
    acat.rejectionReason ?? ""
  );

  const reconLabel = useMemo(() => {
    const value = getReconStatus(acat);
    if (value === "complete") return "Complete";
    if (value === "needs_review") return "Needs review";
    return "Pending";
  }, [acat]);

  if (!targetStatus) return null;

  const completing = targetStatus === "Completed";
  const valid = completing
    ? Boolean(apexCompletionDate)
    : Boolean(rejectionReason.trim());
  const placeholderControl = controlNumber.trim().toLowerCase() === "to come";
  const feeLabel = acat.feeCharged === "Yes"
    ? acat.feeAmount || "Fee recorded"
    : acat.feeCharged === "No"
      ? "No fee"
      : "Not reviewed";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || saving) return;
    const updates = completing
      ? {
          status: "Completed",
          apexCompletionDate,
          controlNumber: controlNumber.trim() || null,
        }
      : {
          status: "Rejected",
          rejectionReason: rejectionReason.trim(),
        };
    await onConfirm(updates);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--panel-backdrop)] px-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="finalize-acat-title"
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-card-border bg-[var(--bg-card)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4">
          <div className="flex items-center gap-2">
            {completing ? (
              <CheckCircle2 size={17} className="text-[color:var(--success)]" />
            ) : (
              <AlertTriangle size={17} className="text-[color:var(--warning)]" />
            )}
            <h2 id="finalize-acat-title" className="text-sm font-bold text-foreground">
              {completing ? "Complete transfer" : "Reject transfer"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            aria-label="Close"
            className="rounded p-1 text-muted hover:bg-[var(--bg-hover)] hover:text-foreground disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-muted">
            {completing
              ? `Confirm the closeout details for ${acat.clientName}.`
              : `Capture why ${acat.clientName}'s transfer was rejected.`}
          </p>

          {completing ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
                  Apex Completion Date <span className="text-[color:var(--danger)]">*</span>
                </span>
                <input
                  type="date"
                  value={apexCompletionDate}
                  onChange={(event) => setApexCompletionDate(event.target.value)}
                  autoFocus
                  className="form-input"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
                  Control #
                </span>
                <input
                  type="text"
                  value={controlNumber}
                  onChange={(event) => setControlNumber(event.target.value)}
                  placeholder="Enter the final control number"
                  className="form-input"
                />
              </label>
              {placeholderControl && (
                <p className="flex items-start gap-2 rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-3 text-xs text-[color:var(--warning)]">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  Replace “To Come” with the final control number, or clear it if this workflow does not receive one.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-[var(--bg-hover)] p-3 text-xs">
                <div>
                  <p className="text-muted">Security recon</p>
                  <p className="mt-0.5 font-semibold text-foreground">{reconLabel}</p>
                </div>
                <div>
                  <p className="text-muted">Fee review</p>
                  <p className="mt-0.5 font-semibold text-foreground">{feeLabel}</p>
                </div>
              </div>
            </>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
                Rejection Reason <span className="text-[color:var(--danger)]">*</span>
              </span>
              <textarea
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
                rows={4}
                autoFocus
                placeholder="What caused the rejection?"
                className="form-input resize-none"
              />
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-card-border px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-card-border px-4 py-2 text-sm font-medium text-foreground hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving
              ? "Saving…"
              : completing
                ? "Confirm Complete"
                : "Confirm Rejection"}
          </button>
        </div>
      </form>
    </div>
  );
}
