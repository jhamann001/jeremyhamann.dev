"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useEffectiveRole } from "@/lib/use-effective-role";
import {
  ChevronRight,
  ChevronDown,
  Calendar,
  Hash,
  Building2,
  CreditCard,
  ShieldCheck,
  DollarSign,
  FileBarChart,
  Clock,
  Package,
  AlertTriangle,
  CheckCircle2,
  UserCircle,
  Pencil,
  History,
  Trash2,
  Loader2,
} from "lucide-react";
import {
  AcatRecord,
  AcatStatus,
  ACAT_STATUS_LABELS,
  ACAT_STATUS_PICKER_OPTIONS,
  RECON_DERIVED_STATUSES,
  TERMINAL_STATUSES,
} from "@/lib/types";
import { useInlineEdit, UseInlineEditApi } from "@/hooks/use-inline-edit";
import SecurityReconTab from "./SecurityReconTab";
import FeesTab from "./FeesTab";
import TransferDetailsTab from "./TransferDetailsTab";
import ConfirmDeleteAcatModal from "./ConfirmDeleteAcatModal";
import FinalizeAcatModal from "./FinalizeAcatModal";
import RecordHistoryTab from "./RecordHistoryTab";
import InlineField from "./InlineField";
import { useToast } from "./Toast";
import { formatDateMMDDYYYY } from "@/lib/format";
import { DataQualityFocus } from "@/lib/data-quality-focus";
import { useClientIdentityStatus } from "@/hooks/use-client-identity-status";
import ClientIdentityRelinkDialog from "./ClientIdentityRelinkDialog";
import { getLinkedClients } from "./client-identity-display";

interface AcatDetailProps {
  acat: AcatRecord;
  onMutate?: () => void;
  /**
   * Called after a successful soft-delete. Used by the drawer to close
   * itself; on the full-page detail route it typically navigates away.
   */
  onDeleted?: () => void;
  /**
   * Presentation variant. `page` keeps the original full-width layout used on
   * the legacy detail route. `drawer` tightens padding and re-flows the header
   * to fit inside a ~560px side panel. All fields are still rendered.
   */
  layout?: "page" | "drawer";
  focus?: DataQualityFocus;
}

type TabKey = "details" | "recon" | "fees" | "history";

const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "details", label: "Transfer Details", icon: <FileBarChart size={15} /> },
  { key: "recon", label: "Security Recon", icon: <ShieldCheck size={15} /> },
  { key: "fees", label: "Fees", icon: <DollarSign size={15} /> },
  { key: "history", label: "History", icon: <History size={15} /> },
];

// ticket item 4: the status dropdown only offers ACAT lifecycle states.
// The recon-derived trio (Matched / Mismatch / Pending) is computed from
// the asset matching rate and rendered in its own column.
const STATUS_OPTIONS: AcatStatus[] = ACAT_STATUS_PICKER_OPTIONS;

export default function AcatDetail({ acat, onMutate, onDeleted, layout = "page", focus }: AcatDetailProps) {
  const [activeTab, setActiveTab] = useState<TabKey>(focus?.tab ?? "details");
  const isDrawer = layout === "drawer";
  const { toast } = useToast();
  const { role } = useEffectiveRole();
  const isAdmin = role === "ADMIN";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false);
  const identity = useClientIdentityStatus();
  const linkedClients = getLinkedClients(acat);
  const identityVersionAtEdit = useRef(acat.identityVersion);
  const [deleting, setDeleting] = useState(false);
  const [finalizingStatus, setFinalizingStatus] = useState<
    "Completed" | "Rejected" | null
  >(null);
  const [finalizing, setFinalizing] = useState(false);
  // Capture once at mount so useMemo stays pure; the detail view is short-lived
  // enough that a stable "now" reference is acceptable for day counters.
  const [mountedAt] = useState(() => Date.now());

  const stats = useMemo(() => {
    const totalAssets = acat.assets.length;
    // Trust the persisted mapStatus written by SecurityReconTab.saveReconResults
    // instead of recomputing from the qty delta. The recon engine intentionally
    // collapses Apex surpluses (actual > expected) and manual overrides onto
    // `Mapped`; comparing expectedQty !== actualQty here would flip those
    // just-saved Mapped rows back into issues and contradict what the recon
    // tab and records view show. `Expected` assets are affirmatively
    // accounted for and count as matched; `Pending` sits in neither bucket.
    const matchedAssets = acat.assets.filter(
      (a) => a.mapStatus === "Mapped" || a.mapStatus === "Expected"
    ).length;
    const issueAssets = acat.assets.filter(
      (a) => a.mapStatus === "Unmapped"
    ).length;
    const daysSince = Math.floor(
      (mountedAt - new Date(acat.acatDate).getTime()) / 86400000
    );
    return { totalAssets, matchedAssets, issueAssets, daysSince };
  }, [acat, mountedAt]);

  const patchRecord = useCallback(
    async (updates: Record<string, unknown>) => {
      try {
        // Normalize empty strings → null for the PATCH so callers that pass
        // a cleared text field don't get silently dropped by the handler's
        // `if (newVal === undefined) continue` check.
        const normalized: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(updates)) {
          normalized[k] = v === "" && k !== "apexAccountId" ? null : v;
        }
        if (["clientName", "apexAccountId", "acatTransferId"].some((key) => key in updates) && identityVersionAtEdit.current != null) {
          normalized.expectedIdentityVersion = identityVersionAtEdit.current;
        }
        const res = await fetch(`/api/acats/${acat.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(normalized),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.code === "IDENTITY_CONFLICT" ? "Client details changed. Cancel this edit and reopen it after refreshing the record." : body.error || "Could not save changes");
        }
        onMutate?.();
        return true;
      } catch (error) {
        toast("error", "Update Failed", error instanceof Error ? error.message : "Could not save changes");
        return false;
      }
    },
    [acat.id, onMutate, toast]
  );

  // Centralized inline-edit state. Both the wealth-advisor pill and the
  // notes banner share this hook so blur-to-save / Escape-to-cancel /
  // unchanged-value-no-op behave the same everywhere. Per-field success
  // toasts intentionally aren't fired anymore — the InlineField "Saved"
  // pill replaces them, and toasts are reserved for failures.
  const inlineEdit = useInlineEdit({
    onSave: async (field, value) => {
      return await patchRecord({ [field]: value });
    },
  });
  const edit = { ...inlineEdit, start: (field: string, value: string) => {
    identityVersionAtEdit.current = acat.identityVersion;
    inlineEdit.start(field, value);
  } };

  const handleStatusChange = async (newStatus: AcatStatus) => {
    if (newStatus === "Completed" || newStatus === "Rejected") {
      setFinalizingStatus(newStatus);
      return;
    }
    // ticket: The legacy `completedDate` column was dropped. Going
    // forward, "when did this ACAT settle" is captured only by
    // `apexCompletionDate`, which Ops enters manually when the custodian
    // confirms. We no longer auto-stamp anything on status change.
    const success = await patchRecord({ status: newStatus });
    if (success) {
      toast("success", "Status Updated", `Changed to ${ACAT_STATUS_LABELS[newStatus]}`);
    }
  };

  const handleMarkComplete = async () => {
    setFinalizingStatus("Completed");
  };

  const handleFinalize = async (updates: Record<string, unknown>) => {
    setFinalizing(true);
    const success = await patchRecord(updates);
    if (success) {
      const completed = updates.status === "Completed";
      toast(
        "success",
        completed ? "Marked Complete" : "Marked Rejected",
        `${acat.clientName} marked as ${completed ? "Completed" : "Rejected"}`
      );
      setFinalizingStatus(null);
    }
    setFinalizing(false);
    return success;
  };

  const handleConfirmDelete = useCallback(
    async (reason: string) => {
      setDeleting(true);
      try {
        const res = await fetch(`/api/acats/${acat.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(
            "error",
            "Delete failed",
            data?.error ?? `HTTP ${res.status}`
          );
          return;
        }
        toast(
          "success",
          "ACAT deleted",
          `${acat.clientName} hidden from list`
        );
        setConfirmingDelete(false);
        onMutate?.();
        onDeleted?.();
      } catch (err) {
        toast(
          "error",
          "Delete failed",
          err instanceof Error ? err.message : "Network error"
        );
      } finally {
        setDeleting(false);
      }
    },
    [acat.id, acat.clientName, onDeleted, onMutate, toast]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden animate-fade-in">
      {/* Header */}
      <div
        className={`shrink-0 border-b border-card-border bg-[var(--bg-card)] ${
          isDrawer ? "px-5 pt-4 pb-0" : "px-8 pt-5 pb-0"
        }`}
      >
        {/* Breadcrumbs — page layout only; drawer header is self-evident */}
        {!isDrawer && (
          <div className="mb-2.5 flex items-center gap-1.5 text-xs text-muted">
            <span className="cursor-pointer transition hover:text-accent">ACATs</span>
            <ChevronRight size={11} />
            <span className="cursor-pointer transition hover:text-accent">
              {acat.transferringContra || acat.custodianName}
            </span>
            <ChevronRight size={11} />
            <span className="font-medium text-foreground">{acat.clientName}</span>
          </div>
        )}

        {/* Title + Actions */}
        <div className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 ${isDrawer ? "mb-3" : "mb-4"}`}>
          <div className="min-w-0 flex-1 basis-64">
            <div
              role="heading"
              aria-level={2}
              className={`truncate font-bold tracking-tight text-foreground ${
                isDrawer ? "text-lg" : "text-xl"
              }`}
            >
              {linkedClients.length > 0 || identity.status?.enabled ? <button type="button" className="max-w-full truncate text-left hover:text-accent" aria-label="Review client link" onClick={() => setIdentityDialogOpen(true)}>{acat.clientName}</button> : <InlineField
                field="clientName"
                value={acat.clientName}
                edit={edit}
                variant="block"
                ariaLabel="Edit Client Name"
                className="max-w-full"
                editable={Boolean(identity.status)}
                renderValue={(value) => (
                  <span className="truncate">{value}</span>
                )}
              />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{linkedClients.length ? <span className="inline-flex flex-wrap gap-x-3 gap-y-1" aria-label="Linked clients">{linkedClients.map((client) => <span key={client.cedarRidgeUserId} className="break-all">{client.displayName} · Cedar Ridge ID: {client.cedarRidgeUserId}</span>)}</span> : "Needs client link"}</span>
              <button type="button" className="text-accent underline underline-offset-2" onClick={() => setIdentityDialogOpen(true)}>{linkedClients.length ? "Review link" : "Link client"}</button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>Record {acat.id}</span>
              {acat.wealthAdvisor && (
                <>
                  <span className="text-card-border">|</span>
                  <InlineField
                    field="wealthAdvisor"
                    value={acat.wealthAdvisor || ""}
                    edit={edit}
                    icon={<UserCircle size={11} />}
                    placeholder="Add advisor"
                  />
                </>
              )}
              <span className="text-card-border">|</span>
              <span>
                Updated{" "}
                {formatDateMMDDYYYY(acat.lastUpdated)}
              </span>
            </div>
            <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted">
              <Pencil size={10} className="opacity-60" />
              Fields with a pencil can be edited and save automatically
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!TERMINAL_STATUSES.has(acat.status) && (
              <button
                onClick={handleMarkComplete}
                className={`inline-flex shrink-0 items-center gap-2 rounded-lg border border-[color:var(--success-border)] bg-[color:var(--success-bg)] font-semibold text-[color:var(--success)] transition hover:opacity-90 active:scale-[0.98] ${
                  isDrawer ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"
                }`}
              >
                <CheckCircle2 size={isDrawer ? 12 : 14} />
                Mark Complete
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete ACAT record"
                title="Delete ACAT record"
                className={`inline-flex shrink-0 items-center gap-2 rounded-lg border border-card-border font-semibold text-muted transition hover:border-[color:var(--danger-border)] hover:bg-[color:var(--danger-bg)] hover:text-[color:var(--danger)] active:scale-[0.98] ${
                  isDrawer ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"
                }`}
              >
                <Trash2 size={isDrawer ? 12 : 14} />
                Delete
              </button>
            )}
          </div>
        </div>

        {/* Properties Row */}
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {acat.controlNumber && (
            <PropertyPill icon={<Hash size={12} />} label="Control #" value={acat.controlNumber} mono />
          )}
          <PropertyPill icon={<CreditCard size={12} />} label="Apex Acct" value={acat.apexAccountId} mono />
          <PropertyPill icon={<Building2 size={12} />} label="Contra" value={acat.transferringContra || acat.custodianName} />
          {acat.direction && (
            <PropertyPill icon={<Hash size={12} />} label="Direction" value={acat.direction} />
          )}
          <PropertyPill
            icon={<Calendar size={12} />}
            label="Date"
            value={formatDateMMDDYYYY(acat.acatDate)}
          />
          {/* Inline status select. ticket item 4: only ACAT lifecycle
              statuses are offered. If a legacy record's status is one of
              the retired recon-derived values (Matched / Mismatch /
              Pending), we prepend that single value (suffixed with
              "(legacy)") so the dropdown still reflects current state and
              the operator can pick a real ACAT status to migrate it. */}
          <div className="flex items-center gap-1.5">
            <select
              value={acat.status}
              onChange={(e) => handleStatusChange(e.target.value as AcatStatus)}
              className="rounded-full border border-card-border bg-[var(--bg-card)] px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            >
              {RECON_DERIVED_STATUSES.has(acat.status) && (
                <option key={acat.status} value={acat.status}>
                  {ACAT_STATUS_LABELS[acat.status]} (legacy)
                </option>
              )}
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{ACAT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Stat Cards */}
        <div className={`grid gap-2 ${isDrawer ? "mb-3 grid-cols-4" : "mb-4 grid-cols-4"}`}>
          <StatCard icon={<Package size={14} />} label="Total Assets" value={String(stats.totalAssets)} color="blue" />
          <StatCard icon={<CheckCircle2 size={14} />} label="Matched" value={String(stats.matchedAssets)} color="green" />
          <StatCard icon={<AlertTriangle size={14} />} label="Issues" value={String(stats.issueAssets)} color={stats.issueAssets > 0 ? "red" : "green"} />
          <StatCard icon={<Clock size={14} />} label="Days Since Init" value={String(stats.daysSince)} color={stats.daysSince > 7 ? "amber" : "blue"} />
        </div>

        {/* Notes Banner (editable) — uses the same shared `edit` hook as
            InlineField, so blur/Esc/no-op behave identically. */}
        <NotesBanner notes={acat.notes ?? ""} edit={edit} />

        {/* Tabs (page layout only — drawer uses stacked collapsible sections below) */}
        {!isDrawer && (
          <div className="flex gap-0.5">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                    isActive
                      ? "border-accent bg-accent-light/50 text-accent"
                      : "border-transparent text-muted hover:text-foreground hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                  {tab.key === "recon" && stats.issueAssets > 0 && (
                    <span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[color:var(--danger)] px-1 text-[10px] font-bold text-[color:var(--invert-text)]">
                      {stats.issueAssets}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content area — tabs in page mode, collapsible sections in drawer mode */}
      <div
        className={`flex-1 overflow-y-auto overflow-x-hidden bg-surface ${
          isDrawer ? "px-5 py-4" : "px-8 py-6"
        }`}
      >
        {isDrawer ? (
          <div className="space-y-3">
            <CollapsibleSection
              title="Transfer Details"
              icon={<FileBarChart size={14} />}
              defaultOpen
            >
              <TransferDetailsTab acat={acat} onMutate={onMutate} focus={focus} />
            </CollapsibleSection>
            <CollapsibleSection
              title="Security Recon"
              icon={<ShieldCheck size={14} />}
              badge={stats.issueAssets}
              defaultOpen
            >
              <SecurityReconTab acat={acat} onMutate={onMutate} />
            </CollapsibleSection>
            <CollapsibleSection
              title="Fees"
              icon={<DollarSign size={14} />}
              defaultOpen
            >
              <FeesTab acat={acat} onMutate={onMutate} focus={focus} />
            </CollapsibleSection>
            <CollapsibleSection
              title="History"
              icon={<History size={14} />}
              defaultOpen={false}
            >
              <RecordHistoryTab acat={acat} />
            </CollapsibleSection>
          </div>
        ) : (
          <div className="animate-slide-in-up">
            {activeTab === "details" && <TransferDetailsTab acat={acat} onMutate={onMutate} focus={focus} />}
            {activeTab === "recon" && <SecurityReconTab acat={acat} onMutate={onMutate} />}
            {activeTab === "fees" && <FeesTab acat={acat} onMutate={onMutate} focus={focus} />}
            {activeTab === "history" && <RecordHistoryTab acat={acat} />}
          </div>
        )}
      </div>

      {identityDialogOpen && <ClientIdentityRelinkDialog key={acat.id} acat={acat} onClose={() => setIdentityDialogOpen(false)} onSaved={() => onMutate?.()} />}
      <ConfirmDeleteAcatModal
        recordId={acat.id}
        clientName={acat.clientName}
        open={confirmingDelete}
        deleting={deleting}
        onCancel={() => {
          if (!deleting) setConfirmingDelete(false);
        }}
        onConfirm={handleConfirmDelete}
      />
      <FinalizeAcatModal
        key={`${acat.id}-${finalizingStatus ?? "closed"}`}
        acat={acat}
        targetStatus={finalizingStatus}
        saving={finalizing}
        onCancel={() => {
          if (!finalizing) setFinalizingStatus(null);
        }}
        onConfirm={handleFinalize}
      />
    </div>
  );
}

function CollapsibleSection({
  title,
  icon,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  badge?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-[var(--bg-card)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-[var(--bg-hover)]"
      >
        <div className="flex items-center gap-2">
          <span className="text-muted">{icon}</span>
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge != null && badge > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[color:var(--danger)] px-1 text-[10px] font-bold text-[color:var(--invert-text)]">
              {badge}
            </span>
          )}
        </div>
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
      </button>
      {open && (
        <div className="border-t border-card-border bg-surface p-4">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * Notes banner with three visual states (filled banner, empty add-notes
 * button, edit-mode textarea) — all driven by the same shared
 * `useInlineEdit` instance the rest of AcatDetail uses, so blur-to-save,
 * Escape-to-cancel, and the no-op-when-unchanged behaviour are consistent.
 *
 * This isn't an `<InlineField>` because the banner styling for the filled
 * state is materially different from the standard inline pill; using the
 * hook directly is cheaper than threading enough customisation slots into
 * `InlineField` to render a colored alert banner.
 */
function NotesBanner({
  notes,
  edit,
}: {
  notes: string;
  edit: UseInlineEditApi;
}) {
  const isEditing = edit.editingField === "notes";

  if (isEditing) {
    const handlers = edit.bind("notes");
    return (
      <div className="mb-3 rounded-lg border border-accent/30 bg-accent-light/30 px-3 py-2">
        <textarea
          value={edit.editValue}
          onChange={(e) => edit.change(e.target.value)}
          {...handlers}
          rows={2}
          className="w-full bg-transparent text-xs text-foreground focus:outline-none resize-none"
        />
        <div className="mt-1 flex items-center gap-2">
          {edit.status === "saving" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted">
              <Loader2 size={11} className="animate-spin" />
              Saving…
            </span>
          )}
          <span className="ml-auto text-[10px] text-muted-faint">
            Click outside or press Esc to cancel
          </span>
        </div>
      </div>
    );
  }

  if (notes) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label="Edit notes"
        className="group mb-3 flex cursor-pointer items-start gap-2 rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] px-3 py-2 text-xs text-[color:var(--warning)]"
        onClick={() => edit.start("notes", notes)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            edit.start("notes", notes);
          }
        }}
      >
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[color:var(--warning)]" />
        <p className="flex-1 leading-relaxed">{notes}</p>
        <Pencil size={11} className="mt-0.5 shrink-0 text-[color:var(--warning)] opacity-50 transition group-hover:opacity-100" />
      </div>
    );
  }

  return (
    <button
      onClick={() => edit.start("notes", "")}
      className="mb-3 text-xs text-muted transition hover:text-accent"
    >
      + Add notes
    </button>
  );
}

function PropertyPill({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-[var(--bg-hover)] px-2.5 py-1.5 text-xs">
      <span className="text-muted">{icon}</span>
      <span className="text-muted">{label}:</span>
      <span className={`font-semibold text-foreground ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: "blue" | "green" | "red" | "amber";
}) {
  const colorMap = {
    blue: {
      bg: "bg-[color:var(--status-blue-bg)]",
      icon: "text-[color:var(--status-blue-dot)]",
      value: "text-[color:var(--status-blue-fg)]",
    },
    green: {
      bg: "bg-[color:var(--success-bg)]",
      icon: "text-[color:var(--success)]",
      value: "text-[color:var(--success)]",
    },
    red: {
      bg: "bg-[color:var(--danger-bg)]",
      icon: "text-[color:var(--danger)]",
      value: "text-[color:var(--danger)]",
    },
    amber: {
      bg: "bg-[color:var(--warning-bg)]",
      icon: "text-[color:var(--warning)]",
      value: "text-[color:var(--warning)]",
    },
  };
  const c = colorMap[color];

  return (
    <div className={`rounded-lg ${c.bg} px-3.5 py-2.5`}>
      <div className="flex items-center gap-1.5">
        <span className={c.icon}>{icon}</span>
        <span className="text-[11px] font-medium text-muted">{label}</span>
      </div>
      <p className={`mt-1 text-lg font-bold ${c.value}`}>{value}</p>
    </div>
  );
}
