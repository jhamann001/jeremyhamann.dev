"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createAcatBookRecord,
  listAcatContras,
  searchAcatBookClients,
} from "@/app/(authenticated)/acat-tracking/book-actions";
import type { AcatBookRow } from "@/lib/data/acat-book";
import type { AcatBookWriteResult } from "@/lib/data/acat-book-edit";
import {
  ACCOUNT_TYPE_OPTIONS,
  ADVISOR_OPTIONS,
  confirmClose,
  DIRECTION_OPTIONS,
  DIRECTORY_PAUSE,
  DISCARD_COPY,
  emptyCreateDraft,
  FEE_NOTICE_BODY,
  FEE_NOTICE_TITLE,
  feeNoticeShown,
  filterContras,
  followUpOneWeek,
  JOINT_COPY,
  METHOD_OPTIONS,
  missingRequired,
  parseStatementCents,
  residualControlShown,
  sectionIncomplete,
  STATUS_OPTIONS,
  suggestDtcc,
  TYPE_OPTIONS,
  WORKFLOW_OPTIONS,
  YES_NO_OPTIONS,
  type AcatCreateDraft,
  type AcatCreateSection,
  type AcatDirectoryStatus,
} from "@/lib/data/acat-create-contract";
import { AcatClientSearch } from "./AcatClientSearch";
import styles from "./AcatNewTransferDialog.module.css";

const SECTION_LABELS: Record<AcatCreateSection, string> = {
  core: "Core Info",
  accounts: "Accounts & Transfer",
  dates: "Dates",
  tickets: "Tickets & Resources",
  other: "Notes & Other",
};

/** Submits a draft; returns the reason to show, or null after a successful create. */
export async function submitCreate(
  draft: AcatCreateDraft,
  directory: AcatDirectoryStatus | null,
  create: (draft: AcatCreateDraft, directory: AcatDirectoryStatus | null) => Promise<AcatBookWriteResult>,
  onCreated: (row: AcatBookRow) => void,
): Promise<string | null> {
  if (draft.statementAmount.trim() !== "" && parseStatementCents(draft.statementAmount) === null) {
    return "Invalid Statement Amount";
  }
  const result = await create(draft, directory);
  if (!result.ok) return result.reason;
  onCreated(result.row);
  return null;
}

// `group` renders a div: a label would forward clicks on its text to the first
// button or checkbox inside it.
function Field({ label, required, wide, group, children }: {
  label: string; required?: boolean; wide?: boolean; group?: boolean; children: ReactNode;
}) {
  const className = wide ? `${styles.field} ${styles.wide}` : styles.field;
  const head = (
    <span className={styles.label}>
      {label}
      {required && <span className={styles.required} aria-hidden="true">*</span>}
    </span>
  );
  return group
    ? <div className={className} role="group" aria-label={label}>{head}{children}</div>
    : <label className={className}>{head}{children}</label>;
}

function Section({ id, open, incomplete, onToggle, children }: {
  id: AcatCreateSection; open: boolean; incomplete: boolean; onToggle: (id: AcatCreateSection) => void; children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <button type="button" className={styles.sectionHead} aria-expanded={open} onClick={() => onToggle(id)}>
        <span>{SECTION_LABELS[id]}</span>
        {incomplete && <span className={styles.badge}>Required field missing</span>}
        <span className={styles.chevron} aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </section>
  );
}

export function AcatNewTransferDialog({ onClose, onCreated, initialDraft, initialDirectory = null }: {
  onClose: () => void;
  onCreated: (row: AcatBookRow) => void;
  initialDraft?: AcatCreateDraft;
  initialDirectory?: AcatDirectoryStatus | null;
}) {
  const [draft, setDraft] = useState<AcatCreateDraft>(() => initialDraft ?? emptyCreateDraft());
  const [directory, setDirectory] = useState<AcatDirectoryStatus | null>(initialDirectory);
  const [checking, setChecking] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [open, setOpen] = useState<Set<AcatCreateSection>>(() => new Set(["core", "accounts"]));
  const [dirty, setDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [contras, setContras] = useState<{ name: string; dtcNumber: string | null }[]>([]);
  const [contraOpen, setContraOpen] = useState(false);
  const [dtccManual, setDtccManual] = useState(false);

  useEffect(() => {
    let live = true;
    listAcatContras()
      .then((result) => { if (live && result.ok) setContras(result.contras); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const missing = missingRequired(draft, directory);
  const incomplete = sectionIncomplete(missing);
  const contraMatches = useMemo(
    () => filterContras(contras.map((c) => c.name), draft.transferringContra).slice(0, 8),
    [contras, draft.transferringContra],
  );

  function update(patch: Partial<AcatCreateDraft>) {
    setDirty(true);
    setDraft((d) => {
      const next = { ...d, ...patch };
      if (patch.type === "Residual Credit") next.transferWorkflow = "RESIDUAL";
      if ((patch.direction !== undefined || patch.type !== undefined)
        && next.direction === "Out" && next.type !== "Residual Credit") {
        next.residualMonitoringRequired = true;
        if (next.residualFollowUpDate === "") next.residualFollowUpDate = followUpOneWeek(new Date());
      }
      if (patch.transferringContra !== undefined && !dtccManual) {
        next.dtccNumber = suggestDtcc(contras, next.transferringContra, false) ?? "";
      }
      return next;
    });
  }

  function toggle(id: AcatCreateSection) {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function requestClose() {
    const accepted = dirty ? window.confirm(DISCARD_COPY) : false;
    if (confirmClose(dirty, accepted) === "close") onClose();
  }

  async function checkDirectory() {
    if (lastQuery.trim().length < 2) return;
    setChecking(true);
    const result = await searchAcatBookClients(lastQuery);
    setChecking(false);
    if (result.ok) setDirectory(result.directory);
    else setReason(result.reason);
  }

  async function submit() {
    setSubmitting(true);
    const next = await submitCreate(draft, directory, createAcatBookRecord, onCreated);
    setSubmitting(false);
    setReason(next);
  }

  const selectInput = (value: string, options: readonly string[], onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select...</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  const text = (key: keyof AcatCreateDraft, placeholder?: string) => (
    <input type="text" value={draft[key] as string} placeholder={placeholder}
      onChange={(e) => update({ [key]: e.target.value } as Partial<AcatCreateDraft>)} />
  );
  const date = (key: keyof AcatCreateDraft) => (
    <input type="date" value={draft[key] as string}
      onChange={(e) => update({ [key]: e.target.value } as Partial<AcatCreateDraft>)} />
  );
  const pendingAllowed = draft.selected.length === 1
    && directory?.pendingAccountPolicy === "PENDING_ACCOUNT_OPENING_ONLY"
    && draft.status === "PendingAccountOpening";

  return (
    <div className={styles.backdrop}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="acat-new-transfer-title">
        <header className={styles.head}>
          <h2 id="acat-new-transfer-title">New Transfer Record</h2>
          <button type="button" className={styles.close} aria-label="Close new transfer form" onClick={requestClose}>×</button>
        </header>

        <div className={styles.body}>
          <Section id="core" open={open.has("core")} incomplete={incomplete.has("core")} onToggle={toggle}>
            <Field label="Clients" required wide group>
              <AcatClientSearch
                selected={draft.selected}
                onChange={(selected) => update({ selected })}
                onDirectory={(d, query) => { setDirectory(d); setLastQuery(query); }}
              />
              {directory && !directory.writeEligible && (
                <span className={styles.notice} role="status">
                  {DIRECTORY_PAUSE}{" "}
                  <button type="button" className={styles.linkButton} disabled={checking} onClick={() => void checkDirectory()}>
                    Check directory again
                  </button>
                </span>
              )}
              {draft.selected.length > 1 && <span className={styles.hint}>{JOINT_COPY}</span>}
            </Field>
            <Field label="Control #">{text("controlNumber", "e.g. 12345")}</Field>
            {draft.type === "Residual Credit" && (
              <Field label="Associated Control #">{text("associatedControlNumber")}</Field>
            )}
            <Field label="ACAT Transfer ID">{text("acatTransferId")}</Field>
            <Field label="Direction" required>
              {selectInput(draft.direction, DIRECTION_OPTIONS, (direction) => update({ direction }))}
            </Field>
            <Field label="Transfer Workflow" required>
              <select value={draft.transferWorkflow} disabled={draft.type === "Residual Credit"}
                onChange={(e) => update({ transferWorkflow: e.target.value })}>
                {WORKFLOW_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Type">{selectInput(draft.type, TYPE_OPTIONS, (type) => update({ type }))}</Field>
            <Field label="Account Type">
              {selectInput(draft.accountType, ACCOUNT_TYPE_OPTIONS, (accountType) => update({ accountType }))}
            </Field>
            <Field label="Status">
              <select value={draft.status} onChange={(e) => {
                const status = e.target.value;
                update({ status });
                if (status === "Rejected") setOpen((s) => new Set(s).add("other"));
              }}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Advisor">
              {selectInput(draft.wealthAdvisor, ADVISOR_OPTIONS, (wealthAdvisor) => update({ wealthAdvisor }))}
            </Field>
          </Section>

          <Section id="accounts" open={open.has("accounts")} incomplete={incomplete.has("accounts")} onToggle={toggle}>
            <Field label="Apex Account #" required={!pendingAllowed}>{text("apexAccountId")}</Field>
            <Field label="Statement Account #">{text("statementAccountNumber")}</Field>
            <Field label="Transferring Contra">
              <span className={styles.comboWrap}>
                <input type="text" value={draft.transferringContra} autoComplete="off"
                  onFocus={() => setContraOpen(true)}
                  onBlur={() => setContraOpen(false)}
                  onChange={(e) => { update({ transferringContra: e.target.value }); setContraOpen(true); }} />
                {contraOpen && contraMatches.length > 0 && (
                  <span className={styles.results} role="listbox">
                    {contraMatches.map((name) => (
                      <span key={name} role="option" aria-selected={false} className={styles.result}
                        onMouseDown={(e) => { e.preventDefault(); update({ transferringContra: name }); setContraOpen(false); }}>
                        {name}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </Field>
            <Field label="DTCC #">
              <input type="text" value={draft.dtccNumber}
                onChange={(e) => { setDtccManual(true); update({ dtccNumber: e.target.value }); }} />
            </Field>
            <Field label="Statement Amount">{text("statementAmount", "e.g. $50,000.00")}</Field>
            <Field label="Request Method" group>
              <span className={styles.checks}>
                {METHOD_OPTIONS.map((m) => (
                  <label key={m} className={styles.check}>
                    <input type="checkbox" checked={draft.methodRequested.includes(m)}
                      onChange={(e) => update({
                        methodRequested: e.target.checked
                          ? [...draft.methodRequested, m]
                          : draft.methodRequested.filter((x) => x !== m),
                      })} />
                    {m}
                  </label>
                ))}
              </span>
            </Field>
            <Field label="CRW EE?">{selectInput(draft.crwEe, YES_NO_OPTIONS, (crwEe) => update({ crwEe }))}</Field>
            {feeNoticeShown(draft) && (
              <div className={`${styles.notice} ${styles.wide}`}>
                <strong>{FEE_NOTICE_TITLE}</strong>
                <span>{FEE_NOTICE_BODY}</span>
              </div>
            )}
          </Section>

          <Section id="dates" open={open.has("dates")} incomplete={false} onToggle={toggle}>
            <Field label="Original Client Request Date">{date("originalClientRequestDate")}</Field>
            <Field label="Ops Submission Date to Apex">{date("opsSubmissionDateToApex")}</Field>
            <Field label="Apex Completion Date">{date("apexCompletionDate")}</Field>
            {residualControlShown(draft) && (
              <div className={`${styles.residual} ${styles.wide}`}>
                <label className={styles.check}>
                  <input type="checkbox" checked={draft.residualMonitoringRequired}
                    onChange={(e) => {
                      const on = e.target.checked;
                      update({
                        residualMonitoringRequired: on,
                        residualFollowUpDate: !on ? "" : (draft.residualFollowUpDate
                          || (draft.direction === "Out" ? followUpOneWeek(new Date()) : "")),
                      });
                    }} />
                  Monitor for a residual sweep
                </label>
                <span className={styles.hint}>
                  ACAT Outs default to monitoring with a one-week review date. The date is a check-in, not a promise that a residual is owed.
                </span>
                {draft.residualMonitoringRequired && (
                  <Field label="Residual Follow-Up Date">{date("residualFollowUpDate")}</Field>
                )}
              </div>
            )}
          </Section>

          <Section id="tickets" open={open.has("tickets")} incomplete={false} onToggle={toggle}>
            <Field label="CRM Ticket">{text("crmTicket")}</Field>
            <Field label="Apex Ticket">{text("apexTicket")}</Field>
            <Field label="Additional Resources" wide>{text("additionalResources")}</Field>
            <Field label="Trade Request ID">{text("tradeRequestId")}</Field>
            <Field label="Trade Request Link">{text("tradeRequestUrl", "https://")}</Field>
            <Field label="Trade Instructions" wide>
              <textarea value={draft.tradeInstructions} onChange={(e) => update({ tradeInstructions: e.target.value })} />
            </Field>
          </Section>

          <Section id="other" open={open.has("other")} incomplete={incomplete.has("other")} onToggle={toggle}>
            <Field label="Notes" wide>
              <textarea value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
            </Field>
            {draft.status === "Rejected" && (
              <Field label="Rejection Reason" required wide>
                <textarea value={draft.rejectionReason} onChange={(e) => update({ rejectionReason: e.target.value })} />
              </Field>
            )}
          </Section>
        </div>

        <footer className={styles.foot}>
          <p className={missing.length > 0 ? styles.stillNeeded : styles.complete}>
            {missing.length > 0 ? `Still needed: ${missing.join(", ")}` : "All required fields are complete"}
          </p>
          {reason && <p role="alert" className={styles.error}>{reason}</p>}
          <div className={styles.footActions}>
            <button type="button" className={styles.secondary} onClick={requestClose}>Cancel</button>
            <button type="button" className={styles.primary} disabled={missing.length > 0 || submitting}
              onClick={() => void submit()}>
              {submitting ? "Creating..." : "Create Transfer"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
