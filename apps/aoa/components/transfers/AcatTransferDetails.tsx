"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeTransferField,
  listTransferContras,
  loadDtccSuggestion,
  saveTransferText,
} from "@/app/(authenticated)/acat-tracking/transfer-drawer-actions";
import { filterContras } from "@/lib/data/acat-create-contract";
import { usdFromCents } from "@/lib/format";
import {
  ACAT_WRITE_UNAVAILABLE,
  ACCOUNT_FIELDS,
  DATE_FIELDS,
  REJECTION_FIELD,
  TICKET_FIELDS,
  TRADE_REQUEST_FIELDS,
  TRANSFER_FIELDS,
  buildChangeRequest,
  formatDrawerDate,
  isMaskedValue,
  ticketFields,
  type DrawerFieldDef,
  type DrawerTransfer,
  type DrawerWriteResult,
  type DtccSuggestion,
} from "@/lib/data/acat-drawer-contract";
import { useInlineEdit } from "./useInlineEdit";
import styles from "./AcatTransferDrawer.module.css";

const ALL_FIELDS: readonly DrawerFieldDef[] = [
  ...TRANSFER_FIELDS, ...ACCOUNT_FIELDS, ...DATE_FIELDS, ...TICKET_FIELDS, REJECTION_FIELD, ...TRADE_REQUEST_FIELDS,
];

const ACCOUNT_BLANK_START: ReadonlySet<string> = new Set(["apexAccountId", "statementAccountNumber"]);

function fieldValue(transfer: DrawerTransfer, def: DrawerFieldDef): string {
  const raw = transfer[def.key];
  if (def.key === "statementAmount") return typeof raw === "number" ? usdFromCents(raw) : "";
  if (def.key === "transferWorkflow") return typeof raw === "string" && raw !== "" ? raw : "UNCLASSIFIED";
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

function displayText(def: DrawerFieldDef, value: string): string {
  if (def.type === "date") return formatDrawerDate(value) || value;
  const option = def.options?.find((o) => o.value === value);
  return option ? option.label : value;
}

type FieldError = { field: string; reason: string; retryable: boolean };

export function AcatTransferDetails({ transfer, readOnly, onStored }: {
  transfer: DrawerTransfer;
  readOnly: boolean;
  onStored: (next: DrawerTransfer) => boolean;
}) {
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [processingOpen, setProcessingOpen] = useState(false);
  const [contras, setContras] = useState<{ name: string; dtcNumber: string | null }[] | null>(null);
  const [suggestion, setSuggestion] = useState<DtccSuggestion | null>(null);
  const [applying, setApplying] = useState(false);
  const identityVersion = useRef(transfer.identityVersion);
  const wrapper = useRef<HTMLDivElement>(null);
  const contra = transfer.transferringContra?.trim() ?? "";

  const fail = useCallback((field: string, result: { reason: string; retryable: boolean }) =>
    setFieldError({ field, reason: result.reason, retryable: result.retryable }), []);

  const onSave = useCallback(async (field: string, value: string): Promise<boolean> => {
    const def = ALL_FIELDS.find((f) => f.key === field);
    if (!def) return false;
    setFieldError(null);
    try {
      let result: DrawerWriteResult;
      if (def.route === "general") {
        result = await saveTransferText(transfer.id, field, value);
      } else {
        const context = { direction: transfer.direction, identityVersion: identityVersion.current };
        const request = buildChangeRequest(field, value, context);
        if (!request.ok) { fail(field, { reason: request.reason, retryable: false }); return false; }
        if (def.type === "contra" && !contras?.some((c) => c.name === value.trim())) {
          fail(field, { reason: "Choose a contra from the list.", retryable: false });
          return false;
        }
        result = await changeTransferField(transfer.id, field, value, context);
      }
      if (!result.ok) { fail(field, result); return false; }
      return onStored(result.transfer);
    } catch {
      fail(field, { reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
      return false;
    }
  }, [contras, fail, onStored, transfer.direction, transfer.id]);

  const edit = useInlineEdit({ onSave });
  const editingType = ALL_FIELDS.find((f) => f.key === edit.editingField)?.type;

  useEffect(() => {
    if (editingType !== "multiselect" && editingType !== "contra") return;
    function onDown(event: MouseEvent) {
      if (wrapper.current && event.target instanceof Node && !wrapper.current.contains(event.target)) void edit.commit();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editingType, edit]);

  useEffect(() => {
    setSuggestion(null);
    if (readOnly || contra === "") return;
    let canceled = false;
    loadDtccSuggestion(contra)
      .then((r) => { if (!canceled) setSuggestion(r.ok ? { status: r.status, dtccNumber: r.dtccNumber } : null); })
      .catch(() => { if (!canceled) setSuggestion(null); });
    return () => { canceled = true; };
  }, [contra, readOnly]);

  function begin(def: DrawerFieldDef) {
    if (readOnly) return;
    const stored = fieldValue(transfer, def);
    identityVersion.current = transfer.identityVersion;
    setFieldError(null);
    const blank = ACCOUNT_BLANK_START.has(def.key) || (def.key === "dtccNumber" && isMaskedValue(stored));
    edit.start(def.key, blank ? "" : stored);
    if (def.type === "contra" && contras === null) {
      void listTransferContras()
        .then((r) => {
          if (r.ok) setContras(r.contras);
          else fail(def.key, r);
        })
        .catch(() => fail(def.key, { reason: ACAT_WRITE_UNAVAILABLE, retryable: true }));
    }
  }

  async function applySuggestion() {
    if (!suggestion?.dtccNumber || applying) return;
    setApplying(true);
    setFieldError(null);
    try {
      const result = await changeTransferField(transfer.id, "dtccNumber", suggestion.dtccNumber, {
        direction: transfer.direction, identityVersion: transfer.identityVersion,
      });
      if (!result.ok) fail("dtccNumber", result);
      else onStored(result.transfer);
    } catch {
      fail("dtccNumber", { reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    } finally {
      setApplying(false);
    }
  }

  function editor(def: DrawerFieldDef) {
    const handlers = edit.bind(def.key);
    const value = edit.editValue;
    switch (def.type) {
      case "select": {
        const options = def.options ?? [];
        const unlisted = value !== "" && !options.some((o) => o.value === value);
        return (
          <select {...handlers} aria-label={`Edit ${def.label}`} className={styles.input} value={value}
            onChange={(e) => { edit.change(e.target.value); void edit.commit(e.target.value); }}>
            {value === "" && <option value="" disabled>Choose…</option>}
            {unlisted && <option value={value}>{value}</option>}
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        );
      }
      case "multiselect": {
        const chosen = value.split(",").map((m) => m.trim()).filter(Boolean);
        return (
          <fieldset className={styles.checklist} aria-label={`Edit ${def.label}`}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); edit.cancel(); } }}>
            {(def.options ?? []).map((o) => (
              <label key={o.value} className={styles.checkOption}>
                <input type="checkbox" checked={chosen.includes(o.value)}
                  onChange={() => edit.change(
                    (chosen.includes(o.value) ? chosen.filter((m) => m !== o.value) : [...chosen, o.value]).join(", "),
                  )} />
                {o.label}
              </label>
            ))}
          </fieldset>
        );
      }
      case "contra": {
        const names = filterContras((contras ?? []).map((c) => c.name), value);
        return (
          <div className={styles.contraBox}>
            <input {...handlers} type="text" aria-label={`Edit ${def.label}`} className={styles.input} value={value}
              placeholder="Type to search contras" onChange={(e) => edit.change(e.target.value)}
              onBlur={() => undefined} />
            <ul className={styles.options} aria-label="Contras">
              {names.map((name) => (
                <li key={name}>
                  <button type="button" className={styles.optionButton}
                    onMouseDown={(e) => { e.preventDefault(); edit.change(name); void edit.commit(name); }}>{name}</button>
                </li>
              ))}
            </ul>
          </div>
        );
      }
      case "textarea":
        return (
          <textarea {...handlers} aria-label={`Edit ${def.label}`} className={styles.input} rows={3} value={value}
            onChange={(e) => edit.change(e.target.value)} />
        );
      case "date":
        return (
          <input {...handlers} type="date" aria-label={`Edit ${def.label}`} className={styles.input} value={value}
            onChange={(e) => edit.change(e.target.value)} />
        );
      default:
        return (
          <input {...handlers} type="text" aria-label={`Edit ${def.label}`} className={styles.input} value={value}
            placeholder={ACCOUNT_BLANK_START.has(def.key) ? "Enter full account number" : undefined}
            onChange={(e) => edit.change(e.target.value)} />
        );
    }
  }

  function display(def: DrawerFieldDef) {
    const stored = fieldValue(transfer, def);
    const shown = displayText(def, stored);
    const isUrl = /^https?:\/\//i.test(stored);
    const body = stored === "" ? <span className={styles.empty}>—</span>
      : def.type === "multiselect"
        ? <span className={styles.chips}>{stored.split(",").map((m) => m.trim()).filter(Boolean).map((m) => <span key={m} className={styles.chip}>{m}</span>)}</span>
        : isUrl ? <a href={stored} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{stored}</a>
          : <span className={styles.value}>{shown}</span>;
    if (readOnly) return <span className={styles.fieldStatic}>{body}</span>;
    return (
      <span role="button" tabIndex={0} aria-label={`Edit ${def.label}`} className={styles.fieldButton}
        onClick={() => begin(def)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); begin(def); } }}>
        {body}
        {edit.status === "saved" && edit.lastSavedField === def.key && (
          <span className={styles.saved} aria-label="Saved">✓</span>
        )}
        <span className={styles.pencil} aria-hidden="true">✎</span>
      </span>
    );
  }

  function row(def: DrawerFieldDef) {
    const editing = edit.editingField === def.key;
    const storedDtcc = (transfer.dtccNumber ?? "").trim();
    return (
      <div key={def.key} className={styles.fieldRow}>
        <span className={styles.fieldLabel}>{def.label}</span>
        <div className={styles.fieldBody}>
          {editing ? (
            <div ref={wrapper} className={styles.editing} data-editing="true">
              {editor(def)}
              {edit.status === "saving" && <span role="status" className={styles.savingText}>Saving…</span>}
              <button type="button" className={styles.linkButton} aria-label="Cancel edit"
                onMouseDown={(e) => { e.preventDefault(); edit.beginCancel(); }} onClick={edit.cancel}>✕</button>
            </div>
          ) : display(def)}
          {fieldError?.field === def.key && (
            <p role="alert" className={styles.error}>
              {fieldError.reason}
              {fieldError.retryable && editing && (
                <> <button type="button" className={styles.linkButton} onClick={() => void edit.commit()}>Retry</button></>
              )}
            </p>
          )}
        </div>
        {def.key === "dtccNumber" && !readOnly && storedDtcc === "" && suggestion?.status === "suggested" && suggestion.dtccNumber && (
          <button type="button" className={styles.suggestion} disabled={applying} onClick={() => void applySuggestion()}>
            Use {suggestion.dtccNumber}
          </button>
        )}
        {def.key === "dtccNumber" && !readOnly && storedDtcc === "" && suggestion?.status === "ambiguous" && (
          <span className={styles.warn}>Conflicting history — review</span>
        )}
      </div>
    );
  }

  const processing: { title: string; fields: readonly DrawerFieldDef[] }[] = [
    { title: "Dates & Monitoring", fields: DATE_FIELDS },
    { title: "Tickets & Resources", fields: ticketFields(transfer.status) },
    { title: "Trade Instructions", fields: TRADE_REQUEST_FIELDS },
  ];

  return (
    <div className={styles.details}>
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>Transfer &amp; Account Details</h3>
          <p className={styles.cardSub}>Key transfer and account facts stay open for quick reference.</p>
        </div>
        {[{ title: "Transfer", fields: TRANSFER_FIELDS }, { title: "Accounts", fields: ACCOUNT_FIELDS }].map((group) => (
          <section key={group.title} className={styles.group}>
            <h4 className={styles.groupTitle}>{group.title}</h4>
            {group.fields.map(row)}
          </section>
        ))}
      </section>
      <section className={styles.card}>
        <button type="button" className={styles.collapseHead} aria-expanded={processingOpen}
          onClick={() => setProcessingOpen((open) => !open)}>
          <span className={styles.cardTitle}>Processing &amp; Instructions</span>
          <span className={styles.cardSub}>Dates, monitoring, tickets, paperwork, and trade direction</span>
        </button>
        {processingOpen && processing.map((group) => (
          <section key={group.title} className={styles.group}>
            <h4 className={styles.groupTitle}>{group.title}</h4>
            {group.fields.map(row)}
          </section>
        ))}
      </section>
    </div>
  );
}
