"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  DollarSign,
  AlertCircle,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Clock,
  Receipt,
  RefreshCw,
  CircleDot,
  Ban,
  Pencil,
  X,
  BookOpen,
  ArrowRight,
} from "lucide-react";
import {
  AcatRecord,
  AcatStatus,
  Custodian,
  CustodianFee,
  FeeRecord,
  FeeReimbursementStatus,
  TERMINAL_STATUSES,
} from "@/lib/types";
import { useToast } from "./Toast";
import { defaultFeeCharged, localDateString } from "@/lib/acat-operational-defaults";
import { DataQualityFocus } from "@/lib/data-quality-focus";

interface FeesTabProps {
  acat: AcatRecord;
  onMutate?: () => void;
  focus?: DataQualityFocus;
}

const STATUS_CONFIG: Record<
  FeeReimbursementStatus,
  { color: string; bg: string; icon: React.ReactNode }
> = {
  Pending: {
    color: "text-[color:var(--warning)]",
    bg: "bg-[color:var(--warning-bg)] border-[color:var(--warning-border)]",
    icon: <Clock size={14} className="text-[color:var(--warning)]" />,
  },
  Approved: {
    color: "text-[color:var(--info)]",
    bg: "bg-[color:var(--info-bg)] border-[color:var(--info-border)]",
    icon: <CircleDot size={14} className="text-[color:var(--info)]" />,
  },
  Credited: {
    color: "text-[color:var(--success)]",
    bg: "bg-[color:var(--success-bg)] border-[color:var(--success-border)]",
    icon: <CheckCircle2 size={14} className="text-[color:var(--success)]" />,
  },
  Denied: {
    color: "text-[color:var(--danger)]",
    bg: "bg-[color:var(--danger-bg)] border-[color:var(--danger-border)]",
    icon: <Ban size={14} className="text-[color:var(--danger)]" />,
  },
};

type EditableField = "feeCharged" | "feeAmount" | "feeMemo" | "feeRequestSubmitted" | "feeRequestCompleted" | "feeApexTicket" | "feeCreditRequestId";

const FEE_FIELDS: { key: EditableField; label: string; type: "text" | "select" | "date"; options?: string[] }[] = [
  { key: "feeCharged", label: "Fee Charged?", type: "select", options: ["Yes", "No"] },
  { key: "feeAmount", label: "Fee Amount", type: "text" },
  { key: "feeMemo", label: "Fee Memo", type: "text" },
  { key: "feeRequestSubmitted", label: "Fee Request Submitted", type: "date" },
  { key: "feeRequestCompleted", label: "Fee Request Completed", type: "date" },
  { key: "feeApexTicket", label: "Fee Apex Ticket", type: "text" },
  { key: "feeCreditRequestId", label: "Fee Credit Req ID", type: "text" },
];

export default function FeesTab({ acat, onMutate, focus }: FeesTabProps) {
  const initialFocusField =
    focus?.tab === "fees" && FEE_FIELDS.some((field) => field.key === focus.field)
      ? (focus.field as EditableField)
      : null;
  const [submitting, setSubmitting] = useState(false);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(initialFocusField);
  const [editValue, setEditValue] = useState(
    () => initialFocusField ? String(acat[initialFocusField] ?? "") : ""
  );
  const [saving, setSaving] = useState(false);
  // Set true (via onMouseDown, which fires before blur) when the user is
  // cancelling, so the input's onBlur discards instead of saving.
  const cancelEditRef = useRef(false);
  // Guards patchField against a double-fire of the SAME field (e.g. blur +
  // Enter racing). Keyed by field name so a second field can still save while
  // the first is in flight.
  const savingRef = useRef<string | null>(null);
  const [applyingSchedule, setApplyingSchedule] = useState(false);
  // ticket: user-driven fee selection. We no longer auto-filter the
  // custodian's fee schedule by account-type / direction — instead the
  // panel shows ALL configured fees for the custodian and lets ops pick
  // one or multiple. Selected ids stay in component state until the user
  // explicitly "Applies to Record".
  const [selectedFeeIds, setSelectedFeeIds] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  // SWR-backed custodian read. Pulls the custodian (with fee schedule) for
  // this record so the panel reflects edits to the record's contra without
  // a page-level refetch, and revalidates on focus/reconnect/interval so
  // another user's fee-schedule edits propagate.
  const custodianKey = acat.custodianId
    ? `/api/custodians?id=${encodeURIComponent(acat.custodianId)}&includeFees=1`
    : null;
  const { data: custodianData, isLoading: custodianLoading } = useSWR<Custodian | null>(
    custodianKey
  );
  const custodian = custodianData ?? null;

  const allFees: CustodianFee[] = useMemo(
    () => custodian?.fees ?? [],
    [custodian]
  );

  const toggleFeeSelection = useCallback((feeId: string) => {
    setSelectedFeeIds((prev) => {
      const next = new Set(prev);
      if (next.has(feeId)) next.delete(feeId);
      else next.add(feeId);
      return next;
    });
  }, []);

  const selectedFees: CustodianFee[] = useMemo(
    () => allFees.filter((f) => selectedFeeIds.has(f.id)),
    [allFees, selectedFeeIds]
  );

  const selectedTotal = useMemo(
    () => selectedFees.reduce((sum, f) => sum + (f.amount ?? 0), 0),
    [selectedFees]
  );

  const selectedHasUnknownAmount = useMemo(
    () => selectedFees.some((f) => f.amount == null),
    [selectedFees]
  );

  // SWR-backed fee-reimbursement log read. Normalises the server's two legacy
  // response shapes (`FeeRecord[]` or `{ data: FeeRecord[] }`) into an array
  // and swallows errors to keep parity with the previous `.catch(() => [])`
  // behaviour — an offline or 500 response should not break the panel.
  const feeStatusKey = `/api/fees?${new URLSearchParams({
    clientName: acat.clientName,
    accountNumber: acat.apexAccountId,
  }).toString()}`;
  const {
    data: feeStatusData,
    isLoading: feeLoading,
    mutate: mutateFeeStatus,
  } = useSWR<FeeRecord[] | { data: FeeRecord[] }>(feeStatusKey);
  const feeRecords: FeeRecord[] = Array.isArray(feeStatusData)
    ? feeStatusData
    : (feeStatusData?.data ?? []);

  const applySchedule = useCallback(async () => {
    if (selectedFees.length === 0) return;
    if (applyingSchedule) return;
    setApplyingSchedule(true);
    try {
      const feeAmount = `$${selectedTotal.toFixed(2)}`;
      const feeMemo = selectedFees
        .map((f) => {
          const value = f.amount != null ? `$${f.amount.toFixed(2)}` : (f.amountText ?? "?");
          return `${f.feeType}: ${value}`;
        })
        .join(" + ");
      const res = await fetch(`/api/acats/${acat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feeCharged: selectedTotal > 0 || selectedHasUnknownAmount ? "Yes" : "No",
          feeAmount,
          feeMemo,
        }),
      });
      if (!res.ok) throw new Error("Update failed");
      toast(
        "success",
        "Applied",
        `${selectedFees.length} fee${selectedFees.length === 1 ? "" : "s"} applied to record`
      );
      onMutate?.();
    } catch {
      toast("error", "Update Failed", "Could not apply fee schedule");
    } finally {
      setApplyingSchedule(false);
    }
  }, [selectedFees, selectedTotal, selectedHasUnknownAmount, applyingSchedule, acat.id, onMutate, toast]);

  const patchField = useCallback(async (field: string, value: string) => {
    if (savingRef.current === field) return;
    savingRef.current = field;
    setSaving(true);
    try {
      const res = await fetch(`/api/acats/${acat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Send the raw value (including "") so an empty entry CLEARS the field.
        // Previously `value || undefined` dropped empties from the body, so a
        // blanked field silently never saved.
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error("Update failed");
      toast("success", "Updated", `${field} saved`);
      onMutate?.();
      // Only close the editor if THIS field is still the one open — otherwise
      // a slow save for field A would close the editor the user just opened
      // on field B and drop their in-progress input.
      setEditingField((cur) => (cur === field ? null : cur));
    } catch {
      toast("error", "Update Failed", "Could not save changes");
    } finally {
      setSaving(false);
      // Only clear the guard if it still holds THIS field — otherwise a
      // concurrent save of another field (which overwrote the slot) would be
      // un-guarded and could double-fire.
      if (savingRef.current === field) savingRef.current = null;
    }
  }, [acat.id, onMutate, toast]);

  const submitFeeCredit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setShowDuplicateWarning(false);

    try {
      const feeAmt = parseFloat((acat.feeAmount ?? "0").replace(/[^0-9.]/g, "")) || 0;
      const res = await fetch("/api/fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: acat.clientName,
          feeType: "ACAT Transfer Fee",
          feeAmount: feeAmt,
          accountNumber: acat.apexAccountId,
          apexRequest: acat.feeApexTicket || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to log reimbursement");
      }

      const created = await res.json().catch(() => ({}));
      const createdRow = Array.isArray(created?.data)
        ? created.data[0]
        : created?.data ?? created;
      const assignedRequestId = createdRow?.id ?? createdRow?.request_id;
      if (assignedRequestId != null) {
        const submittedDate = localDateString();
        const linkResponse = await fetch(`/api/acats/${acat.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            feeCreditRequestId: String(assignedRequestId),
            feeRequestSubmitted: acat.feeRequestSubmitted || submittedDate,
          }),
        });
        if (!linkResponse.ok) throw new Error("Reimbursement logged, but the request ID could not be linked to this ACAT");
        onMutate?.();
      }

      toast(
        "success",
        "Reimbursement Logged",
        `$${feeAmt.toFixed(2)} fee credit for ${acat.clientName} submitted`
      );
      await mutateFeeStatus();
    } catch (err) {
      toast(
        "error",
        "Failed to Log Reimbursement",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogReimbursement = () => {
    if (feeRecords.length > 0) {
      setShowDuplicateWarning(true);
      return;
    }
    submitFeeCredit();
  };

  const feeAmt = parseFloat((acat.feeAmount ?? "0").replace(/[^0-9.]/g, "")) || 0;
  const isFullOutgoing = defaultFeeCharged(acat) === "Yes";
  const hasFee = acat.feeCharged === "Yes" || feeAmt > 0 || isFullOutgoing;
  const isTerminal = TERMINAL_STATUSES.has(acat.status as AcatStatus);

  const headerBadgeClasses = hasFee
    ? "border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] text-[color:var(--warning)]"
    : isTerminal
      ? "border-[color:var(--success-border)] bg-[color:var(--success-bg)] text-[color:var(--success)]"
      : "border-card-border bg-[var(--bg-hover)] text-muted";

  return (
    <div className="space-y-5">
      {focus?.tab === "fees" && (
        <div className="rounded-xl border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-4 text-sm text-[color:var(--warning)]">
          <p className="font-semibold">Fixing: {focus.title}</p>
          <p className="mt-1 text-xs leading-5">{focus.detail} The highlighted {focus.fieldLabel} field is ready to edit.</p>
        </div>
      )}
      <div className="rounded-xl border border-card-border bg-[var(--bg-card)]">
        <div className="flex items-center justify-between border-b border-card-border px-6 py-3.5">
          <div className="flex items-center gap-2">
            <DollarSign size={15} className="text-accent" />
            <h3 className="text-sm font-semibold text-foreground">Fee Details</h3>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${headerBadgeClasses}`}
          >
            {hasFee ? "Fee Charged" : isTerminal ? "No Fee" : "Pending"}
          </span>
        </div>
        <div className="divide-y divide-card-border">
          {FEE_FIELDS.map((field) => {
            const value = acat[field.key] ?? "";
            const isEditing = editingField === field.key;

            return (
              <div
                key={field.key}
                data-quality-target={focus?.field === field.key ? "true" : undefined}
                className={`group flex items-center justify-between px-6 py-3 ${
                  focus?.field === field.key
                    ? "bg-[color:var(--warning-bg)] ring-2 ring-inset ring-[color:var(--warning-border)]"
                    : ""
                }`}
              >
                <span className="text-xs font-medium uppercase tracking-wider text-muted w-48 shrink-0">
                  {field.label}
                </span>
                {isEditing ? (
                  <div className="flex flex-1 items-center gap-2">
                    {field.type === "select" ? (
                      <select
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => {
                          if (cancelEditRef.current) {
                            cancelEditRef.current = false;
                            setEditingField(null);
                            setEditValue("");
                            return;
                          }
                          patchField(field.key, editValue);
                        }}
                        className="flex-1 rounded-md border border-accent bg-[var(--bg-card)] px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
                        autoFocus
                      >
                        <option value="">—</option>
                        {field.options?.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={field.type === "date" ? "date" : "text"}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") patchField(field.key, editValue);
                          if (e.key === "Escape") {
                            cancelEditRef.current = true;
                            setEditingField(null);
                            setEditValue("");
                          }
                        }}
                        onBlur={() => {
                          if (cancelEditRef.current) {
                            cancelEditRef.current = false;
                            setEditingField(null);
                            setEditValue("");
                            return;
                          }
                          patchField(field.key, editValue);
                        }}
                        className="flex-1 rounded-md border border-accent bg-[var(--bg-card)] px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
                        autoFocus
                      />
                    )}
                    {saving && (
                      <Loader2
                        size={14}
                        className="animate-spin text-[color:var(--success)]"
                      />
                    )}
                    <button
                      onMouseDown={() => { cancelEditRef.current = true; }}
                      onClick={() => { setEditingField(null); setEditValue(""); }}
                      className="rounded p-1 text-muted hover:text-foreground"
                      aria-label="Cancel edit"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div
                    className="flex flex-1 items-center gap-2 cursor-pointer"
                    onClick={() => {
                      // Reset the cancel flag on entering edit — otherwise a
                      // prior Escape (which unmounts the input before its blur
                      // can clear the flag) would poison this next save.
                      cancelEditRef.current = false;
                      setEditingField(field.key);
                      setEditValue(value);
                    }}
                  >
                    <span className={`text-sm ${value ? "text-foreground font-medium" : "text-muted-faint italic"}`}>
                      {value || "—"}
                    </span>
                    <Pencil size={11} className="shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isFullOutgoing && (
        <div className="rounded-xl border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-4 text-sm text-[color:var(--warning)]">
          <p className="font-semibold">Full ACAT Out — verify the automatic fee credit</p>
          <p className="mt-1 text-xs leading-5">
            Confirm the charge and reimbursement in Apex, record the fee amount and fee-specific Apex ticket, then log the request so its Fee Crediting Req ID is tied back here.
          </p>
        </div>
      )}

      <FeeSchedulePanel
        contraName={acat.transferringContra || acat.custodianName}
        custodianLoaded={!custodianLoading}
        fees={allFees}
        selectedIds={selectedFeeIds}
        onToggle={toggleFeeSelection}
        selectedTotal={selectedTotal}
        selectedHasUnknownAmount={selectedHasUnknownAmount}
        recordHasFee={hasFee}
        onApply={applySchedule}
        applying={applyingSchedule}
      />

      {/* ticket: Removed the "Estimated Reimbursement" and "Net Cost to
          Firm" cards. The single fee summary above (Fee Details panel)
          is the sole source of truth for what's charged on this record. */}
      {hasFee && (
        <div className="grid grid-cols-1 gap-4">
          <FeeCard label="ACAT Transfer Fee" amount={feeAmt} description={`Fee from ${acat.transferringContra || acat.custodianName}`} />
        </div>
      )}

      {feeLoading ? (
        <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
          <div className="flex items-center gap-2 text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-xs">Checking reimbursement status...</span>
          </div>
        </div>
      ) : feeRecords.length > 0 ? (
        <div className="rounded-xl border border-card-border bg-[var(--bg-card)]">
          <div className="flex items-center justify-between border-b border-card-border px-6 py-3">
            <div className="flex items-center gap-2">
              <Receipt size={14} className="text-accent" />
              <h3 className="text-sm font-semibold text-foreground">Reimbursement Log</h3>
              <span className="rounded-full bg-accent-light px-2 py-0.5 text-[10px] font-semibold text-accent">
                {feeRecords.length}
              </span>
            </div>
            <button
              onClick={() => {
                void mutateFeeStatus();
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
            >
              <RefreshCw size={11} />
              Refresh
            </button>
          </div>
          <div className="divide-y divide-card-border">
            {feeRecords.map((rec, i) => {
              const status = (rec.status ?? "Pending") as FeeReimbursementStatus;
              const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.Pending;
              return (
                <div key={rec.id ?? i} className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${cfg.bg} ${cfg.color}`}>
                      {cfg.icon}
                      {status}
                    </div>
                    <span className="text-sm text-foreground font-medium">
                      ${Number(rec.fee_amount ?? 0).toFixed(2)}
                    </span>
                    {rec.fee_type && (
                      <span className="text-[11px] text-muted">{rec.fee_type}</span>
                    )}
                  </div>
                  <span className="text-[11px] text-muted">
                    {rec.submission_date
                      ? new Date(rec.submission_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                      : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {hasFee ? (
        <div className="rounded-xl border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--warning-bg)] border border-[color:var(--warning-border)]">
                  <AlertCircle size={16} className="text-[color:var(--warning)]" />
                </div>
                <h3 className="text-sm font-bold text-[color:var(--warning)]">
                  {feeRecords.length > 0 ? "Log Another Reimbursement" : "Action Required — Client Reimbursement"}
                </h3>
              </div>
              <p className="mb-1 text-sm text-[color:var(--warning)] leading-relaxed">
                This ACAT transfer incurs a <strong>{acat.feeAmount || `$${feeAmt.toFixed(2)}`}</strong> fee.
                Per firm policy, this fee should be reimbursed to <strong>{acat.clientName}</strong>.
              </p>
              <p className="text-xs text-muted">
                {acat.controlNumber && `Control #: ${acat.controlNumber} · `}
                Apex Account: {acat.apexAccountId}
              </p>
            </div>
            <button
              onClick={handleLogReimbursement}
              disabled={submitting || feeAmt <= 0}
              title={feeAmt <= 0 ? "Enter the charged fee amount first" : undefined}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[color:var(--warning)] px-5 py-2.5 text-sm font-semibold text-[var(--invert-text)] shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Receipt size={14} />}
              {submitting ? "Logging..." : feeAmt <= 0 ? "Enter Fee Amount First" : "Log Reimbursement"}
            </button>
          </div>
        </div>
      ) : isTerminal ? (
        <div className="rounded-xl border border-[color:var(--success-border)] bg-[color:var(--success-bg)] p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[color:var(--success-border)] bg-[color:var(--success-bg)]">
              <CheckCircle2 size={18} className="text-[color:var(--success)]" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[color:var(--success)]">No Fee Charged</h3>
              <p className="mt-0.5 text-sm text-[color:var(--success)]">
                No ACAT transfer fee was charged for this record. No reimbursement action needed.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-card-border bg-[var(--bg-hover)] p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)]">
              <Clock size={18} className="text-muted-faint" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-muted-strong">Fee Status Pending</h3>
              <p className="mt-0.5 text-sm text-muted">
                Fee information will be available once this transfer reaches a final status.
              </p>
            </div>
          </div>
        </div>
      )}

      {showDuplicateWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--panel-backdrop)]">
          <div className="w-full max-w-md rounded-xl border border-card-border bg-[var(--panel-bg)] p-6 shadow-xl animate-fade-in">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)]">
                <AlertTriangle size={20} className="text-[color:var(--warning)]" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-foreground">Possible Duplicate</h3>
                <p className="text-xs text-muted">Please confirm this is not a duplicate submission</p>
              </div>
            </div>
            <p className="mb-5 text-sm text-foreground leading-relaxed">
              There {feeRecords.length === 1 ? "is" : "are"} already{" "}
              <strong>{feeRecords.length}</strong> fee credit{feeRecords.length !== 1 ? "s" : ""} on file
              for this account. Are you sure this is a new reimbursement?
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDuplicateWarning(false)}
                className="rounded-lg border border-card-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                onClick={submitFeeCredit}
                className="rounded-lg bg-[color:var(--warning)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 active:scale-[0.98]"
              >
                Submit Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ticket: Lists every fee configured for the record's custodian and lets
 * ops select one or more to apply to the record. Replaces the previous
 * "compute applicable fees from account/transfer/direction filters and
 * show only those" UX — operators reported it was too opinionated and
 * occasionally hid fees they actually needed.
 */
function FeeSchedulePanel({
  contraName,
  custodianLoaded,
  fees,
  selectedIds,
  onToggle,
  selectedTotal,
  selectedHasUnknownAmount,
  recordHasFee,
  onApply,
  applying,
}: {
  contraName: string;
  custodianLoaded: boolean;
  fees: CustodianFee[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  selectedTotal: number;
  selectedHasUnknownAmount: boolean;
  recordHasFee: boolean;
  onApply: () => void;
  applying: boolean;
}) {
  if (!custodianLoaded) {
    return (
      <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
        <div className="flex items-center gap-2 text-muted">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-xs">Loading custodian fee schedule...</span>
        </div>
      </div>
    );
  }

  if (fees.length === 0) {
    return (
      <div className="rounded-xl border border-card-border bg-[var(--bg-card)]">
        <div className="flex items-center gap-2 border-b border-card-border px-6 py-3.5">
          <BookOpen size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Fee Schedule</h3>
        </div>
        <div className="px-6 py-4 text-xs text-muted">
          {contraName
            ? `No fee schedule on file for ${contraName}. Add entries via the CustodianFee seed file.`
            : "Set a transferring contra to see its fee schedule."}
        </div>
      </div>
    );
  }

  const selectedCount = selectedIds.size;
  const canApply = !recordHasFee && selectedCount > 0;

  return (
    <div className="rounded-xl border border-card-border bg-[var(--bg-card)]">
      <div className="flex items-center justify-between border-b border-card-border px-6 py-3.5">
        <div className="flex items-center gap-2">
          <BookOpen size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">
            Fee Schedule — {contraName}
          </h3>
          <span className="rounded-full bg-accent-light px-2 py-0.5 text-[10px] font-semibold text-accent">
            {fees.length} configured
          </span>
        </div>
        {!recordHasFee && (
          <button
            onClick={onApply}
            disabled={!canApply || applying}
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-[11px] font-medium text-foreground transition hover:bg-[var(--bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
            Apply Selected to Record
          </button>
        )}
      </div>
      <p className="px-6 pt-3 text-[11px] text-muted">
        Showing every fee configured for {contraName}. Select one or more to
        apply to this record.
      </p>
      <div className="divide-y divide-card-border">
        {fees.map((fee) => {
          const checked = selectedIds.has(fee.id);
          return (
            <label
              key={fee.id}
              className={`flex items-center justify-between gap-4 px-6 py-3 cursor-pointer transition ${
                checked ? "bg-accent-light/40" : "hover:bg-[var(--bg-hover)]"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(fee.id)}
                  aria-label={`Select ${fee.feeType}`}
                  className="h-4 w-4 cursor-pointer rounded border-card-border text-accent focus:ring-1 focus:ring-accent/30"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{fee.feeType}</p>
                  <p className="text-[11px] text-muted truncate">
                    {[
                      fee.accountType !== "ANY" ? fee.accountType : null,
                      fee.transferType !== "ANY" ? fee.transferType : null,
                      fee.direction !== "ANY" ? `Direction ${fee.direction}` : null,
                      fee.notes,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Applies to all account types"}
                  </p>
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-foreground">
                {fee.amount != null ? `$${fee.amount.toFixed(2)}` : fee.amountText ?? "—"}
              </span>
            </label>
          );
        })}
        <div className="flex items-center justify-between px-6 py-3 bg-[var(--bg-hover)]">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Selected Total ({selectedCount} fee{selectedCount === 1 ? "" : "s"})
          </span>
          <span className="text-base font-bold text-foreground">
            ${selectedTotal.toFixed(2)}
            {selectedHasUnknownAmount && (
              <span className="ml-1 text-[11px] font-medium text-muted">+ variable</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function FeeCard({
  label,
  amount,
  description,
}: {
  label: string;
  amount: number;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-card-border bg-[var(--bg-card)] px-5 py-4">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className={`text-xl font-bold ${amount > 0 ? "text-foreground" : "text-[color:var(--success)]"}`}>
        ${amount.toFixed(2)}
      </p>
      <p className="mt-1 text-[11px] text-muted">{description}</p>
    </div>
  );
}
