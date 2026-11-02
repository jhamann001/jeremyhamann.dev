"use client";

import { useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { saveAcatBookRecord } from "@/app/(authenticated)/acat-tracking/book-actions";
import { resolveAcatBookStatus, type AcatBookRow } from "@/lib/data/acat-book";
import {
  ACAT_CLIENT_REQUIRED,
  draftFromRow,
  editorAfterResult,
  isLifecycleStatus,
  keepUnsentText,
  lifecycleStatusOptions,
  type AcatEditableField,
  type AcatEditorState,
} from "@/lib/data/acat-book-edit";
import { textEditKey } from "@/lib/data/acat-create-contract";
import styles from "./AcatBookActions.module.css";

const DETAIL_LABELS: Record<Exclude<AcatEditableField, "status">, string> = {
  controlNumber: "Control #",
  direction: "Direction",
  type: "Type",
  transferringContra: "Contra",
  wealthAdvisor: "Wealth advisor",
  feeCharged: "Fee charged",
  feeRequestCompleted: "Fee request completed",
};

function StatusSelect({ id, value, current, onChange }: {
  id: string; value: string; current: string | null; onChange: (value: string) => void;
}) {
  const stuck = current && !isLifecycleStatus(current) ? current : null;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {stuck && <option value={stuck} disabled>{resolveAcatBookStatus(stuck).label}</option>}
      {!stuck && value === "" && <option value="" disabled>Choose a status</option>}
      {lifecycleStatusOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

type TextField = "notes" | "tradeInstructions";
const TEXT_LABELS: Record<TextField, { title: string; edit: string }> = {
  notes: { title: "Notes", edit: "Edit notes" },
  tradeInstructions: { title: "Trade instructions", edit: "Edit trade instructions" },
};

function ClickToEditText({ row, field, onSaved }: {
  row: AcatBookRow; field: TextField; onSaved: (row: AcatBookRow) => void;
}) {
  const [stored, setStored] = useState(row[field] ?? "");
  const [buffer, setBuffer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const label = TEXT_LABELS[field];

  function begin() {
    setBuffer(stored);
    setError(null);
  }

  function commit() {
    if (buffer === null) return;
    if (buffer === stored) { setBuffer(null); return; }
    const sent = buffer;
    startTransition(async () => {
      const result = await saveAcatBookRecord(row, { ...draftFromRow(row), [field]: sent });
      if (!result.ok) {
        setError(result.reason);
        setBuffer(keepUnsentText(stored, sent, false));
        return;
      }
      setError(null);
      setStored(keepUnsentText(result.row[field] ?? "", sent, true));
      setBuffer(null);
      onSaved(result.row);
    });
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (textEditKey(event.key, true) === "cancel") {
      event.preventDefault();
      setBuffer(null);
      setError(null);
    }
  }

  return (
    <div className={styles.field}>
      {label.title}
      {buffer === null ? (
        <div role="button" tabIndex={0} aria-label={label.edit} className={styles.textButton}
          onClick={begin}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); begin(); } }}>
          {stored || <span className={styles.placeholder}>Click to add</span>}
        </div>
      ) : (
        <textarea autoFocus aria-label={label.title} value={buffer} disabled={pending}
          onChange={(e) => setBuffer(e.target.value)} onBlur={commit} onKeyDown={onKey} />
      )}
      {pending && <span role="status">Saving</span>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  );
}

export function AcatRecordEditor({ row, onSaved, dayToDay = false }: {
  row: AcatBookRow; onSaved: (row: AcatBookRow) => void; dayToDay?: boolean;
}) {
  const [state, setState] = useState<AcatEditorState>(() => ({ draft: draftFromRow(row), error: null }));
  const [pending, startTransition] = useTransition();
  const showText = dayToDay && !row.textLoadError;
  const set = (field: AcatEditableField, value: string) =>
    setState((s) => ({ ...s, draft: { ...s.draft, [field]: value } }));

  function submit(event: FormEvent) {
    event.preventDefault();
    const sent = { ...state.draft };
    startTransition(async () => {
      const result = await saveAcatBookRecord(row, sent);
      setState((s) => editorAfterResult({ ...s, draft: state.draft }, result));
      if (!result.ok) return;
      onSaved(result.row);
    });
  }

  return (
    <>
      <form className={styles.form} onSubmit={submit} aria-label="Edit transfer">
        <label className={styles.field} htmlFor={`status-${row.id}`}>
          Status
          <StatusSelect id={`status-${row.id}`} value={state.draft.status} current={row.status}
            onChange={(value) => set("status", value)} />
        </label>
        {(Object.keys(DETAIL_LABELS) as (keyof typeof DETAIL_LABELS)[]).map((field) => (
          <label key={field} className={styles.field}>
            {DETAIL_LABELS[field]}
            <input value={state.draft[field]} onChange={(e) => set(field, e.target.value)} />
          </label>
        ))}
        {dayToDay && row.textLoadError && <p role="alert" className={styles.error}>{row.textLoadError}</p>}
        {state.error && <p role="alert" className={styles.error}>{state.error}</p>}
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={pending}>{pending ? "Saving…" : "Save"}</button>
        </div>
      </form>
      {showText && (
        <div className={styles.form}>
          <ClickToEditText row={row} field="notes" onSaved={onSaved} />
          <ClickToEditText row={row} field="tradeInstructions" onSaved={onSaved} />
        </div>
      )}
    </>
  );
}

export function createRequestFor(
  selected: { cedarRidgeUserId: string } | null,
  apexAccountId: string,
): { ok: true; body: { cedarRidgeUserId: string; apexAccountId: string } } | { ok: false; reason: string } {
  if (!selected) return { ok: false, reason: ACAT_CLIENT_REQUIRED };
  return { ok: true, body: { cedarRidgeUserId: selected.cedarRidgeUserId, apexAccountId } };
}
