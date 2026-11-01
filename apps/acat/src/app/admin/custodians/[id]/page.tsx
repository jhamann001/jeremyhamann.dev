"use client";

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { useEffectiveRole } from "@/lib/use-effective-role";
import CustodianFeeScheduleDocuments from "@/components/CustodianFeeScheduleDocuments";
import {
  ArrowLeft,
  Building2,
  Loader2,
  AlertTriangle,
  Check,
  X,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

type AccountType = "ANY" | "IRA" | "BROKERAGE";
type TransferType = "ANY" | "FULL" | "PARTIAL";
type Direction = "ANY" | "IN" | "OUT";

// ticket: contra transfer-playbook enums (distinct from the fee TransferType above).
type PlaybookTransferType = "ACAT_API" | "MANUAL" | "MIXED" | "INTERNAL" | "UNCONFIRMED";
type DocStatus = "DOCUMENTED" | "PARTIAL" | "NEEDS_CALL";

const PLAYBOOK_TRANSFER_TYPES: PlaybookTransferType[] = [
  "ACAT_API",
  "MANUAL",
  "MIXED",
  "INTERNAL",
  "UNCONFIRMED",
];

const TRANSFER_TYPE_LABELS: Record<PlaybookTransferType, string> = {
  ACAT_API: "ACAT",
  MANUAL: "Manual",
  MIXED: "Mixed",
  INTERNAL: "Internal",
  UNCONFIRMED: "Unconfirmed",
};
const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  DOCUMENTED: "Documented",
  PARTIAL: "Partial docs",
  NEEDS_CALL: "Needs call",
};

type ContactMethod = "EMAIL" | "PHONE" | "PORTAL" | "OTHER";
const CONTACT_METHOD_LABELS: Record<ContactMethod, string> = {
  EMAIL: "Email",
  PHONE: "Phone",
  PORTAL: "Portal",
  OTHER: "Other",
};

// Keep readable stored values compatible with the existing playbooks and
// recommendation API. An unset field remains distinct from "Unknown".
const SIGNATURE_OPTIONS = [
  { value: "DocuSign OK", label: "Electronic signature accepted (DocuSign)" },
  { value: "Wet only", label: "Wet signature required" },
  { value: "DocuSign OK / Wet only", label: "Varies by account / transfer — see Watchouts" },
  { value: "Not required", label: "Not required" },
  { value: "Unknown", label: "Unknown / needs confirmation" },
  { value: "Other — see Watchouts", label: "Other — see Watchouts" },
];
const REQUIREMENT_OPTIONS = [
  { value: "Required", label: "Required" },
  { value: "Not required", label: "Not required" },
  { value: "Not required / Required", label: "Required in some cases — see Watchouts" },
  { value: "Unknown", label: "Unknown / needs confirmation" },
  { value: "Other — see Watchouts", label: "Other — see Watchouts" },
];
const LIQUIDATION_OPTIONS = [
  "Check", "Wire", "ACH", "Phone order", "Multiple methods — see Watchouts",
  "Not applicable", "Unknown", "Other — see Watchouts",
].map((value) => ({ value, label: value }));
const RETURN_METHOD_OPTIONS = [
  { value: "E-Mail", label: "Email" },
  { value: "Fax", label: "Fax" },
  { value: "Mail", label: "Mail" },
  { value: "Portal", label: "Portal" },
  { value: "Email, fax", label: "Email or fax" },
  { value: "Apex Service Request", label: "Apex Service Request" },
  { value: "N/A for a standard ACAT", label: "Not applicable — standard ACAT" },
  { value: "Multiple methods — see Watchouts", label: "Multiple methods — see Watchouts" },
  { value: "Unknown", label: "Unknown / needs confirmation" },
  { value: "Other — see Watchouts", label: "Other — see Watchouts" },
];

function playbookLabel(value: string | null, options: { value: string; label: string }[]): string {
  return options.find((option) => option.value === value)?.label ?? value ?? "—";
}

// A requirement value ("Required", "Not required / Required", "Unknown", …) is
// "notable" for the TL;DR when it actually requires something — i.e. it mentions
// "required" but isn't exactly "Not required".
function isRequirementNotable(v: string | null): boolean {
  if (!v) return false;
  return /required/i.test(v) && !/^\s*not required\s*$/i.test(v);
}

// One-line TL;DR computed from the structured fields (no stored column).
function buildPlaybookSummary(d: CustodianDetail): string | null {
  const parts: string[] = [];
  if (d.transferType) parts.push(TRANSFER_TYPE_LABELS[d.transferType]);
  if (d.documentationStatus) parts.push(DOC_STATUS_LABELS[d.documentationStatus]);
  if (d.signature === "DocuSign OK / Wet only") parts.push("Signature varies");
  else if (d.signature && /wet/i.test(d.signature)) parts.push("Wet signature");
  if (d.letterOfAcceptance === "Not required / Required") parts.push("LOA required in some cases");
  else if (isRequirementNotable(d.letterOfAcceptance)) parts.push("LOA required");
  if (d.medallionRequired === "Not required / Required") parts.push("Medallion required in some cases");
  else if (isRequirementNotable(d.medallionRequired)) parts.push("Medallion required");
  return parts.length ? parts.join(" · ") : null;
}

interface CustodianFee {
  id: string;
  feeType: string;
  accountType: AccountType;
  transferType: TransferType;
  direction: Direction;
  amount: number | null;
  amountText: string | null;
  notes: string | null;
  documentation: string | null;
  updatedAt: string;
}

interface CustodianDetail {
  id: string;
  name: string;
  avgProcessingDays: number;
  contactEmail: string | null;
  contactMethod: ContactMethod | null;
  contactDetails: string | null;
  reviewStatus: "NEEDS_SETUP" | "VERIFIED";
  // ticket: contra transfer-playbook fields.
  transferType: PlaybookTransferType | null;
  documentationStatus: DocStatus | null;
  dtcNumber: string | null;
  receivingAccountNumber: string | null;
  signature: string | null;
  letterOfAcceptance: string | null;
  medallionRequired: string | null;
  liquidationMethod: string | null;
  returnMethod: string | null;
  watchouts: string | null;
  paperworkOnFile: boolean | null;
  transfersToDate: number | null;
  recentClients: string | null;
  linkedRecordCount: number;
  feeScheduleDocumentCount: number;
  fees: CustodianFee[];
}

interface CustodianListItem {
  id: string;
  name: string;
}

function getContact(data: CustodianDetail): {
  contactMethod: ContactMethod | "";
  contactDetails: string;
} {
  // Old records need no backfill: show their existing email until an operator
  // explicitly edits the contact. Opening and saving must not rewrite it.
  return data.contactMethod
    ? { contactMethod: data.contactMethod, contactDetails: data.contactDetails ?? "" }
    : { contactMethod: data.contactEmail ? "EMAIL" : "", contactDetails: data.contactEmail ?? "" };
}

const ACCOUNT_TYPES: AccountType[] = ["ANY", "IRA", "BROKERAGE"];
const TRANSFER_TYPES: TransferType[] = ["ANY", "FULL", "PARTIAL"];
const DIRECTIONS: Direction[] = ["ANY", "IN", "OUT"];

// Stored direction is relative to this custodian; operators select the
// transfer's direction relative to Apex. Keep the existing matching intact.
const DIRECTION_LABELS: Record<Direction, string> = {
  ANY: "Both directions",
  OUT: "Transfer into Apex",
  IN: "Transfer out of Apex",
};

const BLANK_FEE = {
  feeType: "",
  accountType: "ANY" as AccountType,
  transferType: "ANY" as TransferType,
  direction: "ANY" as Direction,
  amount: "" as string,
  amountText: "",
  notes: "",
  documentation: "",
};

// ticket: the Transfer playbook editor draft. Enums are held as "" when unset
// (mapped back to null on save); transfersToDate is a numeric string input.
interface PlaybookDraft {
  dtcNumber: string;
  receivingAccountNumber: string;
  transferType: PlaybookTransferType | "";
  documentationStatus: DocStatus | "";
  signature: string;
  letterOfAcceptance: string;
  medallionRequired: string;
  paperworkOnFile: boolean;
  liquidationMethod: string;
  returnMethod: string;
  contactMethod: ContactMethod | "";
  contactDetails: string;
  contactDetailsByMethod: Partial<Record<ContactMethod, string>>;
  transfersToDate: string;
  recentClients: string;
  watchouts: string;
}

const BLANK_PLAYBOOK: PlaybookDraft = {
  dtcNumber: "",
  receivingAccountNumber: "",
  transferType: "",
  documentationStatus: "",
  signature: "",
  letterOfAcceptance: "",
  medallionRequired: "",
  paperworkOnFile: false,
  liquidationMethod: "",
  returnMethod: "",
  contactMethod: "",
  contactDetails: "",
  contactDetailsByMethod: {},
  transfersToDate: "",
  recentClients: "",
  watchouts: "",
};

export default function CustodianDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { data: session, status } = useSession();
  const router = useRouter();

  const { data, error, isLoading, mutate } = useSWR<CustodianDetail>(
    id ? `/api/custodians/${id}` : null
  );

  // Candidates for the "Merge into…" picker (all custodians; self filtered
  // out at render time).
  const { data: allCustodians } = useSWR<CustodianListItem[]>("/api/custodians");

  const [flashError, setFlashError] = useState<string | null>(null);
  const [flashSuccess, setFlashSuccess] = useState<string | null>(null);

  // Danger-zone state.
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [dangerBusy, setDangerBusy] = useState(false);

  // Custodian meta edit state. ticket: contactEmail moved to the Transfer
  // playbook (Proceeds & contact); requiresManualReview removed from the UI.
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDraft, setMetaDraft] = useState({
    name: "",
    avgProcessingDays: "7",
  });

  // ticket: Transfer playbook edit state.
  const [editingPlaybook, setEditingPlaybook] = useState(false);
  const [playbookDraft, setPlaybookDraft] = useState<PlaybookDraft>(BLANK_PLAYBOOK);

  // Fee row edit state
  const [editingFeeId, setEditingFeeId] = useState<string | null>(null);
  const [feeDraft, setFeeDraft] = useState(BLANK_FEE);
  const [showAddFee, setShowAddFee] = useState(false);
  const [busyFeeId, setBusyFeeId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "loading") return;
    if (!session) {
      router.push("/");
    }
  }, [session, status, router]);

  const { role: effectiveRole } = useEffectiveRole();
  const isAdmin = effectiveRole === "ADMIN";

  const flash = useCallback((msg: string, kind: "success" | "error") => {
    if (kind === "success") {
      setFlashSuccess(msg);
      setTimeout(() => setFlashSuccess(null), 3000);
    } else {
      setFlashError(msg);
    }
  }, []);

  const startMetaEdit = () => {
    if (!data) return;
    setMetaDraft({
      name: data.name,
      avgProcessingDays: String(data.avgProcessingDays),
    });
    setEditingMeta(true);
  };

  const saveMeta = async () => {
    if (!data) return;
    const days = parseInt(metaDraft.avgProcessingDays, 10);
    const payload: Record<string, unknown> = {};
    if (metaDraft.name.trim() !== data.name) payload.name = metaDraft.name.trim();
    if (!Number.isNaN(days) && days !== data.avgProcessingDays)
      payload.avgProcessingDays = days;

    if (Object.keys(payload).length === 0) {
      setEditingMeta(false);
      return;
    }

    try {
      const res = await fetch(`/api/custodians/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      flash("Custodian updated", "success");
      setEditingMeta(false);
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to save", "error");
    }
  };

  // ticket: Transfer playbook edit — same startEdit/save pattern as meta.
  const startPlaybookEdit = () => {
    if (!data) return;
    setPlaybookDraft({
      dtcNumber: data.dtcNumber ?? "",
      receivingAccountNumber: data.receivingAccountNumber ?? "",
      transferType: data.transferType ?? "",
      documentationStatus: data.documentationStatus ?? "",
      signature: data.signature ?? "",
      letterOfAcceptance: data.letterOfAcceptance ?? "",
      medallionRequired: data.medallionRequired ?? "",
      paperworkOnFile: data.paperworkOnFile ?? false,
      liquidationMethod: data.liquidationMethod ?? "",
      returnMethod: data.returnMethod ?? "",
      ...getContact(data),
      contactDetailsByMethod: {},
      transfersToDate: data.transfersToDate != null ? String(data.transfersToDate) : "",
      recentClients: data.recentClients ?? "",
      watchouts: data.watchouts ?? "",
    });
    setEditingPlaybook(true);
  };

  const savePlaybook = async () => {
    if (!data) return;
    const payload: Record<string, unknown> = {};
    // Text/email fields: trimmed, empty → null. Only send changed fields.
    const textField = (key: keyof PlaybookDraft, current: string | null) => {
      const raw = playbookDraft[key] as string;
      if (raw === (current ?? "")) return;
      const next = raw.trim() || null;
      if (next !== (current ?? null)) payload[key] = next;
    };
    textField("dtcNumber", data.dtcNumber);
    textField("receivingAccountNumber", data.receivingAccountNumber);
    textField("signature", data.signature);
    textField("letterOfAcceptance", data.letterOfAcceptance);
    textField("medallionRequired", data.medallionRequired);
    textField("liquidationMethod", data.liquidationMethod);
    textField("returnMethod", data.returnMethod);
    const currentContact = getContact(data);
    const nextContactDetails = playbookDraft.contactDetails.trim() || null;
    if (
      playbookDraft.contactMethod !== currentContact.contactMethod ||
      (playbookDraft.contactDetails !== currentContact.contactDetails &&
        nextContactDetails !== (currentContact.contactDetails || null))
    ) {
      payload.contactMethod = playbookDraft.contactMethod || null;
      payload.contactDetails = playbookDraft.contactMethod ? nextContactDetails : null;
    }
    textField("recentClients", data.recentClients);
    textField("watchouts", data.watchouts);

    const nextTransfer = playbookDraft.transferType || null;
    if (nextTransfer !== (data.transferType ?? null)) payload.transferType = nextTransfer;
    const nextDoc = playbookDraft.documentationStatus || null;
    if (nextDoc !== (data.documentationStatus ?? null)) payload.documentationStatus = nextDoc;

    if (playbookDraft.paperworkOnFile !== (data.paperworkOnFile ?? false))
      payload.paperworkOnFile = playbookDraft.paperworkOnFile;

    const rawTransfers = playbookDraft.transfersToDate.trim();
    const nextTransfers = rawTransfers === "" ? null : parseInt(rawTransfers, 10);
    if (
      nextTransfers !== (data.transfersToDate ?? null) &&
      !(nextTransfers != null && Number.isNaN(nextTransfers))
    )
      payload.transfersToDate = nextTransfers;

    if (Object.keys(payload).length === 0) {
      setEditingPlaybook(false);
      return;
    }

    try {
      const res = await fetch(`/api/custodians/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      flash("Transfer playbook updated", "success");
      setEditingPlaybook(false);
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to save", "error");
    }
  };

  const startFeeEdit = (fee: CustodianFee) => {
    setShowAddFee(false);
    setEditingFeeId(fee.id);
    setFeeDraft({
      feeType: fee.feeType,
      accountType: fee.accountType,
      transferType: fee.transferType,
      direction: fee.direction ?? "ANY",
      amount: fee.amount != null ? String(fee.amount) : "",
      amountText: fee.amountText ?? "",
      notes: fee.notes ?? "",
      documentation: fee.documentation ?? "",
    });
  };

  const feePayload = () => {
    const payload: Record<string, unknown> = {
      feeType: feeDraft.feeType.trim(),
      accountType: feeDraft.accountType,
      transferType: feeDraft.transferType,
      direction: feeDraft.direction,
    };
    const parsed = parseFloat(feeDraft.amount);
    payload.amount = Number.isFinite(parsed) ? parsed : null;
    payload.amountText = feeDraft.amountText.trim() || null;
    payload.notes = feeDraft.notes.trim() || null;
    payload.documentation = feeDraft.documentation.trim() || null;
    return payload;
  };

  const saveFeeEdit = async () => {
    if (!editingFeeId) return;
    setBusyFeeId(editingFeeId);
    try {
      const res = await fetch(`/api/custodians/${id}/fees/${editingFeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feePayload()),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      flash("Fee updated", "success");
      setEditingFeeId(null);
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to save", "error");
    } finally {
      setBusyFeeId(null);
    }
  };

  const addFee = async () => {
    try {
      const res = await fetch(`/api/custodians/${id}/fees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feePayload()),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to add");
      flash("Fee added", "success");
      setShowAddFee(false);
      setFeeDraft(BLANK_FEE);
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to add", "error");
    }
  };

  const deleteFee = async (feeId: string) => {
    if (!confirm("Delete this fee row? This cannot be undone.")) return;
    setBusyFeeId(feeId);
    try {
      const res = await fetch(`/api/custodians/${id}/fees/${feeId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to delete");
      }
      flash("Fee deleted", "success");
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to delete", "error");
    } finally {
      setBusyFeeId(null);
    }
  };

  const markReviewed = async () => {
    try {
      const res = await fetch(`/api/custodians/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus: "VERIFIED" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to update");
      flash("Marked reviewed", "success");
      await mutate();
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to update", "error");
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this custodian? This cannot be undone.")) return;
    setDangerBusy(true);
    try {
      const res = await fetch(`/api/custodians/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to delete");
      }
      router.push("/admin/custodians");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to delete", "error");
      setDangerBusy(false);
    }
  };

  const handleMerge = async () => {
    if (!mergeTargetId) {
      flash("Choose a custodian to merge into", "error");
      return;
    }
    if (
      !confirm(
        "Merge this custodian into the selected one? Its ACAT records and attached fee schedules will be moved, and this card deleted."
      )
    )
      return;
    setDangerBusy(true);
    try {
      const res = await fetch(`/api/custodians/${id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCustodianId: mergeTargetId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to merge");
      router.push("/admin/custodians");
    } catch (err) {
      flash(err instanceof Error ? err.message : "Failed to merge", "error");
      setDangerBusy(false);
    }
  };

  const fees = useMemo(() => data?.fees ?? [], [data]);
  const mergeCandidates = useMemo(
    () => (allCustodians ?? []).filter((c) => c.id !== id),
    [allCustodians, id]
  );

  if (status === "loading" || isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  if (!session) return null;

  if (error || !data) {
    return (
      <div className="min-h-screen bg-surface">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <div className="rounded-xl border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-6 py-4 text-sm text-[color:var(--danger)]">
            Failed to load custodian.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center gap-4">
          <button
            onClick={() => router.push("/admin/custodians")}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--invert-bg)] text-[var(--invert-text)]">
              <Building2 size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">{data.name}</h1>
              <p className="text-sm text-muted">
                {buildPlaybookSummary(data) ?? "Custodian record + fee schedule"}
              </p>
            </div>
          </div>
        </div>

        {flashError && (
          <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-3 text-sm text-[color:var(--danger)]">
            <AlertTriangle size={16} className="shrink-0" />
            {flashError}
            <button onClick={() => setFlashError(null)} className="ml-auto">
              <X size={14} />
            </button>
          </div>
        )}
        {flashSuccess && (
          <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-[color:var(--success-border)] bg-[color:var(--success-bg)] px-4 py-3 text-sm text-[color:var(--success)]">
            <Check size={16} className="shrink-0" />
            {flashSuccess}
          </div>
        )}

        {/* Needs-setup banner + Mark reviewed */}
        {isAdmin && data.reviewStatus === "NEEDS_SETUP" && (
          <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-4 py-3 text-sm text-[color:var(--warning)]">
            <AlertTriangle size={16} className="shrink-0" />
            <span className="flex-1">
              This custodian was auto-created from an ingested contra and needs review.
            </span>
            <button
              onClick={markReviewed}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-3 py-1 text-xs font-semibold text-[var(--invert-text)] transition hover:opacity-90"
            >
              <Check size={12} />
              Mark reviewed
            </button>
          </div>
        )}

        {/* Meta panel */}
        <div className="mb-6 rounded-xl border border-card-border bg-[var(--bg-card)] p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Custodian details</h2>
            {!isAdmin ? null : !editingMeta ? (
              <button
                onClick={startMetaEdit}
                className="flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-1 text-xs font-medium text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
              >
                <Pencil size={12} />
                Edit
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={saveMeta}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-3 py-1 text-xs font-semibold text-[var(--invert-text)] transition hover:opacity-90"
                >
                  <Check size={12} />
                  Save
                </button>
                <button
                  onClick={() => setEditingMeta(false)}
                  className="rounded-lg border border-card-border px-3 py-1 text-xs text-muted hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {editingMeta ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <MetaInput label="Name" value={metaDraft.name}
                onChange={(v) => setMetaDraft((d) => ({ ...d, name: v }))} />
              <MetaInput label="Expected processing days (SLA)" type="number" value={metaDraft.avgProcessingDays}
                onChange={(v) => setMetaDraft((d) => ({ ...d, avgProcessingDays: v }))} />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-y-2 text-sm md:grid-cols-2">
              <MetaRow label="Name" value={data.name} />
              <MetaRow label="Expected processing days (SLA)" value={`${data.avgProcessingDays} days`} />
            </div>
          )}
        </div>

        {/* Transfer playbook panel (ticket) */}
        <PlaybookPanel
          data={data}
          isAdmin={isAdmin}
          editing={editingPlaybook}
          draft={playbookDraft}
          onDraftChange={setPlaybookDraft}
          onStartEdit={startPlaybookEdit}
          onSave={savePlaybook}
          onCancel={() => setEditingPlaybook(false)}
        />

        {/* Fees panel */}
        <div className="rounded-xl border border-card-border bg-[var(--bg-card)] shadow-sm">
          <div className="flex items-center justify-between border-b border-card-border px-6 py-3">
            <h2 className="text-sm font-semibold text-foreground">
              Fee schedule <span className="text-muted-faint">({fees.length})</span>
            </h2>
            {isAdmin && !showAddFee && !editingFeeId && (
              <button
                onClick={() => { setFeeDraft(BLANK_FEE); setShowAddFee(true); }}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-3 py-1 text-xs font-semibold text-[var(--invert-text)] transition hover:opacity-90"
              >
                <Plus size={12} />
                Add fee
              </button>
            )}
          </div>

          <CustodianFeeScheduleDocuments
            key={id}
            custodianId={id}
            canUpload={isAdmin}
            onUploaded={() => { void mutate(); }}
          />

          {showAddFee && (
            <div className="border-b border-card-border bg-[var(--bg-hover)] px-6 py-4">
              <FeeEditor
                draft={feeDraft}
                onChange={setFeeDraft}
                onSave={addFee}
                onCancel={() => { setShowAddFee(false); setFeeDraft(BLANK_FEE); }}
                saveLabel="Add"
              />
            </div>
          )}

          {fees.length === 0 && !showAddFee ? (
            <div className="px-6 py-10 text-center text-sm text-muted">
              {isAdmin ? (
                <>No fees on file yet. Click <strong>Add fee</strong> to create one.</>
              ) : (
                <>No fees on file yet.</>
              )}
            </div>
          ) : (
            <div className="divide-y divide-card-border">
              {fees.map((fee) => {
                const isEditing = editingFeeId === fee.id;
                const busy = busyFeeId === fee.id;
                return (
                  <div key={fee.id} className="px-6 py-4">
                    {isEditing ? (
                      <FeeEditor
                        draft={feeDraft}
                        onChange={setFeeDraft}
                        onSave={saveFeeEdit}
                        onCancel={() => setEditingFeeId(null)}
                        saveLabel="Save"
                        saving={busy}
                      />
                    ) : (
                      <FeeRow
                        fee={fee}
                        busy={busy}
                        canEdit={isAdmin}
                        onEdit={() => startFeeEdit(fee)}
                        onDelete={() => deleteFee(fee.id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Danger zone — delete when empty, else merge into another card */}
        {isAdmin && (
          <div className="mt-6 rounded-xl border border-[color:var(--danger-border)] bg-[var(--bg-card)] shadow-sm">
            <div className="border-b border-[color:var(--danger-border)] px-6 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[color:var(--danger)]">
                <AlertTriangle size={16} />
                Danger zone
              </h2>
            </div>
            <div className="px-6 py-4">
              {data.linkedRecordCount === 0 && !data.feeScheduleDocumentCount ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted">
                    No ACAT records or fee schedule documents are linked to this custodian.
                    It can be deleted permanently (its fee rows are removed too).
                  </p>
                  <button
                    onClick={handleDelete}
                    disabled={dangerBusy}
                    className="flex items-center gap-1.5 rounded-lg border border-[color:var(--danger-border)] px-4 py-2 text-sm font-semibold text-[color:var(--danger)] transition hover:bg-[color:var(--danger-bg)] disabled:opacity-50"
                  >
                    {dangerBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    Delete custodian
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted">
                    This custodian has {data.linkedRecordCount} linked ACAT record(s)
                    {data.feeScheduleDocumentCount ? ` and ${data.feeScheduleDocumentCount} attached fee schedule(s)` : ""}.
                    Merge it into another custodian to preserve the records and
                    documents before removing this card.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block flex-1 min-w-[240px]">
                      <span className="mb-1 block text-xs font-medium text-muted">
                        Merge into
                      </span>
                      <select
                        value={mergeTargetId}
                        onChange={(e) => setMergeTargetId(e.target.value)}
                        className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                      >
                        <option value="">Select a custodian…</option>
                        {mergeCandidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={handleMerge}
                      disabled={dangerBusy || !mergeTargetId}
                      className="flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 disabled:opacity-50"
                    >
                      {dangerBusy ? <Loader2 size={13} className="animate-spin" /> : <Building2 size={13} />}
                      Merge
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ticket: Transfer playbook — grouped view/edit of the contra fields.
// ticket: exported so the display restyle can be unit-tested in isolation
// (pure props component — no hooks/router/SWR).
function PlaybookPanel({
  data,
  isAdmin,
  editing,
  draft,
  onDraftChange,
  onStartEdit,
  onSave,
  onCancel,
}: {
  data: CustodianDetail;
  isAdmin: boolean;
  editing: boolean;
  draft: PlaybookDraft;
  onDraftChange: (next: PlaybookDraft) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof PlaybookDraft>(key: K, value: PlaybookDraft[K]) =>
    onDraftChange({ ...draft, [key]: value });
  const contact = getContact(data);
  const changeContactMethod = (next: ContactMethod | "") => {
    const contactDetailsByMethod = { ...draft.contactDetailsByMethod };
    if (draft.contactMethod) contactDetailsByMethod[draft.contactMethod] = draft.contactDetails;
    onDraftChange({
      ...draft,
      contactMethod: next,
      contactDetails: next ? contactDetailsByMethod[next] ?? "" : "",
      contactDetailsByMethod,
    });
  };

  return (
    <div className="mb-6 rounded-xl border border-card-border bg-[var(--bg-card)] p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Transfer playbook</h2>
        {!isAdmin ? null : !editing ? (
          <button
            onClick={onStartEdit}
            className="flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-1 text-xs font-medium text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <Pencil size={12} />
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              onClick={onSave}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-3 py-1 text-xs font-semibold text-[var(--invert-text)] transition hover:opacity-90"
            >
              <Check size={12} />
              Save
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg border border-card-border px-3 py-1 text-xs text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-5">
          <PlaybookGroup title="Routing">
            <MetaInput label="DTC / clearing #" value={draft.dtcNumber}
              onChange={(v) => set("dtcNumber", v)} />
            <div>
              <MetaInput
                label="Receiving / house account #"
                value={draft.receivingAccountNumber}
                onChange={(v) => set("receivingAccountNumber", v)}
              />
              <p className="mt-1 text-xs text-muted">
                Last-known value only; verify it before each transfer.
              </p>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Transfer type</span>
              <select
                value={draft.transferType}
                onChange={(e) => set("transferType", e.target.value as PlaybookTransferType | "")}
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              >
                <option value="">— (unset)</option>
                {PLAYBOOK_TRANSFER_TYPES.map((t) => (
                  <option key={t} value={t}>{TRANSFER_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Documentation status</span>
              <select
                value={draft.documentationStatus}
                onChange={(e) => set("documentationStatus", e.target.value as DocStatus | "")}
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              >
                <option value="">— (unset)</option>
                {(["DOCUMENTED", "PARTIAL", "NEEDS_CALL"] as DocStatus[]).map((s) => (
                  <option key={s} value={s}>{DOC_STATUS_LABELS[s]}</option>
                ))}
              </select>
            </label>
          </PlaybookGroup>

          <PlaybookGroup title="Requirements">
            <PlaybookSelect label="Signature" value={draft.signature} existingValue={data.signature} options={SIGNATURE_OPTIONS}
              onChange={(v) => set("signature", v)} />
            <PlaybookSelect label="Letter of acceptance" value={draft.letterOfAcceptance} existingValue={data.letterOfAcceptance} options={REQUIREMENT_OPTIONS}
              onChange={(v) => set("letterOfAcceptance", v)} />
            <PlaybookSelect label="Medallion (MSG)" value={draft.medallionRequired} existingValue={data.medallionRequired} options={REQUIREMENT_OPTIONS}
              onChange={(v) => set("medallionRequired", v)} />
            <label className="flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={draft.paperworkOnFile}
                onChange={(e) => set("paperworkOnFile", e.target.checked)}
                className="h-4 w-4 rounded border-card-border"
              />
              <span className="text-sm text-foreground">Paperwork on file</span>
            </label>
            <p className="text-xs text-muted md:col-span-2">
              Add any conditions or exceptions in Watchouts. Existing custom values are kept until you choose a replacement.
            </p>
          </PlaybookGroup>

          <PlaybookGroup title="Proceeds & contact">
            <PlaybookSelect label="Liquidation proceeds" value={draft.liquidationMethod} existingValue={data.liquidationMethod} options={LIQUIDATION_OPTIONS}
              onChange={(v) => set("liquidationMethod", v)} />
            <PlaybookSelect label="Return method" value={draft.returnMethod} existingValue={data.returnMethod} options={RETURN_METHOD_OPTIONS}
              onChange={(v) => set("returnMethod", v)} />
            <p className="text-xs text-muted md:col-span-2">
              Put routing instructions, mailing addresses, or exceptions in Watchouts.
            </p>
            <PlaybookSelect label="Contact method" value={draft.contactMethod}
              options={Object.entries(CONTACT_METHOD_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(v) => changeContactMethod(v as ContactMethod | "")} />
            {draft.contactMethod && (
              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs font-medium text-muted">Contact details</span>
                {draft.contactMethod === "EMAIL" ? (
                  <input
                    type="email"
                    value={draft.contactDetails}
                    maxLength={254}
                    placeholder="Email address"
                    onChange={(e) => set("contactDetails", e.target.value)}
                    className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                ) : (
                  <textarea
                    value={draft.contactDetails}
                    maxLength={2000}
                    rows={3}
                    placeholder={draft.contactMethod === "PHONE" ? "Phone number, extension, and contact name" : draft.contactMethod === "PORTAL" ? "Portal URL and contact instructions" : "Contact details and instructions"}
                    onChange={(e) => set("contactDetails", e.target.value)}
                    className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
                  />
                )}
              </label>
            )}
          </PlaybookGroup>

          <PlaybookGroup title="Track record">
            <MetaInput label="Transfers to date" type="number" value={draft.transfersToDate}
              onChange={(v) => set("transfersToDate", v)} />
            <MetaInput label="Recent clients" value={draft.recentClients}
              onChange={(v) => set("recentClients", v)} />
          </PlaybookGroup>

          <div>
            <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted">
              Watchouts
            </span>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                One per line (use • or newlines for bullets)
              </span>
              <textarea
                value={draft.watchouts}
                onChange={(e) => set("watchouts", e.target.value)}
                rows={6}
                className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <PlaybookGroup title="Routing">
            <MetaRow label="DTC / clearing #">
              {data.dtcNumber ? <Pill tone="neutral" mono>{data.dtcNumber}</Pill> : <Dash />}
            </MetaRow>
            <MetaRow label="Receiving / house account #">
              {data.receivingAccountNumber ? (
                <span>
                  <Pill tone="warning" mono>
                    {data.receivingAccountNumber}
                  </Pill>
                  <span className="ml-2 text-xs text-muted">
                    Verify before use
                  </span>
                </span>
              ) : (
                <Dash />
              )}
            </MetaRow>
            <MetaRow label="Transfer type">
              {data.transferType ? (
                <Pill tone="accent">{TRANSFER_TYPE_LABELS[data.transferType]}</Pill>
              ) : (
                <Dash />
              )}
            </MetaRow>
            <MetaRow label="Documentation status">
              {data.documentationStatus ? (
                <Pill tone={data.documentationStatus === "DOCUMENTED" ? "success" : "warning"}>
                  {DOC_STATUS_LABELS[data.documentationStatus]}
                </Pill>
              ) : (
                <Dash />
              )}
            </MetaRow>
          </PlaybookGroup>

          <PlaybookGroup title="Requirements">
            <MetaRow label="Signature" value={playbookLabel(data.signature, SIGNATURE_OPTIONS)} />
            <MetaRow label="Letter of acceptance" value={playbookLabel(data.letterOfAcceptance, REQUIREMENT_OPTIONS)} />
            <MetaRow label="Medallion (MSG)" value={playbookLabel(data.medallionRequired, REQUIREMENT_OPTIONS)} />
            <MetaRow label="Paperwork on file">
              {data.paperworkOnFile == null ? (
                <Dash />
              ) : (
                <Pill tone={data.paperworkOnFile ? "success" : "neutral"}>
                  {data.paperworkOnFile ? "Yes" : "No"}
                </Pill>
              )}
            </MetaRow>
          </PlaybookGroup>

          <PlaybookGroup title="Proceeds & contact">
            <MetaRow label="Liquidation proceeds" value={playbookLabel(data.liquidationMethod, LIQUIDATION_OPTIONS)} />
            <MetaRow label="Return method" value={playbookLabel(data.returnMethod, RETURN_METHOD_OPTIONS)} />
            <MetaRow label="Contact method" value={contact.contactMethod ? CONTACT_METHOD_LABELS[contact.contactMethod] : "—"} />
            <MetaRow label="Contact details">
              <span className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground">{contact.contactDetails || "—"}</span>
            </MetaRow>
          </PlaybookGroup>

          <PlaybookGroup title="Track record">
            <MetaRow label="Transfers to date">
              {data.transfersToDate != null ? (
                <Pill tone="neutral">{String(data.transfersToDate)}</Pill>
              ) : (
                <Dash />
              )}
            </MetaRow>
            <MetaRow label="Recent clients" value={data.recentClients ?? "—"} />
          </PlaybookGroup>

          <div data-playbook-group="Watchouts" className="rounded-lg border border-card-border bg-[var(--bg-hover)] p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-3.5 w-0.5 rounded bg-accent" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Watchouts
              </span>
            </div>
            <Watchouts text={data.watchouts} />
          </div>
        </div>
      )}
    </div>
  );
}

// A labeled sub-section inside the Transfer playbook. ticket: an accent-bar
// header with its rows nested in a subtle sub-panel so the four groups read as
// distinct cards. `data-playbook-group` is a stable test hook.
function PlaybookGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div data-playbook-group={title} className="rounded-lg border border-card-border bg-[var(--bg-hover)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3.5 w-0.5 rounded bg-accent" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {title}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-2">{children}</div>
    </div>
  );
}

// ticket: theme-safe badge. `text-foreground` on `bg-[var(--bg-hover)]` and
// the success/warning/accent token trios are all defined for light AND dark, so
// values (incl. the DTC number) stay legible in both modes. `data-pill` is a
// stable test hook. No hardcoded hex.
type PillTone = "neutral" | "accent" | "success" | "warning";

function Pill({
  tone,
  mono,
  children,
}: {
  tone: PillTone;
  mono?: boolean;
  children: ReactNode;
}) {
  const tones: Record<PillTone, string> = {
    neutral: "border-card-border bg-[var(--bg-hover)] text-foreground",
    accent: "border-[color:var(--accent)]/30 bg-[color:var(--accent)]/10 text-accent",
    success:
      "border-[color:var(--success-border)] bg-[color:var(--success-bg)] text-[color:var(--success)]",
    warning:
      "border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] text-[color:var(--warning)]",
  };
  return (
    <span
      data-pill
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        mono ? "font-mono" : ""
      } ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Dash() {
  return <span className="text-sm text-muted">—</span>;
}

// Render watchouts as structured bullets: split on newlines / leading bullet
// markers into <li>s (falls back to "—" when empty).
function Watchouts({ text }: { text: string | null }) {
  if (!text || !text.trim()) {
    return <span className="text-sm text-foreground">—</span>;
  }
  const items = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[•◦·]\s*|-\s+)/, "").trim())
    .filter(Boolean);
  if (items.length === 0) {
    return <span className="text-sm text-foreground">—</span>;
  }
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

// ticket: renders `children` (a pill/badge) when provided, else the plain
// text `value`. Free-text fields keep the text form; categorical fields pass a
// <Pill>.
function MetaRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-40 shrink-0 text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      {children ?? <span className="text-sm text-foreground">{value}</span>}
    </div>
  );
}

function PlaybookSelect({
  label,
  value,
  existingValue,
  options,
  onChange,
}: {
  label: string;
  value: string;
  existingValue?: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  // Retain the original option while editing, even after a different option
  // is selected, so the operator can switch back without losing any text.
  const id = useId();
  const customValue = existingValue && !options.some((option) => option.value === existingValue)
    ? existingValue
    : null;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">{label}</label>
      <select
        id={id}
        aria-describedby={customValue && value === customValue ? `${id}-existing` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      >
        <option value="">— (unset)</option>
        {customValue && <option value={customValue}>Existing: {customValue}</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {customValue && value === customValue && (
        <p id={`${id}-existing`} className="mt-1 whitespace-pre-wrap break-words text-xs text-muted">{customValue}</p>
      )}
    </div>
  );
}

function MetaInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email" | "number";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
    </label>
  );
}

function FeeRow({
  fee,
  busy,
  canEdit,
  onEdit,
  onDelete,
}: {
  fee: CustodianFee;
  busy: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const amountDisplay =
    fee.amount != null ? `$${fee.amount.toFixed(2)}` : fee.amountText || "—";

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex-1 min-w-[240px]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{fee.feeType}</span>
          <span className="inline-flex items-center rounded-full border border-card-border bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-medium text-muted">
            {fee.accountType}
          </span>
          <span className="inline-flex items-center rounded-full border border-card-border bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-medium text-muted">
            {fee.transferType}
          </span>
          <span
            className="inline-flex items-center rounded-full border border-card-border bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-medium text-muted"
            title="When this custodian's fee applies, based on the transfer's direction relative to Apex"
          >
            {DIRECTION_LABELS[fee.direction ?? "ANY"]}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted">
          <span className="font-mono text-foreground">{amountDisplay}</span>
          {fee.notes && <span>· {fee.notes}</span>}
          {fee.documentation && <span>· {fee.documentation}</span>}
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-card-border px-3 py-1 text-xs text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground disabled:opacity-50"
          >
            <Pencil size={11} />
            Edit
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-[color:var(--danger-border)] px-3 py-1 text-xs text-[color:var(--danger)] transition hover:bg-[color:var(--danger-bg)] disabled:opacity-50"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function FeeEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  saveLabel,
  saving = false,
}: {
  draft: typeof BLANK_FEE;
  onChange: (next: typeof BLANK_FEE) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
  saving?: boolean;
}) {
  const set = <K extends keyof typeof BLANK_FEE>(
    key: K,
    value: (typeof BLANK_FEE)[K]
  ) => onChange({ ...draft, [key]: value });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <MetaInput
          label="Fee type"
          value={draft.feeType}
          onChange={(v) => set("feeType", v)}
        />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Account type</span>
          <select
            value={draft.accountType}
            onChange={(e) => set("accountType", e.target.value as AccountType)}
            className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Transfer type</span>
          <select
            value={draft.transferType}
            onChange={(e) => set("transferType", e.target.value as TransferType)}
            className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {TRANSFER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Transfer direction relative to Apex</span>
          <select
            value={draft.direction}
            onChange={(e) => set("direction", e.target.value as Direction)}
            className="w-full rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted md:col-span-3">
          These are this custodian’s fees. “Transfer into Apex” means assets leave this custodian; “Transfer out of Apex” means assets go to this custodian.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <MetaInput
          label="Amount (USD, blank if unknown)"
          type="number"
          value={draft.amount}
          onChange={(v) => set("amount", v)}
        />
        <MetaInput
          label='Amount text (e.g. "Call contra")'
          value={draft.amountText}
          onChange={(v) => set("amountText", v)}
        />
      </div>
      <MetaInput
        label="Notes"
        value={draft.notes}
        onChange={(v) => set("notes", v)}
      />
      <MetaInput
        label="Documentation (link or reference)"
        value={draft.documentation}
        onChange={(v) => set("documentation", v)}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {saveLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-card-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
