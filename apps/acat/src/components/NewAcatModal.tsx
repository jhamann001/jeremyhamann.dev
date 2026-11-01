"use client";

import { useEffect, useState } from "react";
import {
  X,
  Loader2,
  Plus,
  ChevronDown,
  ChevronRight,
  User,
  CreditCard,
  CalendarDays,
  FileText,
  ClipboardList,
} from "lucide-react";
import { useEffectiveRole } from "@/lib/use-effective-role";
import {
  Custodian,
  AcatStatus,
  ACAT_STATUS_LABELS,
  ACAT_STATUS_PICKER_OPTIONS,
  TransferWorkflow,
  AcatRecord,
  TRANSFER_WORKFLOW_LABELS,
  TRANSFER_WORKFLOWS,
} from "@/lib/types";
import { ACCOUNT_TYPE_OPTIONS, ADVISOR_OPTIONS } from "@/lib/record-fields";
import { formatCentsExact, normalizeStatementAmountSign, parseMoneyToCents } from "@/lib/format";
import { DtccSuggestion } from "@/lib/dtcc-suggestion";
import { useToast } from "./Toast";
import ContraCombobox from "./ContraCombobox";
import MultiCheckSelect from "./MultiCheckSelect";
import {
  findPossibleAcatDuplicates,
  PossibleAcatDuplicate,
} from "@/lib/acat-duplicates";
import { defaultResidualFollowUpDate } from "@/lib/acat-operational-defaults";
import { CLIENT_IDENTITY_ERROR, ClientSearchItem } from "@/lib/client-identity-contract";
import { useClientIdentityStatus } from "@/hooks/use-client-identity-status";
import ClientIdentitySelection from "./ClientIdentitySelection";

interface NewAcatModalProps {
  onClose: () => void;
  onCreated: () => void;
  existingRecords?: AcatRecord[];
}

type SectionKey =
  | "core"
  | "accounts"
  | "dates"
  | "tickets"
  | "other";

const SECTION_META: Record<
  SectionKey,
  { label: string; icon: React.ReactNode }
> = {
  core: { label: "Core Info", icon: <User size={14} /> },
  accounts: {
    label: "Accounts & Transfer",
    icon: <CreditCard size={14} />,
  },
  dates: { label: "Dates", icon: <CalendarDays size={14} /> },
  tickets: {
    label: "Tickets & Resources",
    icon: <FileText size={14} />,
  },
  other: { label: "Notes & Other", icon: <ClipboardList size={14} /> },
};

// ticket item 4: new ACATs can only start in real lifecycle statuses; the
// retired recon-derived values (Matched / Mismatch / Pending) are filtered
// out of the picker.
const STATUS_OPTIONS: AcatStatus[] = ACAT_STATUS_PICKER_OPTIONS;

const DIRECTION_OPTIONS = ["In", "Out"];
const YES_NO_OPTIONS = ["", "Yes", "No"];
const TYPE_OPTIONS = ["", "Full", "Partial", "Residual Credit"];
const METHOD_OPTIONS = [
  "API",
  "Full Docusign",
  "Partial Docusign",
  "Non-ACAT Transfer (Manual)",
  "N/A",
];

export default function NewAcatModal({
  onClose,
  onCreated,
  existingRecords = [],
}: NewAcatModalProps) {
  const [custodians, setCustodians] = useState<Custodian[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<
    PossibleAcatDuplicate[]
  >([]);
  const { toast } = useToast();
  const { role } = useEffectiveRole();
  const canCreateContra = role === "ADMIN";
  const identity = useClientIdentityStatus();
  const [selectedClients, setSelectedClients] = useState<ClientSearchItem[]>([]);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const identityEnabled = identity.status?.enabled === true;

  const [openSections, setOpenSections] = useState<Set<SectionKey>>(
    new Set(["core", "accounts"])
  );

  // --- Core Info ---
  const [clientName, setClientName] = useState("");
  const [controlNumber, setControlNumber] = useState("");
  const [acatTransferId, setAcatTransferId] = useState("");
  const [direction, setDirection] = useState("");
  const [type, setType] = useState("");
  const [transferWorkflow, setTransferWorkflow] =
    useState<TransferWorkflow>("UNCLASSIFIED");
  const [accountType, setAccountType] = useState("");
  const [status, setStatus] = useState<AcatStatus>("AcatReceived");
  const [wealthAdvisor, setWealthAdvisor] = useState("");

  // --- Accounts & Transfer ---
  const [apexAccountId, setApexAccountId] = useState("");
  const [statementAccountNumber, setStatementAccountNumber] = useState("");
  const [transferringContra, setTransferringContra] = useState("");
  const [dtccNumber, setDtccNumber] = useState("");
  const [dtccManuallyEdited, setDtccManuallyEdited] = useState(false);
  const [dtccSuggestion, setDtccSuggestion] = useState<DtccSuggestion | null>(null);
  const [statementAmount, setStatementAmount] = useState("");
  const [methodRequested, setMethodRequested] = useState("");
  const [crwEe, setCrwEe] = useState("");

  // --- Dates ---
  const [originalClientRequestDate, setOriginalClientRequestDate] =
    useState("");
  const [opsSubmissionDateToApex, setOpsSubmissionDateToApex] = useState("");
  const [apexCompletionDate, setApexCompletionDate] = useState("");
  const [residualMonitoringRequired, setResidualMonitoringRequired] =
    useState(false);
  const [residualFollowUpDate, setResidualFollowUpDate] = useState("");
  const [followUpManuallyEdited, setFollowUpManuallyEdited] = useState(false);
  const [followUpBenchmarkLabel, setFollowUpBenchmarkLabel] = useState("");

  // --- Tickets & Resources ---
  const [crmTicket, setCrmTicket] = useState("");
  const [apexTicket, setApexTicket] = useState("");
  const [additionalResources, setAdditionalResources] = useState("");
  const [tradeRequestId, setTradeRequestId] = useState("");
  const [tradeRequestUrl, setTradeRequestUrl] = useState("");
  const [tradeInstructions, setTradeInstructions] = useState("");

  // --- Notes & Other ---
  const [notes, setNotes] = useState("");
  const [associatedControlNumber, setAssociatedControlNumber] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  useEffect(() => {
    fetch("/api/custodians")
      .then((r) => r.json())
      .then((data: Custodian[]) => setCustodians(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const contra = transferringContra.trim();
    if (!contra) return;
    let canceled = false;
    fetch(`/api/dtcc-suggestion?contra=${encodeURIComponent(contra)}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((suggestion: DtccSuggestion) => {
        if (canceled) return;
        setDtccSuggestion(suggestion);
        if (!dtccManuallyEdited && suggestion.status === "suggested" && suggestion.dtccNumber) {
          setDtccNumber(suggestion.dtccNumber);
        }
      })
      .catch(() => {
        if (!canceled) setDtccSuggestion(null);
      });
    return () => { canceled = true; };
  }, [dtccManuallyEdited, transferringContra]);

  useEffect(() => {
    if (
      !residualMonitoringRequired ||
      !apexCompletionDate ||
      followUpManuallyEdited
    ) return;
    let canceled = false;
    fetch(`/api/residual-benchmark?contra=${encodeURIComponent(transferringContra.trim())}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((benchmark: { days: number; sampleSize: number; source: "contra" | "global" | "fallback" }) => {
        if (canceled) return;
        const date = new Date(`${apexCompletionDate}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + benchmark.days);
        setResidualFollowUpDate(date.toISOString().slice(0, 10));
        setFollowUpBenchmarkLabel(
          benchmark.source === "contra"
            ? `${benchmark.days}-day contra P75 (n=${benchmark.sampleSize})`
            : benchmark.source === "global"
              ? `${benchmark.days}-day global P75 (contra sample is still small)`
              : `${benchmark.days}-day starting fallback (not enough history yet)`
        );
      })
      .catch(() => {
        if (!canceled) setFollowUpBenchmarkLabel("27-day starting fallback");
      });
    return () => { canceled = true; };
  }, [apexCompletionDate, followUpManuallyEdited, residualMonitoringRequired, transferringContra]);

  const handleCreateContra = async (name: string) => {
    try {
      const res = await fetch("/api/custodians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to add contra");
      }
      const created: Custodian = await res.json();
      setCustodians((prev) => {
        if (prev.some((c) => c.id === created.id)) return prev;
        return [...prev, created].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      });
      handleContraChange(created.name);
      toast("success", "Contra Added", `${created.name} is now in the list`);
    } catch (err) {
      toast(
        "error",
        "Failed to Add Contra",
        err instanceof Error ? err.message : "Unknown error"
      );
    }
  };

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pendingAccountAllowed = identityEnabled && selectedClients.length === 1 && identity.status?.pendingAccountPolicy === "PENDING_ACCOUNT_OPENING_ONLY" && status === "PendingAccountOpening";
  const missingRequired = [
    !identity.status ? "Client directory status" : null,
    identityEnabled ? (!selectedClients.length ? "Client selection" : null) : (!clientName.trim() ? "Client Name" : null),
    identityEnabled && !identity.status?.writeEligible ? "Client directory verification" : null,
    !direction ? "Direction" : null,
    transferWorkflow === "UNCLASSIFIED" ? "Transfer Workflow" : null,
    !apexAccountId.trim() && !pendingAccountAllowed ? "Apex Account #" : null,
    status === "Rejected" && !rejectionReason.trim() ? "Rejection Reason" : null,
  ].filter((value): value is string => value !== null);
  const isValid = missingRequired.length === 0;
  const coreIncomplete = missingRequired.some((field) =>
    ["Client Name", "Client selection", "Client directory status", "Client directory verification", "Direction", "Transfer Workflow"].includes(field)
  );
  const accountsIncomplete = missingRequired.includes("Apex Account #");
  const otherIncomplete = missingRequired.includes("Rejection Reason");

  const requestClose = () => {
    if (
      dirty &&
      !window.confirm("Discard this unfinished transfer? Your entries will be lost.")
    ) {
      return;
    }
    onClose();
  };

  const handleTypeChange = (nextType: string) => {
    setType(nextType);
    if (nextType === "Residual Credit") {
      setTransferWorkflow("RESIDUAL");
      setResidualMonitoringRequired(false);
    } else if (transferWorkflow === "RESIDUAL") {
      setTransferWorkflow("UNCLASSIFIED");
    }
    if (direction === "Out" && nextType !== "Residual Credit") {
      setResidualMonitoringRequired(true);
      if (!residualFollowUpDate) {
        setResidualFollowUpDate(defaultResidualFollowUpDate());
      }
      setFollowUpManuallyEdited(true);
      setFollowUpBenchmarkLabel("Defaulted to one week from today for ACAT Out");
    }
  };

  const handleWorkflowChange = (nextWorkflow: TransferWorkflow) => {
    setTransferWorkflow(nextWorkflow);
    if (nextWorkflow === "RESIDUAL") {
      handleTypeChange("Residual Credit");
    }
  };

  const handleContraChange = (value: string) => {
    setTransferringContra(value);
    setDtccNumber("");
    setDtccManuallyEdited(false);
    setDtccSuggestion(null);
  };

  const handleDirectionChange = (value: string) => {
    setDirection(value);
    const cents = parseMoneyToCents(statementAmount);
    if (cents != null) setStatementAmount(formatCentsExact(normalizeStatementAmountSign(cents, value)));
    if (value === "Out" && type !== "Residual Credit") {
      setResidualMonitoringRequired(true);
      if (!residualFollowUpDate) {
        setResidualFollowUpDate(defaultResidualFollowUpDate());
      }
      setFollowUpManuallyEdited(true);
      setFollowUpBenchmarkLabel("Defaulted to one week from today for ACAT Out");
    }
  };

  const handleCompletionDateChange = (value: string) => {
    setApexCompletionDate(value);
    setFollowUpManuallyEdited(false);
    if (value && residualMonitoringRequired && !residualFollowUpDate) {
      const date = new Date(`${value}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + 27);
      setResidualFollowUpDate(date.toISOString().slice(0, 10));
    }
  };

  const handleSubmit = async (skipDuplicateCheck = false) => {
    if (!isValid || submitting) return;
    setIdentityError(null);

    if (!skipDuplicateCheck) {
      const matches = findPossibleAcatDuplicates(existingRecords, {
        cedarRidgeUserIds: identityEnabled ? selectedClients.map((client) => client.cedarRidgeUserId) : undefined,
        clientName,
        apexAccountId,
        controlNumber,
        acatTransferId,
        statementAccountNumber,
        transferWorkflow,
        type,
      });
      if (matches.length > 0) {
        setDuplicateMatches(matches);
        return;
      }
    }

    let statementAmountCents: number | undefined;
    if (statementAmount.trim()) {
      const parsed = parseMoneyToCents(statementAmount);
      if (parsed == null) {
        toast(
          "error",
          "Invalid Statement Amount",
          `"${statementAmount}" isn't a valid dollar amount. Try e.g. $50,000 or 50000.00`
        );
        return;
      }
      statementAmountCents = normalizeStatementAmountSign(parsed, direction);
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/acats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(identityEnabled && selectedClients.length
            ? { cedarRidgeUserIds: selectedClients.map((client) => client.cedarRidgeUserId) }
            : { clientName: clientName.trim() }),
          controlNumber: controlNumber.trim() || undefined,
          acatTransferId: acatTransferId.trim() || undefined,
          direction: direction || undefined,
          type: type || undefined,
          accountType: accountType || undefined,
          status,
          wealthAdvisor: wealthAdvisor.trim() || undefined,
          apexAccountId: apexAccountId.trim(),
          statementAccountNumber:
            statementAccountNumber.trim() || undefined,
          transferringContra: transferringContra.trim() || undefined,
          dtccNumber: dtccNumber.trim() || undefined,
          statementAmount: statementAmountCents,
          methodRequested: methodRequested || undefined,
          transferWorkflow,
          crwEe: crwEe || undefined,
          originalClientRequestDate:
            originalClientRequestDate || undefined,
          opsSubmissionDateToApex:
            opsSubmissionDateToApex || undefined,
          apexCompletionDate: apexCompletionDate || undefined,
          residualMonitoringRequired,
          residualFollowUpDate:
            residualMonitoringRequired && residualFollowUpDate
              ? residualFollowUpDate
              : undefined,
          crmTicket: crmTicket.trim() || undefined,
          apexTicket: apexTicket.trim() || undefined,
          additionalResources: additionalResources.trim() || undefined,
          tradeRequestId: tradeRequestId.trim() || undefined,
          tradeRequestUrl: tradeRequestUrl.trim() || undefined,
          tradeInstructions: tradeInstructions.trim() || undefined,
          notes: notes.trim() || undefined,
          associatedControlNumber:
            type === "Residual Credit"
              ? associatedControlNumber.trim() || undefined
              : undefined,
          rejectionReason:
            status === "Rejected" ? rejectionReason.trim() || undefined : undefined,
          crmDealId: crmTicket.trim() || acatTransferId.trim() || "",
          acatDate:
            originalClientRequestDate ||
            new Date().toISOString().split("T")[0],
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (Object.values(CLIENT_IDENTITY_ERROR).includes(err.code)) {
          setIdentityError(err.error || "Check the selected client and receiving account.");
          if (err.code === CLIENT_IDENTITY_ERROR.IDENTITY_REQUIRED || err.code === CLIENT_IDENTITY_ERROR.DIRECTORY_STALE || err.code === CLIENT_IDENTITY_ERROR.DIRECTORY_UNAVAILABLE) void identity.refresh();
        }
        throw new Error(err.error ?? "Failed to create transfer record");
      }

      const created = await res.json().catch(() => null);
      toast("success", "Transfer Created", `${created?.clientName ?? clientName} added to tracker`);
      onCreated();
      onClose();
    } catch (err) {
      toast(
        "error",
        "Failed to Create Transfer",
        err instanceof Error ? err.message : "Unknown error"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--panel-backdrop)]">
      <div className="flex w-full max-w-2xl flex-col rounded-xl border border-card-border bg-[var(--bg-card)] shadow-xl animate-fade-in max-h-[90vh]">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-card-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Plus size={16} className="text-accent" />
            <h2 className="text-sm font-bold text-foreground">
              New Transfer Record
            </h2>
          </div>
          <button
            onClick={requestClose}
            aria-label="Close new transfer form"
            className="rounded-md p-1 text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable Form */}
        <div
          className="flex-1 overflow-y-auto px-6 py-4"
          onChangeCapture={() => setDirty(true)}
        >
          <div className="space-y-1">
            {/* ── Core Info ── */}
            <AccordionSection
              sectionKey="core"
              open={openSections.has("core")}
              onToggle={toggleSection}
              incomplete={coreIncomplete}
            >
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  label={identityEnabled ? "Clients" : "Client Name"}
                  required
                  className={type === "Residual Credit" ? "col-span-2" : undefined}
                >
                  {identityEnabled ? <ClientIdentitySelection
                    selected={selectedClients}
                    disabled={submitting}
                    onChange={(clients) => { setSelectedClients(clients); setClientName(clients.map((client) => client.displayName).join(" & ")); setDirty(true); setIdentityError(null); }}
                  /> : <input
                    type="text"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g. Sarah Jenkins"
                    className="form-input"
                    disabled={!identity.status || submitting}
                  />}
                  {(!identity.status || (identityEnabled && !identity.status.writeEligible)) && <div className="mt-2 text-xs text-muted"><p role="status">{identity.error || (identity.loading ? "Checking client directory…" : "Client directory verification is unavailable. Creation is paused.")}</p>{!identity.loading && <button type="button" className="mt-1 text-accent underline" onClick={() => void identity.refresh()}>Check directory again</button>}</div>}
                  {identityEnabled && selectedClients.length > 1 && <p className="mt-2 text-xs text-muted">All selected people must be verified joint holders of the same Apex account. An account number is required.</p>}
                  {identityError && <p role="alert" className="mt-2 text-xs text-[color:var(--danger)]">{identityError}</p>}
                </FormField>
                <FormField label="Control #">
                  <input
                    type="text"
                    value={controlNumber}
                    onChange={(e) => setControlNumber(e.target.value)}
                    placeholder="e.g. 12345"
                    className="form-input"
                  />
                </FormField>
                {type === "Residual Credit" && (
                  <FormField label="Associated Control #">
                    <input
                      type="text"
                      value={associatedControlNumber}
                      onChange={(e) =>
                        setAssociatedControlNumber(e.target.value)
                      }
                      placeholder="e.g. 67890"
                      className="form-input"
                    />
                  </FormField>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="ACAT Transfer ID">
                  <input
                    type="text"
                    value={acatTransferId}
                    onChange={(e) => setAcatTransferId(e.target.value)}
                    placeholder="e.g. TRN-9812"
                    className="form-input"
                  />
                </FormField>
                <FormField label="Direction" required>
                  <select
                    value={direction}
                    onChange={(e) => handleDirectionChange(e.target.value)}
                    className="form-input"
                  >
                    <option value="">Select direction...</option>
                    {DIRECTION_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Transfer Workflow" required>
                  <select
                    value={transferWorkflow}
                    onChange={(e) =>
                      handleWorkflowChange(e.target.value as TransferWorkflow)
                    }
                    disabled={type === "Residual Credit"}
                    className="form-input"
                  >
                    {TRANSFER_WORKFLOWS.map((workflow) => (
                      <option key={workflow} value={workflow}>
                        {TRANSFER_WORKFLOW_LABELS[workflow]}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Type">
                  <select
                    value={type}
                    onChange={(e) => handleTypeChange(e.target.value)}
                    className="form-input"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t || "Select type..."}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Account Type">
                  <select
                    value={accountType}
                    onChange={(e) => setAccountType(e.target.value)}
                    className="form-input"
                  >
                    <option value="">Select...</option>
                    {ACCOUNT_TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Status">
                  <select
                    value={status}
                    onChange={(e) => {
                      const nextStatus = e.target.value as AcatStatus;
                      setStatus(nextStatus);
                      if (nextStatus === "Rejected") {
                        setOpenSections((current) => new Set(current).add("other"));
                      }
                    }}
                    className="form-input"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {ACAT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
              <FormField label="Advisor">
                <select
                  value={wealthAdvisor}
                  onChange={(e) => setWealthAdvisor(e.target.value)}
                  className="form-input"
                >
                  <option value="">Select...</option>
                  {ADVISOR_OPTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </FormField>
            </AccordionSection>

            {/* ── Accounts & Transfer ── */}
            <AccordionSection
              sectionKey="accounts"
              open={openSections.has("accounts")}
              onToggle={toggleSection}
              incomplete={accountsIncomplete}
            >
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Apex Account #" required={!pendingAccountAllowed}>
                  <input
                    type="text"
                    value={apexAccountId}
                    onChange={(e) => setApexAccountId(e.target.value)}
                    placeholder="e.g. APX-1049201"
                    className="form-input"
                  />
                  {pendingAccountAllowed && <p className="mt-1 text-xs text-muted">Leave blank until the account opens. An account number is required before changing out of Pending Account Opening.</p>}
                </FormField>
                <FormField label="Statement Account #">
                  <input
                    type="text"
                    value={statementAccountNumber}
                    onChange={(e) =>
                      setStatementAccountNumber(e.target.value)
                    }
                    placeholder="e.g. 987654321"
                    className="form-input"
                  />
                </FormField>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Transferring Contra">
                  <ContraCombobox
                    value={transferringContra}
                    onChange={handleContraChange}
                    options={custodians.map((c) => ({
                      id: c.id,
                      name: c.name,
                    }))}
                    canCreate={canCreateContra}
                    onCreate={handleCreateContra}
                    placeholder="e.g. Charles Schwab"
                  />
                </FormField>
                <FormField label="DTCC #">
                  <input
                    type="text"
                    value={dtccNumber}
                    onChange={(e) => {
                      setDtccNumber(e.target.value);
                      setDtccManuallyEdited(true);
                    }}
                    placeholder="e.g. 0188"
                    className="form-input"
                  />
                  {dtccSuggestion?.status === "suggested" && dtccSuggestion.dtccNumber ? (
                    <p className="mt-1 text-[11px] text-[color:var(--success)]">
                      Suggested {dtccSuggestion.dtccNumber} from consistent {dtccSuggestion.source === "custodian" ? "custodian data" : `history (n=${dtccSuggestion.historicalSampleSize})`}.
                    </p>
                  ) : dtccSuggestion?.status === "ambiguous" ? (
                    <p className="mt-1 text-[11px] text-[color:var(--warning)]">Conflicting DTC history — left blank for human review.</p>
                  ) : dtccSuggestion?.status === "insufficient" ? (
                    <p className="mt-1 text-[11px] text-muted">Not enough consistent history to suggest a DTC number.</p>
                  ) : null}
                </FormField>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <FormField label="Statement Amount">
                  <input
                    type="text"
                    value={statementAmount}
                    onChange={(e) => setStatementAmount(e.target.value)}
                    onBlur={() => {
                      const cents = parseMoneyToCents(statementAmount);
                      if (cents != null) setStatementAmount(formatCentsExact(normalizeStatementAmountSign(cents, direction)));
                    }}
                    placeholder="e.g. $50,000.00"
                    className="form-input"
                  />
                </FormField>
                <FormField label="Request Method">
                  <MultiCheckSelect
                    value={methodRequested}
                    onChange={setMethodRequested}
                    options={METHOD_OPTIONS}
                    placeholder="Select..."
                    variant="form"
                  />
                </FormField>
                <FormField label="CRW EE?">
                  <select
                    value={crwEe}
                    onChange={(e) => setCrwEe(e.target.value)}
                    className="form-input"
                  >
                    {YES_NO_OPTIONS.map((v) => (
                      <option key={v} value={v}>
                        {v || "Select..."}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
              {direction === "Out" && type === "Full" && (
                <div className="rounded-lg border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-3 text-xs text-[color:var(--warning)]">
                  <p className="font-semibold">Outgoing ACAT fee check required</p>
                  <p className="mt-1 leading-5">
                    This record will default to Fee Charged = Yes and appear in Fee to Submit until the Apex charge and automatic reimbursement are documented.
                  </p>
                </div>
              )}
            </AccordionSection>

            {/* ── Dates ── */}
            <AccordionSection
              sectionKey="dates"
              open={openSections.has("dates")}
              onToggle={toggleSection}
            >
              <div className="grid grid-cols-3 gap-4">
                <FormField label="Original Client Request Date">
                  <input
                    type="date"
                    value={originalClientRequestDate}
                    onChange={(e) =>
                      setOriginalClientRequestDate(e.target.value)
                    }
                    className="form-input"
                  />
                </FormField>
                <FormField label="Ops Submission Date to Apex">
                  <input
                    type="date"
                    value={opsSubmissionDateToApex}
                    onChange={(e) =>
                      setOpsSubmissionDateToApex(e.target.value)
                    }
                    className="form-input"
                  />
                </FormField>
                <FormField label="Apex Completion Date">
                  <input
                    type="date"
                    value={apexCompletionDate}
                    onChange={(e) => handleCompletionDateChange(e.target.value)}
                    className="form-input"
                  />
                </FormField>
              </div>
              {((type === "Full" && direction === "In") ||
                (direction === "Out" && type !== "Residual Credit")) && (
                <div className="rounded-lg border border-card-border bg-[var(--bg-hover)] p-3">
                  <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <input
                      type="checkbox"
                      checked={residualMonitoringRequired}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setResidualMonitoringRequired(checked);
                        if (!checked) setResidualFollowUpDate("");
                        else if (!residualFollowUpDate) {
                          if (direction === "Out") {
                            setResidualFollowUpDate(defaultResidualFollowUpDate());
                            setFollowUpManuallyEdited(true);
                            setFollowUpBenchmarkLabel("Defaulted to one week from today for ACAT Out");
                          } else if (apexCompletionDate) {
                            const date = new Date(`${apexCompletionDate}T00:00:00Z`);
                            date.setUTCDate(date.getUTCDate() + 27);
                            setResidualFollowUpDate(date.toISOString().slice(0, 10));
                            setFollowUpBenchmarkLabel("27-day starting fallback");
                          }
                        }
                      }}
                    />
                    Monitor for a residual sweep
                  </label>
                  <p className="mt-1 text-xs text-muted">
                    ACAT Outs default to monitoring with a one-week review date. The date is a check-in, not a promise that a residual is owed.
                  </p>
                  {residualMonitoringRequired && (
                    <div className="mt-3 max-w-xs">
                      <FormField label="Residual Follow-Up Date">
                        <input
                          type="date"
                          value={residualFollowUpDate}
                          onChange={(e) => {
                            setResidualFollowUpDate(e.target.value);
                            setFollowUpManuallyEdited(true);
                            setFollowUpBenchmarkLabel("Manually adjusted");
                          }}
                          className="form-input"
                        />
                      </FormField>
                      {followUpBenchmarkLabel && (
                        <p className="mt-1 text-[11px] text-muted">{followUpBenchmarkLabel}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </AccordionSection>

            {/* ── Tickets & Resources ── */}
            <AccordionSection
              sectionKey="tickets"
              open={openSections.has("tickets")}
              onToggle={toggleSection}
            >
              <div className="grid grid-cols-2 gap-4">
                <FormField label="CRM Ticket">
                  <input
                    type="text"
                    value={crmTicket}
                    onChange={(e) => setCrmTicket(e.target.value)}
                    placeholder="e.g. OPP-9812"
                    className="form-input"
                  />
                </FormField>
                <FormField label="Apex Ticket">
                  <input
                    type="text"
                    value={apexTicket}
                    onChange={(e) => setApexTicket(e.target.value)}
                    placeholder="e.g. APX-TKT-001"
                    className="form-input"
                  />
                </FormField>
              </div>
              <FormField label="Additional Resources">
                <input
                  type="text"
                  value={additionalResources}
                  onChange={(e) =>
                    setAdditionalResources(e.target.value)
                  }
                  placeholder="Links, docs, etc."
                  className="form-input"
                />
              </FormField>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Trade Request ID">
                  <input
                    type="text"
                    value={tradeRequestId}
                    onChange={(e) => setTradeRequestId(e.target.value)}
                    placeholder="e.g. TRQ-12345"
                    className="form-input"
                  />
                </FormField>
                <FormField label="Trade Request Link">
                  <input
                    type="url"
                    value={tradeRequestUrl}
                    onChange={(e) => setTradeRequestUrl(e.target.value)}
                    placeholder="https://..."
                    className="form-input"
                  />
                </FormField>
              </div>
              <FormField label="Trade Instructions">
                <textarea
                  value={tradeInstructions}
                  onChange={(e) => setTradeInstructions(e.target.value)}
                  placeholder="e.g. Liquidate on receipt, hold in kind, or follow asset map"
                  rows={3}
                  className="form-input resize-none"
                />
                <p className="mt-1 text-[11px] text-muted">
                  Optional at save; missing instructions remain visible in the records queue.
                </p>
              </FormField>
            </AccordionSection>

            {/* ── Notes & Other ── */}
            <AccordionSection
              sectionKey="other"
              open={openSections.has("other")}
              onToggle={toggleSection}
              incomplete={otherIncomplete}
            >
              <FormField label="Notes">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional notes about this transfer..."
                  rows={3}
                  className="form-input resize-none"
                />
              </FormField>
              {status === "Rejected" && (
                <FormField label="Rejection Reason" required>
                  <input
                    type="text"
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    placeholder="Why was this transfer rejected?"
                    className="form-input"
                  />
                </FormField>
              )}
            </AccordionSection>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-card-border px-6 py-4">
          <p className={`text-xs ${missingRequired.length > 0 ? "text-[color:var(--warning)]" : "text-[color:var(--success)]"}`}>
            {missingRequired.length > 0
              ? `Still needed: ${missingRequired.join(", ")}`
              : "All required fields are complete"}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={requestClose}
              className="rounded-lg border border-card-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-[var(--bg-hover)]"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSubmit()}
              disabled={!isValid || submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-5 py-2 text-sm font-semibold text-[var(--invert-text)] shadow-sm transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              {submitting ? "Creating..." : "Create Transfer"}
            </button>
          </div>
        </div>
      </div>

      {duplicateMatches.length > 0 && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--panel-backdrop)] px-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="duplicate-warning-title"
            className="w-full max-w-lg rounded-xl border border-[color:var(--warning-border)] bg-[var(--bg-card)] shadow-2xl"
          >
            <div className="border-b border-card-border px-5 py-4">
              <h2 id="duplicate-warning-title" className="text-sm font-bold text-foreground">
                Possible duplicate transfer
              </h2>
              <p className="mt-1 text-xs text-muted">
                Nothing has been created yet. Review the matching record before continuing.
              </p>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto p-4">
              {duplicateMatches.map(({ record, reasons }) => (
                <div key={record.id} className="rounded-lg border border-card-border bg-[var(--bg-hover)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{record.clientName}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {record.apexAccountId} · {record.status}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-muted">{record.id}</span>
                  </div>
                  <p className="mt-2 text-xs text-[color:var(--warning)]">
                    {reasons.join(" · ")}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-card-border px-5 py-4">
              <button
                type="button"
                onClick={() => setDuplicateMatches([])}
                className="rounded-lg border border-card-border px-4 py-2 text-sm font-medium text-foreground hover:bg-[var(--bg-hover)]"
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => {
                  setDuplicateMatches([]);
                  void handleSubmit(true);
                }}
                className="rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)]"
              >
                Create Anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccordionSection({
  sectionKey,
  open,
  onToggle,
  incomplete = false,
  children,
}: {
  sectionKey: SectionKey;
  open: boolean;
  onToggle: (key: SectionKey) => void;
  incomplete?: boolean;
  children: React.ReactNode;
}) {
  const meta = SECTION_META[sectionKey];
  return (
    <div className="rounded-lg border border-card-border bg-[var(--bg-card)]">
      <button
        type="button"
        onClick={() => onToggle(sectionKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-[var(--bg-hover)]"
      >
        <span className="text-accent">{meta.icon}</span>
        {meta.label}
        {incomplete && (
          <span className="rounded-full bg-[color:var(--warning-bg)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--warning)]">
            Required field missing
          </span>
        )}
        <span className="ml-auto text-muted">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-card-border px-4 pb-4 pt-3">
          {children}
        </div>
      )}
    </div>
  );
}

function FormField({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label className="mb-1.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
        {required && <span className="text-[color:var(--danger)]">*</span>}
      </label>
      {children}
    </div>
  );
}
