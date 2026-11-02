"use client";

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CustodianFee, CustodianProfile } from "@/lib/data/custodian-library-contract";
import {
  BLANK_FEE, CONFIRM_DELETE_FEE, CONFIRM_MERGE_CUSTODIAN, CONTACT_METHOD_OPTIONS, DOCUMENTATION_STATUSES,
  FEE_ACCOUNT_TYPES, FEE_DIRECTIONS, FEE_DIRECTION_LABELS, FEE_DIRECTION_TITLE, FEE_TRANSFER_TYPES,
  PLAYBOOK_TRANSFER_TYPES, changePlaybookContactMethod, csvFilename, custodiansCsv, detailsPatch,
  documentationLabel, feeAmountLabel, feeDraftFrom, liquidationDisplay, liquidationOptionsFor,
  nameFailure, playbookDraftFrom, requirementDisplay, requirementOptionsFor, returnMethodDisplay,
  returnMethodOptionsFor, signatureDisplay, signatureOptionsFor, transferTypeLabel,
  type DetailsDraft, type FeeDraft, type PlaybookDraft,
} from "@/lib/data/custodian-admin-contract";
import {
  CONTACT_METHOD_LABELS, resolveCustodianContact, type CustodianContactMethod,
} from "@/lib/data/custodian-library-contract";
import {
  addCustodianFee, createCustodian, deleteCustodianFee, downloadCustodianFeeSchedule,
  markCustodianReviewed, mergeCustodian, saveCustodianDetails, saveCustodianFee,
  saveCustodianFeeSchedule, saveCustodianPlaybook, type CustodianAdminResult,
} from "@/app/(authenticated)/acat-tracking/custodian-admin-actions";
import { demoMode } from "@/lib/demo/mode";
import library from "./CustodianLibrary.module.css";
import s from "./CustodianAdmin.module.css";

type Saved = Extract<CustodianAdminResult, { ok: true }>;
type Failure = { message: string; retry: (() => void) | null };

/** Runs one admin action at a time. A refusal keeps the shown custodian as it was
 * and offers Retry, which repeats the same action with the same draft. */
export function useAdminRunner() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const last = useRef<{ action: () => Promise<CustodianAdminResult>; onOk: (result: Saved) => void } | null>(null);
  const run = useCallback(async (action: () => Promise<CustodianAdminResult>, onOk: (result: Saved) => void) => {
    last.current = { action, onOk };
    setBusy(true);
    const retry = () => { if (last.current) void run(last.current.action, last.current.onOk); };
    try {
      const result = await action();
      if (result.ok) { setFailure(null); onOk(result); }
      else setFailure({ message: result.reason, retry: result.retryable ? retry : null });
    } catch {
      setFailure({ message: "The tracker did not save this change. Try again.", retry });
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, failure, run, dismiss: () => setFailure(null), fail: (message: string) => setFailure({ message, retry: null }) };
}

export function AdminFailure({ message, onRetry, onDismiss }: {
  message: string; onRetry?: (() => void) | null; onDismiss?: () => void;
}) {
  return <div role="alert" className={`${s.banner} ${s.bannerDanger}`}>
    <span>{message}</span>
    {onRetry && <button type="button" className={s.bannerButton} onClick={onRetry}>Retry</button>}
    {onDismiss && <button type="button" className={s.bannerButton} aria-label="Dismiss" onClick={onDismiss}>×</button>}
  </div>;
}

export function AdminNotice({ message }: { message: string }) {
  return <div role="status" className={`${s.banner} ${s.bannerSuccess}`}><span>{message}</span></div>;
}

export function ReviewStatus({ status }: { status: string }) {
  const needs = status === "NEEDS_SETUP";
  return <span className={`${library.review} ${needs ? library.reviewWarning : status === "VERIFIED" ? library.reviewSuccess : ""}`}>
    {needs ? "Needs setup" : status === "VERIFIED" ? "Verified" : status}
  </span>;
}

function TextField({ label, value, onChange, type = "text" }: {
  label: string; value: string; onChange: (value: string) => void; type?: "text" | "email" | "number";
}) {
  return <label className={s.field}>
    <span>{label}</span>
    <input className={s.input} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
  </label>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div className={s.group} data-playbook-group={title}>
    <h4 className={s.groupTitle}>{title}</h4>
    <div className={s.groupGrid}>{children}</div>
  </div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={s.row}><span className={s.rowLabel}>{label}</span><span className={s.rowValue}>{children}</span></div>;
}

const Dash = () => <span>—</span>;
const Pill = ({ tone, mono, children }: { tone?: "accent" | "success" | "warning"; mono?: boolean; children: ReactNode }) => (
  <span data-pill className={`${s.pill} ${mono ? s.mono : ""} ${tone === "accent" ? s.pillAccent : tone === "success" ? s.pillSuccess : tone === "warning" ? s.pillWarning : ""}`}>{children}</span>
);
const text = (value: string | null) => value ?? "—";

export function NeedsSetupBanner({ onMarkReviewed, busy }: { onMarkReviewed: () => void; busy: boolean }) {
  return <div className={`${s.banner} ${s.bannerWarning}`}>
    <span>This custodian was auto-created from an ingested contra and needs review.</span>
    <button type="button" className={s.bannerButton} disabled={busy} onClick={onMarkReviewed}>Mark reviewed</button>
  </div>;
}

function PanelButtons({ editing, busy, onStartEdit, onSave, onCancel }: {
  editing: boolean; busy: boolean; onStartEdit: () => void; onSave: () => void; onCancel: () => void;
}) {
  return editing
    ? <div className={s.buttons}>
        <button type="button" className={s.primary} disabled={busy} onClick={onSave}>Save</button>
        <button type="button" className={s.btn} onClick={onCancel}>Cancel</button>
      </div>
    : <button type="button" className={s.btn} onClick={onStartEdit}>Edit</button>;
}

export function DetailsPanel({ profile, editing, draft, busy, onDraftChange, onStartEdit, onSave, onCancel }: {
  profile: CustodianProfile; editing: boolean; draft: DetailsDraft; busy: boolean;
  onDraftChange: (draft: DetailsDraft) => void; onStartEdit: () => void; onSave: () => void; onCancel: () => void;
}) {
  const days = profile.configuredExpectedProcessingDays;
  return <section className={s.panel} aria-label="Custodian details">
    <div className={s.panelHeader}>
      <h3>Custodian details</h3>
      <PanelButtons editing={editing} busy={busy} onStartEdit={onStartEdit} onSave={onSave} onCancel={onCancel} />
    </div>
    {editing
      ? <div className={s.groupGrid}>
          <TextField label="Name" value={draft.name} onChange={(name) => onDraftChange({ ...draft, name })} />
          <TextField label="Expected processing days (SLA)" type="number" value={draft.avgProcessingDays}
            onChange={(avgProcessingDays) => onDraftChange({ ...draft, avgProcessingDays })} />
        </div>
      : <div className={s.groupGrid}>
          <Row label="Name">{profile.name}</Row>
          <Row label="Expected processing days (SLA)">{days == null ? "—" : `${days} days`}</Row>
        </div>}
  </section>;
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<readonly [string, string]>;
}) {
  return <label className={s.field}>
    <span>{label}</span>
    <select className={s.select} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  </label>;
}

/** Bullets for each non-blank line, leading markers stripped, as the tracker renders watchouts. */
function WatchoutsList({ value }: { value: string | null }) {
  const items = (value ?? "").split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[•◦·]\s*|-\s+)/, "").trim()).filter(Boolean);
  return items.length === 0 ? <span>—</span>
    : <ul className={s.watchList}>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>;
}

export function PlaybookPanel({ profile, editing, draft, busy, onDraftChange, onStartEdit, onSave, onCancel }: {
  profile: CustodianProfile; editing: boolean; draft: PlaybookDraft; busy: boolean;
  onDraftChange: (draft: PlaybookDraft) => void; onStartEdit: () => void; onSave: () => void; onCancel: () => void;
}) {
  const set = <K extends keyof PlaybookDraft>(key: K, value: PlaybookDraft[K]) => onDraftChange({ ...draft, [key]: value });
  const contact = resolveCustodianContact(profile);
  return <section className={s.panel} aria-label="Transfer playbook">
    <div className={s.panelHeader}>
      <h3>Transfer playbook</h3>
      <PanelButtons editing={editing} busy={busy} onStartEdit={onStartEdit} onSave={onSave} onCancel={onCancel} />
    </div>
    {editing
      ? <div className={s.groups}>
          <Group title="Routing">
            <TextField label="DTC / clearing #" value={draft.dtcNumber} onChange={(v) => set("dtcNumber", v)} />
            <div>
              <TextField label="Receiving / house account #" value={draft.receivingAccountNumber}
                onChange={(v) => set("receivingAccountNumber", v)} />
              <p className={s.hint}>Last-known value only; verify it before each transfer.</p>
            </div>
            <SelectField label="Transfer type" value={draft.transferType} options={PLAYBOOK_TRANSFER_TYPES}
              onChange={(v) => set("transferType", v)} />
            <SelectField label="Documentation status" value={draft.documentationStatus} options={DOCUMENTATION_STATUSES}
              onChange={(v) => set("documentationStatus", v)} />
          </Group>
          <Group title="Requirements">
            <SelectField label="Signature" value={draft.signature} options={signatureOptionsFor(profile.signature)}
              onChange={(v) => set("signature", v)} />
            <SelectField label="Letter of acceptance" value={draft.letterOfAcceptance}
              options={requirementOptionsFor(profile.letterOfAcceptance)}
              onChange={(v) => set("letterOfAcceptance", v)} />
            <SelectField label="Medallion (MSG)" value={draft.medallionRequired}
              options={requirementOptionsFor(profile.medallionRequired)}
              onChange={(v) => set("medallionRequired", v)} />
            <label className={s.checkbox}>
              <input type="checkbox" checked={draft.paperworkOnFile} onChange={(e) => set("paperworkOnFile", e.target.checked)} />
              <span>Paperwork on file</span>
            </label>
            <p className={s.hint}>Add any conditions or exceptions in Watchouts. Existing custom values are kept until you choose a replacement.</p>
          </Group>
          <Group title="Proceeds & contact">
            <SelectField label="Liquidation proceeds" value={draft.liquidationMethod}
              options={liquidationOptionsFor(profile.liquidationMethod)}
              onChange={(v) => set("liquidationMethod", v)} />
            <SelectField label="Return method" value={draft.returnMethod}
              options={returnMethodOptionsFor(profile.returnMethod)}
              onChange={(v) => set("returnMethod", v)} />
            <p className={s.hint}>Put routing instructions, mailing addresses, or exceptions in Watchouts.</p>
            <SelectField label="Contact method" value={draft.contactMethod} options={CONTACT_METHOD_OPTIONS}
              onChange={(v) => onDraftChange(changePlaybookContactMethod(draft, v as CustodianContactMethod | ""))} />
            {draft.contactMethod && (
              draft.contactMethod === "EMAIL"
                ? <TextField label="Contact details" type="email" value={draft.contactDetails}
                    onChange={(v) => set("contactDetails", v)} />
                : <label className={s.field}>
                    <span>Contact details</span>
                    <textarea className={s.textarea} rows={3} value={draft.contactDetails}
                      placeholder={draft.contactMethod === "PHONE"
                        ? "Phone number, extension, and contact name"
                        : draft.contactMethod === "PORTAL"
                          ? "Portal URL and contact instructions"
                          : "Contact details and instructions"}
                      onChange={(e) => set("contactDetails", e.target.value)} />
                  </label>
            )}
          </Group>
          <Group title="Track record">
            <TextField label="Transfers to date" type="number" value={draft.transfersToDate} onChange={(v) => set("transfersToDate", v)} />
          </Group>
          <div>
            <span className={s.watchHeading}>Watchouts</span>
            <label className={s.field}>
              <span>One per line (use • or newlines for bullets)</span>
              <textarea className={s.textarea} rows={6} value={draft.watchouts} onChange={(e) => set("watchouts", e.target.value)} />
            </label>
          </div>
        </div>
      : <div className={s.groups}>
          <Group title="Routing">
            <Row label="DTC / clearing #">{profile.dtcNumber ? <Pill mono>{profile.dtcNumber}</Pill> : <Dash />}</Row>
            <Row label="Receiving / house account #">
              {profile.receivingAccountNumber
                ? <span><Pill tone="warning" mono>{profile.receivingAccountNumber}</Pill><span className={s.verify}>Verify before use</span></span>
                : <Dash />}
            </Row>
            <Row label="Transfer type">{profile.transferType ? <Pill tone="accent">{transferTypeLabel(profile.transferType)}</Pill> : <Dash />}</Row>
            <Row label="Documentation status">
              {profile.documentationStatus
                ? <Pill tone={profile.documentationStatus === "DOCUMENTED" ? "success" : "warning"}>{documentationLabel(profile.documentationStatus)}</Pill>
                : <Dash />}
            </Row>
          </Group>
          <Group title="Requirements">
            <Row label="Signature">{signatureDisplay(profile.signature)}</Row>
            <Row label="Letter of acceptance">{requirementDisplay(profile.letterOfAcceptance)}</Row>
            <Row label="Medallion (MSG)">{requirementDisplay(profile.medallionRequired)}</Row>
            <Row label="Paperwork on file">
              {profile.paperworkOnFile == null ? <Dash /> : <Pill tone={profile.paperworkOnFile ? "success" : undefined}>{profile.paperworkOnFile ? "Yes" : "No"}</Pill>}
            </Row>
          </Group>
          <Group title="Proceeds & contact">
            <Row label="Liquidation proceeds">{liquidationDisplay(profile.liquidationMethod)}</Row>
            <Row label="Return method">{returnMethodDisplay(profile.returnMethod)}</Row>
            <Row label="Contact method">{contact.contactMethod ? CONTACT_METHOD_LABELS[contact.contactMethod] : <Dash />}</Row>
            <Row label="Contact details">
              {contact.contactDetails
                ? <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{contact.contactDetails}</span>
                : <Dash />}
            </Row>
          </Group>
          <Group title="Track record">
            <Row label="Transfers to date">{profile.transfersToDate != null ? <Pill>{String(profile.transfersToDate)}</Pill> : <Dash />}</Row>
          </Group>
          <div className={s.group} data-playbook-group="Watchouts">
            <h4 className={s.groupTitle}>Watchouts</h4>
            <WatchoutsList value={profile.watchouts} />
          </div>
        </div>}
  </section>;
}

export function FeeForm({ draft, saveLabel, saving, onChange, onSave, onCancel }: {
  draft: FeeDraft; saveLabel: string; saving: boolean;
  onChange: (draft: FeeDraft) => void; onSave: () => void; onCancel: () => void;
}) {
  const set = <K extends keyof FeeDraft>(key: K, value: FeeDraft[K]) => onChange({ ...draft, [key]: value });
  const pick = (values: readonly string[]) => values.map((v) => [v, v] as const);
  return <div className={s.feeForm}>
    <div className={s.feeGrid3}>
      <TextField label="Fee type" value={draft.feeType} onChange={(v) => set("feeType", v)} />
      <SelectField label="Account type" value={draft.accountType} options={pick(FEE_ACCOUNT_TYPES)} onChange={(v) => set("accountType", v)} />
      <SelectField label="Transfer type" value={draft.transferType} options={pick(FEE_TRANSFER_TYPES)} onChange={(v) => set("transferType", v)} />
      <SelectField label="Transfer direction relative to Apex" value={draft.direction} onChange={(v) => set("direction", v)}
        options={FEE_DIRECTIONS.map((d) => [d, FEE_DIRECTION_LABELS[d]] as const)} />
    </div>
    <p className={s.hint}>
      These are this custodian’s fees. “Transfer into Apex” means assets leave this custodian; “Transfer out of Apex” means assets go to this custodian.
    </p>
    <div className={s.feeGrid2}>
      <TextField label="Amount (USD, blank if unknown)" type="number" value={draft.amount} onChange={(v) => set("amount", v)} />
      <TextField label='Amount text (e.g. "Call contra")' value={draft.amountText} onChange={(v) => set("amountText", v)} />
    </div>
    <TextField label="Notes" value={draft.notes} onChange={(v) => set("notes", v)} />
    <TextField label="Documentation (link or reference)" value={draft.documentation} onChange={(v) => set("documentation", v)} />
    <div className={s.buttons}>
      <button type="button" className={s.primary} disabled={saving} onClick={onSave}>{saveLabel}</button>
      <button type="button" className={s.btn} onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

function FeeRow({ fee, busy, onEdit, onDelete }: { fee: CustodianFee; busy: boolean; onEdit: () => void; onDelete: () => void }) {
  const direction = (fee.direction || "ANY") as keyof typeof FEE_DIRECTION_LABELS;
  return <div className={s.feeItem}>
    <div className={s.feeBody}>
      <div className={s.feeTitleRow}>
        <span className={s.feeTitle}>{fee.feeType}</span>
        <span className={s.tag}>{fee.accountType}</span>
        <span className={s.tag}>{fee.transferType}</span>
        <span className={s.tag} title={FEE_DIRECTION_TITLE}>{FEE_DIRECTION_LABELS[direction] ?? fee.direction}</span>
      </div>
      <div className={s.feeMeta}>
        <span className={`${s.feeAmount} ${s.mono}`}>{feeAmountLabel(fee)}</span>
        {fee.notes && <span>· {fee.notes}</span>}
        {fee.documentation && <span>· {fee.documentation}</span>}
      </div>
    </div>
    <div className={s.buttons}>
      <button type="button" className={s.btn} disabled={busy} onClick={onEdit}>Edit</button>
      <button type="button" className={s.danger} disabled={busy} onClick={onDelete}>Delete</button>
    </div>
  </div>;
}

export function FeeSchedule({ fees, busy, onAdd, onSave, onDelete }: {
  fees: CustodianFee[]; busy: boolean;
  onAdd: (draft: FeeDraft, done: () => void) => void;
  onSave: (feeId: string, draft: FeeDraft, done: () => void) => void;
  onDelete: (feeId: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FeeDraft>(BLANK_FEE);
  const closeAdd = () => { setShowAdd(false); setDraft(BLANK_FEE); };
  return <section className={s.panel} aria-label="Fee schedule">
    <div className={s.panelHeader}>
      <h3>Fee schedule <span className={s.count}>({fees.length})</span></h3>
      {!showAdd && !editingId && <button type="button" className={s.primary} onClick={() => { setDraft(BLANK_FEE); setShowAdd(true); }}>Add fee</button>}
    </div>
    {showAdd && <div className={s.feeAddBox}>
      <FeeForm draft={draft} saveLabel="Add" saving={busy} onChange={setDraft} onSave={() => onAdd(draft, closeAdd)} onCancel={closeAdd} />
    </div>}
    {fees.length === 0 && !showAdd
      ? <div className={s.empty}>No fees on file yet. Click <strong>Add fee</strong> to create one.</div>
      : <div className={s.feeList}>{fees.map((fee) => editingId === fee.id
          ? <div key={fee.id} className={s.feeItem}>
              <div className={s.feeBody}>
                <FeeForm draft={draft} saveLabel="Save" saving={busy} onChange={setDraft}
                  onSave={() => onSave(fee.id, draft, () => setEditingId(null))} onCancel={() => setEditingId(null)} />
              </div>
            </div>
          : <FeeRow key={fee.id} fee={fee} busy={busy}
              onEdit={() => { setShowAdd(false); setEditingId(fee.id); setDraft(feeDraftFrom(fee)); }}
              onDelete={() => { if (window.confirm(CONFIRM_DELETE_FEE)) onDelete(fee.id); }} />)}
        </div>}
  </section>;
}

export function MergePanel({ candidates, busy, onMerge }: {
  candidates: CustodianProfile[]; busy: boolean; onMerge: (targetId: string) => void;
}) {
  const [targetId, setTargetId] = useState("");
  return <section className={`${s.panel} ${s.dangerZone}`} aria-label="Danger zone">
    <div className={s.panelHeader}><h3 className={s.dangerTitle}>Danger zone</h3></div>
    <div className={s.dangerBody}>
      <p>Merge this custodian into another custodian. Its ACAT records and attached fee schedules will be moved, and this card removed.</p>
      <div className={s.mergeRow}>
        <label className={`${s.field} ${s.grow}`}>
          <span>Merge into</span>
          <select className={s.select} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Select a custodian…</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button type="button" className={s.primary} disabled={busy || !targetId}
          onClick={() => { if (window.confirm(CONFIRM_MERGE_CUSTODIAN)) onMerge(targetId); }}>Merge</button>
      </div>
    </div>
  </section>;
}

export function ExportCsvButton({ custodians }: { custodians: CustodianProfile[] }) {
  const download = () => {
    if (typeof document === "undefined" || custodians.length === 0) return;
    const blob = new Blob([custodiansCsv(custodians)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename(new Date());
    link.click();
    URL.revokeObjectURL(url);
  };
  return <button type="button" className={s.exportButton} title="Export current view as CSV"
    disabled={custodians.length === 0} onClick={download}>Export CSV</button>;
}

export function AddCustodianCard({ onSaved }: { onSaved: (custodian: CustodianProfile) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const { busy, failure, run, dismiss } = useAdminRunner();
  const close = () => { setOpen(false); setName(""); setNameError(null); dismiss(); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const blank = nameFailure(name);
    setNameError(blank);
    if (blank) return;
    void run(() => createCustodian(name), (result) => {
      if ("custodian" in result) { setOpen(false); setName(""); onSaved(result.custodian); }
    });
  };
  return <div className={s.addCard}>
    <div className={s.addHeader}>
      <h3>Add Custodian</h3>
      {!open && <button type="button" className={s.btn} onClick={() => setOpen(true)}>New</button>}
    </div>
    {open && <form className={s.addForm} noValidate onSubmit={submit}>
      <label className={`${s.field} ${s.grow}`}>
        <span>Custodian name</span>
        <input className={s.input} type="text" autoFocus value={name} placeholder="e.g. Betterment" onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" className={s.primary} disabled={busy}>Add</button>
      <button type="button" className={s.btn} onClick={close}>Cancel</button>
    </form>}
    {nameError && <div style={{ marginTop: 12 }}><AdminFailure message={nameError} onDismiss={() => setNameError(null)} /></div>}
    {failure && <div style={{ marginTop: 12 }}><AdminFailure message={failure.message} onRetry={failure.retry} onDismiss={dismiss} /></div>}
  </div>;
}

/** The admin body of the custodian dialog: tracker panels in the tracker's order,
 * with the read-only timing section kept between the playbook and the fees. */
export function AdminDialogBody({ profile, custodians, timing, authorityLibrary = false, onSaved, onMerged, notify }: {
  profile: CustodianProfile; custodians: CustodianProfile[]; timing: ReactNode;
  authorityLibrary?: boolean;
  onSaved: (custodian: CustodianProfile) => void;
  onMerged: (kept: CustodianProfile, deletedId: string, reassigned: number) => void;
  notify: (message: string) => void;
}) {
  const { busy, failure, run, dismiss, fail } = useAdminRunner();
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState<DetailsDraft>({ name: "", avgProcessingDays: "" });
  const [editingPlaybook, setEditingPlaybook] = useState(false);
  const [playbookDraft, setPlaybookDraft] = useState<PlaybookDraft>(() => playbookDraftFrom(profile));

  const saved = (message: string, after?: () => void) => (result: Saved) => {
    if ("custodian" in result) { onSaved(result.custodian); notify(message); }
    after?.();
  };

  return <div className={s.admin}>
    {failure && <AdminFailure message={failure.message} onRetry={failure.retry} onDismiss={dismiss} />}
    {profile.reviewStatus === "NEEDS_SETUP" && <NeedsSetupBanner busy={busy}
      onMarkReviewed={() => void run(() => markCustodianReviewed(profile.id), saved("Marked reviewed"))} />}
    <DetailsPanel profile={profile} editing={editingDetails} draft={detailsDraft} busy={busy}
      onDraftChange={setDetailsDraft}
      onStartEdit={() => {
        setDetailsDraft({ name: profile.name, avgProcessingDays: String(profile.configuredExpectedProcessingDays ?? "") });
        setEditingDetails(true);
      }}
      onCancel={() => { setEditingDetails(false); dismiss(); }}
      onSave={() => {
        const check = detailsPatch(profile, detailsDraft);
        if (!check.ok) { fail(check.reason); return; }
        void run(() => saveCustodianDetails(profile, detailsDraft), saved("Custodian updated", () => setEditingDetails(false)));
      }} />
    <PlaybookPanel profile={profile} editing={editingPlaybook} draft={playbookDraft} busy={busy}
      onDraftChange={setPlaybookDraft}
      onStartEdit={() => { setPlaybookDraft(playbookDraftFrom(profile)); setEditingPlaybook(true); }}
      onCancel={() => { setEditingPlaybook(false); dismiss(); }}
      onSave={() => void run(() => saveCustodianPlaybook(profile, playbookDraft), saved("Transfer playbook updated", () => setEditingPlaybook(false)))} />
    {timing}
    {profile.feeSchedules && profile.feeSchedules.length > 0 && <section aria-label="Fee schedule files">
      <h3>Fee schedule files</h3>
      <ul>
        {profile.feeSchedules.map((file) => <li key={file.id}>
          {file.filename} · {file.contentType} · {file.byteSize} bytes
          {authorityLibrary && <button type="button" disabled={busy} onClick={() => void (async () => {
            const result = await downloadCustodianFeeSchedule(file.id);
            if (!result.ok) { fail(result.reason); return; }
            const bytes = Uint8Array.from(atob(result.bytesBase64), (ch) => ch.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
            const link = document.createElement("a");
            link.href = url;
            link.download = result.filename;
            link.click();
            URL.revokeObjectURL(url);
          })()}>Download</button>}
        </li>)}
      </ul>
    </section>}
    {/* The public demo stores no visitor files; the server refuses them too (saveCustodianFeeSchedule). */}
    {authorityLibrary && demoMode() && <p className={s.hint}>
      Uploading fee-schedule files is off in the demo. The stored files above still download.
    </p>}
    {authorityLibrary && !demoMode() && <label>Upload fee schedule
      <input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={busy}
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          void run(async () => {
            const buffer = await chosen.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return saveCustodianFeeSchedule(profile.id, {
              filename: chosen.name,
              contentType: chosen.type,
              bytesBase64: btoa(binary),
            });
          }, saved("Fee schedule uploaded"));
        }} />
    </label>}
    <FeeSchedule fees={profile.fees} busy={busy}
      onAdd={(draft, done) => void run(() => addCustodianFee(profile.id, draft), saved("Fee added", done))}
      onSave={(feeId, draft, done) => void run(() => saveCustodianFee(profile.id, feeId, draft), saved("Fee updated", done))}
      onDelete={(feeId) => void run(() => deleteCustodianFee(profile.id, feeId), saved("Fee deleted"))} />
    <MergePanel candidates={custodians.filter((c) => c.id !== profile.id)} busy={busy}
      onMerge={(targetId) => void run(() => mergeCustodian(profile.id, targetId), (result) => {
        if ("custodian" in result && result.deletedId !== undefined && result.reassigned !== undefined) {
          onMerged(result.custodian, result.deletedId, result.reassigned);
        }
      })} />
  </div>;
}
