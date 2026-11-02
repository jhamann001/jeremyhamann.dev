"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CONTACT_METHOD_LABELS,
  LIQUIDATION_OPTIONS,
  REQUIREMENT_OPTIONS,
  RETURN_METHOD_OPTIONS,
  SIGNATURE_OPTIONS,
  filterCustodians, feeDirectionLabel, playbookOptionLabel, resolveCustodianContact,
  type CustodianLibrary as Library, type CustodianProfile,
} from "@/lib/data/custodian-library-contract";
import { applyMerge, applySaved, playbookSummary } from "@/lib/data/custodian-admin-contract";
import {
  AddCustodianCard, AdminDialogBody, AdminNotice, ExportCsvButton, ReviewStatus,
} from "./CustodianAdmin";
import styles from "./CustodianLibrary.module.css";

const labels: Record<string, string> = {
  VERIFIED: "Verified", NEEDS_SETUP: "Needs setup", DOCUMENTED: "Documented",
  PARTIAL: "Partial", NEEDS_CALL: "Needs call", ACAT_API: "ACAT",
  MANUAL: "Manual", MIXED: "Mixed", INTERNAL: "Internal", UNCONFIRMED: "Unconfirmed",
  ANY: "Any", IRA: "IRA", BROKERAGE: "Brokerage", FULL: "Full",
};
const display = (value: string | null) => value?.trim() ? labels[value] ?? value : "Not recorded";
const money = (value: number | null) => value == null ? "Not recorded"
  : value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const date = (value: string) => new Date(value).toLocaleString("en-US", {
  timeZone: "America/New_York", timeZoneName: "short",
});

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

export function CustodianTiming({ profile: c }: { profile: CustodianProfile }) {
  const timingUnavailable = c.observedTimingAvailable === false;
  return <section aria-label="Processing timing" className={styles.timing}>
    <h3>Processing timing</h3>
    <dl className={styles.fields}>
      <Field label="Configured expected processing time">{c.configuredExpectedProcessingDays == null ? "Not recorded" : `${c.configuredExpectedProcessingDays} days`}</Field>
      <Field label="Observed average completion">{timingUnavailable || c.observedAvgProcessingBusinessDays == null ? "No observed timing" : `${c.observedAvgProcessingBusinessDays} business days`}</Field>
      <Field label="Observed completed transfers">{timingUnavailable ? "No observed timing" : c.observedCompletedTransfers}</Field>
      <Field label="Recorded transfers to date">{c.transfersToDate ?? "Not recorded"}</Field>
    </dl>
    <p className={styles.muted}>Observed timing uses completed inbound transfers, excluding residual credits. It is not a guaranteed turnaround time.</p>
  </section>;
}

export function CustodianDetails({ profile: c }: { profile: CustodianProfile }) {
  const contact = resolveCustodianContact(c);
  const playbook = (value: string | null, options: ReadonlyArray<{ value: string; label: string }>) =>
    playbookOptionLabel(value, options) ?? "Not recorded";
  return <div className={styles.detail}>
    <section aria-label="Transfer playbook" className={styles.playbook}>
      <h3>Transfer playbook</h3>
      <dl className={styles.fields}>
        <Field label="Review status">{display(c.reviewStatus)}</Field>
        <Field label="Documentation">{display(c.documentationStatus)}</Field>
        <Field label="Transfer method">{display(c.transferType)}</Field>
        <Field label="DTC number">{display(c.dtcNumber)}</Field>
        <Field label="Receiving account / routing instructions">{display(c.receivingAccountNumber)}</Field>
        <Field label="Contact method">{contact.contactMethod ? CONTACT_METHOD_LABELS[contact.contactMethod] : "Not recorded"}</Field>
        <Field label="Contact details">
          <span className={styles.sourceText}>{display(contact.contactDetails)}</span>
        </Field>
        <Field label="Signature">{playbook(c.signature, SIGNATURE_OPTIONS)}</Field>
        <Field label="Letter of acceptance">{playbook(c.letterOfAcceptance, REQUIREMENT_OPTIONS)}</Field>
        <Field label="Medallion guarantee">{playbook(c.medallionRequired, REQUIREMENT_OPTIONS)}</Field>
        <Field label="Paperwork on file">{c.paperworkOnFile == null ? "Not recorded" : c.paperworkOnFile ? "Yes" : "No"}</Field>
        <Field label="Liquidation method">{playbook(c.liquidationMethod, LIQUIDATION_OPTIONS)}</Field>
        <Field label="Return / submission method">{playbook(c.returnMethod, RETURN_METHOD_OPTIONS)}</Field>
      </dl>
      <h4>Watchouts</h4><p className={styles.sourceText}>{display(c.watchouts)}</p>
    </section>
    <CustodianTiming profile={c} />
    {c.feeSchedules && c.feeSchedules.length > 0 && <section aria-label="Fee schedule files" className={styles.feeSection}>
      <h3>Fee schedule files</h3>
      <ul>
        {c.feeSchedules.map((file) => <li key={file.id}>
          {file.filename} · {file.contentType} · {file.byteSize} bytes
        </li>)}
      </ul>
    </section>}
    <section aria-label="Custodian fee rules" className={styles.feeSection}>
      <h3>Custodian fees</h3>
      <p className={styles.muted}>Base ACAT fee (legacy Tracker field): {money(c.acatFeeAmount)}. Use the detailed rules and qualifications below; the base value alone does not establish the applicable fee.</p>
      <p className={styles.muted}>Directions describe the transfer relative to Apex. These are reference rules, not a fee calculation or reimbursement decision.</p>
      {c.fees.length === 0 ? <p>No fee rules recorded. This does not mean transfers are free.</p> :
        <div className={styles.fees}>{c.fees.map((fee) => <article className={styles.fee} key={fee.id}>
          <h4>{display(fee.feeType)}</h4>
          <dl className={styles.fields}>
            <Field label="Amount (USD)">{money(fee.amount)}</Field>
            <Field label="Amount qualification">{display(fee.amountText)}</Field>
            <Field label="Account type">{display(fee.accountType)}</Field>
            <Field label="Transfer scope">{display(fee.transferType)}</Field>
            <Field label="Custodian fee direction">{feeDirectionLabel(fee.direction)}</Field>
            <Field label="Last updated">{date(fee.updatedAt)}</Field>
            <Field label="Created">{date(fee.createdAt)}</Field>
          </dl>
          <h4>Notes</h4><p className={styles.sourceText}>{display(fee.notes)}</p>
          <h4>Documentation / source</h4><p className={styles.sourceText}>{display(fee.documentation)}</p>
        </article>)}</div>}
    </section>
  </div>;
}

function CustodianDialog({ profile, onClose, admin = false, notice, children }: {
  profile: CustodianProfile; onClose: () => void; admin?: boolean; notice?: ReactNode; children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal(); // Native inert background, Escape and focus restoration.
    document.body.style.overflow = "hidden";
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId}
    onClose={() => { if (ref.current && !ref.current.open) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab" || !ref.current) return;
      const stops = Array.from(ref.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      )).filter((element) => element.getClientRects().length > 0);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }}>
    <div className={styles.dialogHeader}>
      <div>
        <p className={styles.eyebrow}>{admin ? "Custodian reference · Admin" : "Custodian reference · Read only"}</p>
        <h2 id={titleId}>{profile.name}</h2>
        {admin
          ? <p className={styles.dialogSubtitle}>{playbookSummary(profile)}</p>
          : <p className={styles.dialogSubtitle}>{display(profile.transferType)} · {display(profile.reviewStatus)}</p>}
      </div>
      <button type="button" className={styles.close} onClick={() => ref.current?.close()} aria-label="Close custodian details">Close <span aria-hidden="true">×</span></button>
    </div>
    <div className={styles.dialogBody} tabIndex={0} role="region" aria-label="Custodian reference details">
      {admin ? <>{notice}{children}</> : <CustodianDetails profile={profile} />}
    </div>
  </dialog>;
}

export function CustodianLibrary({ library, status, actions, admin = false, authorityLibrary = false, onLibraryChange }: {
  library: Library | null; status?: ReactNode; actions?: ReactNode;
  admin?: boolean; authorityLibrary?: boolean;
  onLibraryChange?: (update: (library: Library) => Library) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 3_000);
    return () => clearTimeout(timeout);
  }, [notice]);
  const change = (update: (custodians: CustodianProfile[]) => CustodianProfile[]) => {
    onLibraryChange?.((old) => ({ ...old, custodians: update(old.custodians) }));
  };
  const selected = library?.custodians.find((c) => c.id === selectedId);
  const results = library ? filterCustodians(library.custodians, query) : [];
  // Keep the toolbar's Refresh button mounted while data is cleared/reloaded,
  // preserving keyboard focus. Null never renders a source row or timestamp.
  useEffect(() => {
    if (!library) { setQuery(""); setSelectedId(null); }
  }, [library]);
  return <div className={styles.library}>
    {admin && library && <AddCustodianCard onSaved={(custodian) => {
      change((list) => applySaved(list, custodian));
      setNotice(`Added ${custodian.name}`);
      setSelectedId(custodian.id);
    }} />}
    {admin && !selected && notice && <AdminNotice message={notice} />}
    <div className={styles.toolbar}>
      {library && library.custodians.length > 0 && <label className={styles.search}>Find a custodian
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, DTC number, method or fee type" />
      </label>}
      {library && <p role="status" className={styles.results}>{results.length} of {library.custodians.length} custodians</p>}
      {admin && library && <ExportCsvButton custodians={results} />}
      {actions}
    </div>
    <div className={styles.metadata}>
      {status}
      {library && <p>Source: Transfer Tracker · Source snapshot <time dateTime={library.retrievedAt}>{date(library.retrievedAt)}</time>.</p>}
    </div>
    {library && <p className={styles.notice}>Individual transfer records are not included.</p>}
    {library && (library.custodians.length === 0 ? <p role="status">No custodians are configured in the Tracker.</p> : <>
      {results.length === 0 && <p>No custodians match your search.</p>}
      <div className={styles.grid}>
        {results.map((c) => <button type="button" className={styles.card} key={c.id}
          aria-haspopup="dialog" aria-label={`View ${c.name} playbook and fees`} onClick={() => setSelectedId(c.id)}>
          <span className={styles.cardTop}><span className={styles.method}>{display(c.transferType)}</span>{admin ? <ReviewStatus status={c.reviewStatus} /> : <span className={styles.review}>{display(c.reviewStatus)}</span>}</span>
          <strong className={styles.name}>{c.name}</strong>
          <span className={styles.dtc}>DTC <span>{display(c.dtcNumber)}</span></span>
          <span className={styles.cardBottom}><span>{c.fees.length === 0 ? "No fee rules recorded" : `${c.fees.length} fee ${c.fees.length === 1 ? "rule" : "rules"}`}</span><span className={styles.view}>View playbook <span aria-hidden="true">↗</span></span></span>
        </button>)}
      </div>
    </>)}
    {selected && (admin && library
      ? <CustodianDialog key={selected.id} profile={selected} admin onClose={() => setSelectedId(null)}
          notice={notice ? <AdminNotice message={notice} /> : null}>
          <AdminDialogBody profile={selected} custodians={library.custodians}
            timing={<CustodianTiming profile={selected} />}
            authorityLibrary={authorityLibrary}
            notify={setNotice}
            onSaved={(custodian) => change((list) => applySaved(list, custodian))}
            onMerged={(kept, deletedId, reassigned) => {
              change((list) => applyMerge(list, deletedId, kept));
              setSelectedId(kept.id);
              setNotice(`Merged. ${reassigned} ACAT ${reassigned === 1 ? "record" : "records"} moved to ${kept.name}.`);
            }} />
        </CustodianDialog>
      : <CustodianDialog key={selected.id} profile={selected} onClose={() => setSelectedId(null)} />)}
  </div>;
}
