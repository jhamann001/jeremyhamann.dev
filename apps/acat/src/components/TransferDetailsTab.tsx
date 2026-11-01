"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffectiveRole } from "@/lib/use-effective-role";
import {
  AcatRecord,
  Custodian,
  parseMethodRequested,
  TRANSFER_WORKFLOW_LABELS,
  TRANSFER_WORKFLOWS,
} from "@/lib/types";
import { ACCOUNT_TYPE_OPTIONS, ADVISOR_OPTIONS } from "@/lib/record-fields";
import {
  formatCentsExact,
  formatDateMMDDYYYY,
  maskAccountNumber,
  normalizeStatementAmountSign,
  parseMoneyToCents,
} from "@/lib/format";
import { DtccSuggestion } from "@/lib/dtcc-suggestion";
import { useInlineEdit } from "@/hooks/use-inline-edit";
import { useToast } from "./Toast";
import InlineField, { InlineFieldType } from "./InlineField";
import ManualTransferFormRecommendationCard from "./ManualTransferFormRecommendationCard";
import TransferDocumentHistory from "./TransferDocumentHistory";
import { DataQualityFocus } from "@/lib/data-quality-focus";

interface TransferDetailsTabProps {
  acat: AcatRecord;
  onMutate?: () => void;
  focus?: DataQualityFocus;
}

type FieldDef = {
  key: keyof AcatRecord;
  label: string;
  editable?: boolean;
  type?: InlineFieldType;
  options?: string[];
  format?: (v: string) => string;
};

const CORE_FIELDS: FieldDef[] = [
  { key: "controlNumber", label: "Control #", editable: true },
  { key: "associatedControlNumber", label: "Associated Control #", editable: true },
  { key: "acatTransferId", label: "ACAT Transfer ID", editable: true },
  { key: "transferWorkflow", label: "Transfer Workflow", editable: true, type: "select", options: TRANSFER_WORKFLOWS },
  { key: "direction", label: "Direction", editable: true, type: "select", options: ["In", "Out"] },
  { key: "type", label: "Type", editable: true, type: "select", options: ["Full", "Partial", "Residual Credit"] },
  { key: "accountType", label: "Account Type", editable: true, type: "select", options: ACCOUNT_TYPE_OPTIONS },
  { key: "methodRequested", label: "Request Method", editable: true, type: "multiselect", options: ["API", "Full Docusign", "Partial Docusign", "Non-ACAT Transfer (Manual)", "N/A"] },
  { key: "wealthAdvisor", label: "Advisor", editable: true, type: "select", options: ADVISOR_OPTIONS },
  { key: "crwEe", label: "CRW EE?", editable: true, type: "select", options: ["Yes", "No"] },
];

const ACCOUNT_FIELDS: FieldDef[] = [
  { key: "apexAccountId", label: "Apex Account #", editable: true },
  { key: "statementAccountNumber", label: "Statement Account #", editable: true, format: maskAccountNumber },
  { key: "transferringContra", label: "Transferring Contra", editable: true, type: "contra" },
  { key: "dtccNumber", label: "DTCC #", editable: true },
  { key: "statementAmount", label: "Statement Amount", editable: true },
];

// ticket: dropped the standalone "Completed Date" field. The only
// completion date we surface is the one Apex reports
// (`apexCompletionDate`).
const DATE_FIELDS: FieldDef[] = [
  { key: "originalClientRequestDate", label: "Original Client Request Date", editable: true, type: "date", format: formatDateMMDDYYYY },
  { key: "opsSubmissionDateToApex", label: "Ops Submission Date to Apex", editable: true, type: "date", format: formatDateMMDDYYYY },
  { key: "apexCompletionDate", label: "Apex Completion Date", editable: true, type: "date", format: formatDateMMDDYYYY },
  { key: "residualMonitoringRequired", label: "Monitor for Residual", editable: true, type: "select", options: ["true", "false"], format: (v) => v === "true" ? "Yes" : "No" },
  { key: "residualFollowUpDate", label: "Residual Follow-Up Date", editable: true, type: "date", format: formatDateMMDDYYYY },
];

const TICKET_FIELDS: FieldDef[] = [
  { key: "crmTicket", label: "CRM Ticket", editable: true },
  { key: "crmDealId", label: "CRM Deal ID", editable: true },
  { key: "apexTicket", label: "Apex Ticket", editable: true },
  { key: "additionalResources", label: "Additional Resources", editable: true },
];

const TRADE_REQUEST_FIELDS: FieldDef[] = [
  { key: "tradeInstructions", label: "Trade Instructions", editable: true, type: "textarea" },
  { key: "tradeRequestId", label: "Trade Request ID", editable: true },
  { key: "tradeRequestUrl", label: "Trade Request Link", editable: true },
];

const PROCESSING_FIELD_KEYS = new Set<keyof AcatRecord>([
  ...DATE_FIELDS.map((field) => field.key),
  ...TICKET_FIELDS.map((field) => field.key),
  ...TRADE_REQUEST_FIELDS.map((field) => field.key),
  "rejectionReason",
]);

const isUrl = (v: string) => /^https?:\/\//i.test(v);

export default function TransferDetailsTab({ acat, onMutate, focus }: TransferDetailsTabProps) {
  const { toast } = useToast();
  const { role } = useEffectiveRole();
  const canCreateContra = role === "ADMIN";
  const [dtccSuggestion, setDtccSuggestion] = useState<DtccSuggestion | null>(null);
  const [applyingDtcc, setApplyingDtcc] = useState(false);
  const [processingOpen, setProcessingOpen] = useState(
    () => focus?.tab === "details" && PROCESSING_FIELD_KEYS.has(focus.field)
  );
  const focusedOnceRef = useRef("");
  const identityVersionAtEdit = useRef(acat.identityVersion);
  const visibleDtccSuggestion = acat.transferringContra?.trim()
    ? dtccSuggestion
    : null;

  useEffect(() => {
    if (!acat.transferringContra?.trim()) return;
    let canceled = false;
    fetch(`/api/dtcc-suggestion?contra=${encodeURIComponent(acat.transferringContra.trim())}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((value: DtccSuggestion) => { if (!canceled) setDtccSuggestion(value); })
      .catch(() => { if (!canceled) setDtccSuggestion(null); });
    return () => { canceled = true; };
  }, [acat.transferringContra]);

  // SWR-backed custodian list. Revalidates on focus/reconnect so another
  // user's newly-added contra shows up in the combobox without a page reload.
  const { data: custodiansData, mutate: mutateCustodians } = useSWR<Custodian[]>(
    "/api/custodians"
  );
  const custodians: Custodian[] = custodiansData ?? [];

  // Centralized inline-edit state for every field in this tab. Per-field
  // success toasts intentionally aren't fired anymore — InlineField shows
  // an inline "Saved" pill, and toasts are reserved for failures (and for
  // the contra-create flow below which fires its own success toast).
  const inlineEdit = useInlineEdit({
    onSave: async (field, value) => {
      try {
        // Empty string → explicit null so the PATCH handler actually clears
        // the column. `value || undefined` would collapse "" to undefined,
        // which the handler treats as "no change" and silently drops.
        // Apex account is nonnullable; an empty string lets the server apply
        // the PendingAccountOpening-only exception.
        let patchValue: string | number | boolean | null = value === "" && field !== "apexAccountId" ? null : value;
        if (field === "residualMonitoringRequired") {
          patchValue = value === "true";
        }
        if (field === "statementAmount" && value !== "") {
          const cents = parseMoneyToCents(value);
          if (cents == null) {
            toast(
              "error",
              "Invalid Statement Amount",
              `"${value}" isn't a valid dollar amount`
            );
            return false;
          }
          patchValue = normalizeStatementAmountSign(cents, acat.direction);
        }
        const res = await fetch(`/api/acats/${acat.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: patchValue, ...(["apexAccountId", "acatTransferId"].includes(field) && identityVersionAtEdit.current != null ? { expectedIdentityVersion: identityVersionAtEdit.current } : {}) }),
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
  });
  const startInlineEdit = inlineEdit.start;
  const startEdit = useCallback((field: string, value: string) => {
    identityVersionAtEdit.current = acat.identityVersion;
    startInlineEdit(field, value);
  }, [acat.identityVersion, startInlineEdit]);
  const edit = { ...inlineEdit, start: startEdit };

  useEffect(() => {
    if (!focus || focus.tab !== "details") return;
    const focusKey = `${focus.ruleKey}:${String(focus.field)}`;
    if (focusedOnceRef.current === focusKey) return;
    focusedOnceRef.current = focusKey;

    const raw = acat[focus.field];
    const value =
      focus.field === "statementAmount" && typeof raw === "number"
        ? formatCentsExact(raw)
        : focus.field === "transferWorkflow" && raw == null
          ? "UNCLASSIFIED"
          : raw != null
            ? String(raw)
            : "";
    startEdit(String(focus.field), value);
  }, [acat, startEdit, focus]);

  const applyDtccSuggestion = useCallback(async () => {
    if (!visibleDtccSuggestion?.dtccNumber || applyingDtcc) return;
    setApplyingDtcc(true);
    try {
      const response = await fetch(`/api/acats/${acat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dtccNumber: visibleDtccSuggestion.dtccNumber }),
      });
      if (!response.ok) throw new Error("Update failed");
      onMutate?.();
    } catch {
      toast("error", "Update Failed", "Could not apply the DTC suggestion");
    } finally {
      setApplyingDtcc(false);
    }
  }, [acat.id, applyingDtcc, onMutate, toast, visibleDtccSuggestion]);

  const handleCreateContra = useCallback(
    async (name: string) => {
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
        // Optimistically merge the created custodian into the SWR cache so
        // the combobox updates immediately; SWR will revalidate in the
        // background to reconcile with the server.
        await mutateCustodians(
          (prev) => {
            const list = prev ?? [];
            if (list.some((c) => c.id === created.id)) return list;
            return [...list, created].sort((a, b) => a.name.localeCompare(b.name));
          },
          { revalidate: true }
        );
        edit.change(created.name);
        toast("success", "Contra Added", `${created.name} is now in the list`);
      } catch (err) {
        toast(
          "error",
          "Failed to Add Contra",
          err instanceof Error ? err.message : "Unknown error"
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutateCustodians, toast]
  );

  const renderField = (field: FieldDef) => {
    const raw = acat[field.key];
    const value =
      field.key === "statementAmount"
        ? typeof raw === "number"
          ? formatCentsExact(raw)
          : ""
        : field.key === "transferWorkflow"
          ? raw != null
            ? String(raw)
            : "UNCLASSIFIED"
          : raw != null
            ? String(raw)
            : "";

    return (
      <div
        key={field.key}
        data-quality-target={focus?.field === field.key ? "true" : undefined}
        className={`flex min-h-11 flex-col items-start gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 ${
          focus?.field === field.key
            ? "bg-[color:var(--warning-bg)] ring-2 ring-inset ring-[color:var(--warning-border)]"
            : ""
        }`}
      >
        <span className="w-full shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted sm:w-44">
          {field.label}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <InlineField
            field={String(field.key)}
            value={value}
            edit={edit}
            type={field.type ?? "text"}
            options={field.options}
            allowEmpty={field.key !== "transferWorkflow"}
            contraOptions={field.type === "contra" ? custodians.map((c) => ({ id: c.id, name: c.name })) : undefined}
            canCreateContra={field.type === "contra" && canCreateContra}
            onCreateContra={field.type === "contra" ? handleCreateContra : undefined}
            editable={field.editable !== false}
            variant="block"
            placeholder="—"
            className="flex-1"
            ariaLabel={`Edit ${field.label}`}
            renderValue={(v) =>
              v ? (
                field.type === "multiselect" ? (
                  <div className="flex flex-wrap gap-1.5">
                    {parseMethodRequested(v).map((method) => (
                      <span key={method} className="inline-flex items-center rounded-full border border-card-border bg-[var(--bg-hover)] px-2 py-0.5 text-[11px] font-medium text-foreground">
                        {method}
                      </span>
                    ))}
                  </div>
                ) : isUrl(v) ? (
                  <a href={v} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="break-all text-sm font-medium text-accent underline">
                    {v}
                  </a>
                ) : (
                  <span className="break-words text-sm font-medium text-foreground">
                    {field.key === "transferWorkflow"
                      ? TRANSFER_WORKFLOW_LABELS[v as keyof typeof TRANSFER_WORKFLOW_LABELS] ?? v
                      : field.format ? field.format(v) : v}
                  </span>
                )
              ) : (
                <span className="text-sm italic text-muted-faint">—</span>
              )
            }
          />
        </div>
        {field.key === "dtccNumber" && !value && visibleDtccSuggestion?.status === "suggested" && visibleDtccSuggestion.dtccNumber ? (
          <button type="button" disabled={applyingDtcc} onClick={applyDtccSuggestion} className="shrink-0 rounded-lg border border-card-border px-2.5 py-1.5 text-xs font-semibold text-accent disabled:opacity-50">
            Use {visibleDtccSuggestion.dtccNumber}
          </button>
        ) : field.key === "dtccNumber" && !value && visibleDtccSuggestion?.status === "ambiguous" ? (
          <span className="max-w-48 text-right text-[11px] text-[color:var(--warning)]">Conflicting history — review</span>
        ) : null}
      </div>
    );
  };

  const processingSections = [
    { title: "Dates & Monitoring", fields: DATE_FIELDS },
    {
      title: "Tickets & Resources",
      fields: acat.status === "Rejected"
        ? [...TICKET_FIELDS, { key: "rejectionReason", label: "Rejection Reason", editable: true } satisfies FieldDef]
        : TICKET_FIELDS,
    },
    { title: "Trade Instructions", fields: TRADE_REQUEST_FIELDS },
  ];

  return (
    <div className="space-y-4">
      {focus?.tab === "details" && (
        <div className="rounded-xl border border-[color:var(--warning-border)] bg-[color:var(--warning-bg)] p-4 text-sm text-[color:var(--warning)]">
          <p className="font-semibold">Fixing: {focus.title}</p>
          <p className="mt-1 text-xs leading-5">{focus.detail} The highlighted {focus.fieldLabel} field is ready to edit.</p>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-card-border bg-[var(--bg-card)]">
        <div className="border-b border-card-border px-5 py-3">
          <h3 className="text-sm font-semibold text-foreground">Transfer &amp; Account Details</h3>
          <p className="mt-0.5 text-xs text-muted">Key transfer and account facts stay open for quick reference.</p>
        </div>
        <div className="grid divide-y divide-card-border xl:grid-cols-2 xl:divide-x xl:divide-y-0">
          {[
            { title: "Transfer", fields: CORE_FIELDS },
            { title: "Accounts", fields: ACCOUNT_FIELDS },
          ].map((section) => (
            <section key={section.title} className="min-w-0">
              <h4 className="border-b border-card-border bg-[var(--bg-hover)] px-4 py-2 text-xs font-semibold text-foreground">
                {section.title}
              </h4>
              <div className="divide-y divide-card-border">{section.fields.map(renderField)}</div>
            </section>
          ))}
        </div>
      </div>

      <TransferDocumentHistory key={acat.id} acatId={acat.id} />
      <div className="overflow-hidden rounded-xl border border-card-border bg-[var(--bg-card)]">
        <button
          type="button"
          aria-expanded={processingOpen}
          onClick={() => setProcessingOpen((open) => !open)}
          className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-[var(--bg-hover)]"
        >
          {processingOpen ? <ChevronDown size={15} className="text-muted" /> : <ChevronRight size={15} className="text-muted" />}
          <span>
            <span className="block text-sm font-semibold text-foreground">Processing & Instructions</span>
            <span className="mt-0.5 block text-xs font-normal text-muted">Dates, monitoring, tickets, paperwork, and trade direction</span>
          </span>
        </button>
        {processingOpen && (
          <div className="space-y-4 border-t border-card-border p-4">
            <ManualTransferFormRecommendationCard key={acat.id} acatId={acat.id} />
            <div className="grid gap-4 xl:grid-cols-2">
              {processingSections.map((section) => (
                <section key={section.title} className="overflow-hidden rounded-lg border border-card-border">
                  <h4 className="bg-[var(--bg-hover)] px-4 py-2 text-xs font-semibold text-foreground">{section.title}</h4>
                  <div className="divide-y divide-card-border">{section.fields.map(renderField)}</div>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
