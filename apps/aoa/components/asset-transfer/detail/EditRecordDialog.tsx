"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { saveTransferCorrection, updateTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import type { TransferFormValues } from "@/components/transfers/transfer-form";
import { TRANSFER_OWNERS, ownerNameOptions, type TransferOwner } from "@/lib/data/transfer-types";
import { WorkspaceDialog, FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";

type FieldName = keyof TransferFormValues;
type Field = { name: FieldName; label: string; type: "text" | "number" | "select" | "textarea"; required?: boolean };
type Group = { key: string; label: string; help: string; fields: Field[] };

const OWNER_LABEL: Record<TransferOwner, string> = { OPERATIONS: "Operations", CLIENT_SERVICE: "Client Service", ADVISOR: "Advisor" };

const GROUPS: Group[] = [
  {
    key: "ownership", label: "Owner & next step", help: "Who owns the record now and the next step they are taking.",
    fields: [
      { name: "owner_kind", label: "Owning team", type: "select", required: true },
      { name: "owner_name", label: "Assigned person", type: "select" },
      { name: "next_step", label: "Next step", type: "text" },
      { name: "next_step_owner", label: "Next step owner", type: "text" },
      { name: "pending_nudge", label: "Pending reminder", type: "textarea" },
    ],
  },
  {
    key: "value", label: "Transfer value", help: "The stored value. A linked deal's amount takes precedence on this page.",
    fields: [{ name: "value", label: "Transfer value (USD)", type: "number", required: true }],
  },
  {
    key: "acat", label: "Linked ACAT", help: "The Transfer Tracker record or transfer id. The link is verified with the tracker before it is saved.",
    fields: [{ name: "acat_transfer_id", label: "ACAT record or transfer id", type: "text" }],
  },
];

function summary(group: Group, values: TransferFormValues): string {
  const shown = group.fields
    .filter(field => field.type !== "textarea" && values[field.name] !== "")
    .slice(0, 3)
    .map(field => `${field.label}: ${field.name === "owner_kind" ? OWNER_LABEL[values.owner_kind as TransferOwner] ?? values.owner_kind : values[field.name]}`);
  return shown.join(" · ") || "Add missing details";
}

export function EditRecordDialog({ transferId, values, canEdit, contextTitle, contextDetail, contextLine }: {
  transferId: string; values: TransferFormValues; canEdit: boolean; contextTitle: string; contextDetail: string; contextLine: string;
}) {
  return (
    <WorkspaceDialog title="Edit transfer details" trigger="Edit record"
      context={<FormTransferContext title={contextTitle} detail={contextDetail} />}>
      {close => <EditRecordBody transferId={transferId} values={values} canEdit={canEdit} contextLine={contextLine} close={close} />}
    </WorkspaceDialog>
  );
}

function EditRecordBody({ transferId, values, canEdit, contextLine, close }: {
  transferId: string; values: TransferFormValues; canEdit: boolean; contextLine: string; close: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const group = GROUPS.find(item => item.key === editing);
  if (editing === "correction") return <CorrectionForm transferId={transferId} contextLine={contextLine} back={() => setEditing(null)} close={close} />;
  if (group) return <GroupForm transferId={transferId} group={group} values={values} contextLine={contextLine} back={() => setEditing(null)} />;
  return (
    <>
      <p>{contextLine}</p>
      <p className="small">Correct saved details or add a missing reference. Each change is kept in History.</p>
      <div className="editable-records">
        {GROUPS.map(item => (
          <article key={item.key}>
            <div><strong>{item.label}</strong><p>{summary(item, values)}</p>{canEdit ? null : <small>Your role can view these details.</small>}</div>
            <button className="btn tiny" type="button" data-edit-record={item.key} disabled={!canEdit} onClick={() => setEditing(item.key)}>Edit</button>
          </article>
        ))}
        <article>
          <div><strong>Correction note</strong><p>Record what was corrected elsewhere so History explains it.</p></div>
          <button className="btn tiny" type="button" data-edit-record="correction" disabled={!canEdit} onClick={() => setEditing("correction")}>Add</button>
        </article>
      </div>
      <p className="small">Funding plan choices are edited in Edit mapping & plan. Stage and outcome changes use Update transfer.</p>
      <div className="row" style={{ marginTop: 16 }}><button className="btn" type="button" onClick={close}>Close</button></div>
    </>
  );
}

function GroupForm({ transferId, group, values, contextLine, back }: {
  transferId: string; group: Group; values: TransferFormValues; contextLine: string; back: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<TransferFormValues>(values);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const set = (name: FieldName, value: string) => setDraft(current => ({ ...current, [name]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);
    startTransition(async () => {
      if (note.trim()) {
        const corrected = await saveTransferCorrection(transferId, { correction: `${group.label}: ${note.trim()}` });
        if (!corrected.ok) { setErrors(corrected.errors.map(error => error.message)); return; }
      }
      const result = await updateTransfer(transferId, draft);
      if (result && !result.ok) { setErrors(result.errors.map(error => error.message)); return; }
      router.refresh();
    });
  };

  const control = (field: Field) => {
    const value = draft[field.name];
    switch (field.type) {
      case "select":
        return field.name === "owner_kind" ? (
          <select name={field.name} value={value} required onChange={event => { set("owner_kind", event.target.value); set("owner_name", ""); }}>
            {TRANSFER_OWNERS.map(owner => <option key={owner} value={owner}>{OWNER_LABEL[owner]}</option>)}
          </select>
        ) : (
          <select name={field.name} value={value} onChange={event => set(field.name, event.target.value)}>
            {ownerNameOptions(draft.owner_kind as TransferOwner, value || null).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        );
      case "textarea":
        return <textarea name={field.name} value={value} maxLength={1000} onChange={event => set(field.name, event.target.value)} />;
      case "number":
        return <input name={field.name} type="number" step="any" min={0} required={field.required} value={value} onChange={event => set(field.name, event.target.value)} />;
      case "text":
        return <input name={field.name} type="text" maxLength={250} required={field.required} value={value} onChange={event => set(field.name, event.target.value)} />;
      default: {
        const unreachable: never = field.type;
        return unreachable;
      }
    }
  };

  return (
    <form id="record-edit-form" onSubmit={submit}>
      <p className="small">{contextLine}</p>
      <h3 style={{ marginTop: 12 }}>Edit {group.label.toLowerCase()}</h3>
      <p>{group.help}</p>
      <div className="record-edit-fields">
        {group.fields.map(field => (
          <div className={`record-edit-field edit-${field.type}`} key={field.name}>
            <label className="field"><span>{field.label}</span>{control(field)}</label>
          </div>
        ))}
      </div>
      <details className="record-edit-context"><summary>Add a change note (optional)</summary>
        <label className="field"><span>Change note</span>
          <textarea name="editNote" maxLength={1000} value={note} placeholder="Add context if helpful" onChange={event => setNote(event.target.value)} />
        </label>
      </details>
      {errors.length ? <p className="upload-error" role="alert">{errors.join(" · ")}</p> : null}
      <div className="row task-detail-actions">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</button>
        <button className="btn" type="button" onClick={back}>Cancel</button>
      </div>
      <p className="small">The original record and who recorded it stay in History. Editing a reference does not repeat the action.</p>
    </form>
  );
}

function CorrectionForm({ transferId, contextLine, back, close }: { transferId: string; contextLine: string; back: () => void; close: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [correction, setCorrection] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);
    startTransition(async () => {
      const result = await saveTransferCorrection(transferId, { correction });
      if (!result.ok) { setErrors(result.errors.map(error => error.message)); return; }
      router.refresh();
      close();
    });
  };
  return (
    <form id="correction-form" onSubmit={submit}>
      <p className="small">{contextLine}</p>
      <label className="field"><span>Correction</span>
        <textarea name="correction" required maxLength={2000} value={correction} placeholder="Describe what was corrected and why."
          onChange={event => setCorrection(event.target.value)} />
      </label>
      <p className="small">The correction is appended to History. Nothing earlier is deleted.</p>
      {errors.length ? <p className="upload-error" role="alert">{errors.join(" · ")}</p> : null}
      <div className="row task-detail-actions">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save correction"}</button>
        <button className="btn" type="button" onClick={back}>Cancel</button>
      </div>
    </form>
  );
}
