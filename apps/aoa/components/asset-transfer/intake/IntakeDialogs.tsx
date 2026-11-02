"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { cx } from "@/components/asset-transfer/workspace/ui";
import { easternToday } from "@/lib/transfers/eastern-day";
import { demoMode } from "@/lib/demo/mode";
import {
  DEMO_SAMPLE_STATEMENT_FILENAME,
  STATEMENT_ACCEPT,
  STATEMENT_MESSAGES,
  STATEMENT_REVIEW_OPTIONS,
  statementFileProblem,
  statementSizeLabel,
  type StatementReviewOption,
} from "@/lib/transfers/statement-document";

export type IntakeFormState = { errors: string[]; saved?: number };
export type IntakeAction = (previous: IntakeFormState, formData: FormData) => Promise<IntakeFormState>;

const INITIAL: IntakeFormState = { errors: [] };

function FormError({ state }: { state: IntakeFormState }) {
  return <p className="upload-error" role="alert" tabIndex={-1}>{state.errors[0] ?? ""}</p>;
}

/** `updateTransfer` only redirects when a transfer field changes, so a saved intake fact closes and refreshes here. */
function useCloseOnSave(state: IntakeFormState, close: () => void) {
  const router = useRouter();
  useEffect(() => {
    if (state.saved === undefined) return;
    close();
    router.refresh();
  }, [state.saved, close, router]);
}

function FormButtons({ submit, pending, close }: { submit: string; pending: boolean; close: () => void }) {
  return (
    <div className="row" style={{ marginTop: 16 }}>
      <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : submit}</button>
      <button className="btn" type="button" onClick={close}>Cancel</button>
    </div>
  );
}

export type PendingStatementFile = { id: string; filename: string; byteSize: number; statementDate: string };

type StatementSelection =
  | { kind: "none" }
  | { kind: "file"; file: File }
  | { kind: "sample" }
  | { kind: "stored"; pending: PendingStatementFile };

function StatementUploadForm({ transferId, version, provided, pending, close }: {
  transferId: string;
  version: string;
  provided: boolean;
  pending: PendingStatementFile | null;
  close: () => void;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<StatementSelection>(pending ? { kind: "stored", pending } : { kind: "none" });
  const [date, setDate] = useState(pending?.statementDate ?? "");
  const [review, setReview] = useState<StatementReviewOption>("pending");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);

  function choose(file: File | undefined) {
    const problem = statementFileProblem(file?.name, file?.size);
    if (!file || problem) {
      setSelection({ kind: "none" });
      setError(problem ?? STATEMENT_MESSAGES.badFile);
      return;
    }
    setSelection({ kind: "file", file });
    setError("");
    setReview("pending");
    setDate("");
  }

  // Demo only: the server stores no visitor files, so the demo offers its sample statement in place of an upload.
  function chooseSample() {
    setSelection({ kind: "sample" });
    setError("");
    setReview("pending");
    setDate("");
  }

  function remove() {
    setSelection({ kind: "none" });
    if (input.current) input.current.value = "";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selection.kind === "none") { setError(STATEMENT_MESSAGES.noFile); return; }
    const body = new FormData();
    body.set("version", version);
    body.set("statementDate", date);
    body.set("review", review);
    if (selection.kind === "file") body.set("file", selection.file);
    else if (selection.kind === "sample") body.set("sample", "1");
    else body.set("documentId", selection.pending.id);
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/asset-transfer/${encodeURIComponent(transferId)}/statements`, { method: "POST", body });
      const result = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!response.ok || !result?.ok) { setError(result?.message ?? STATEMENT_MESSAGES.unavailable); return; }
      close();
      router.refresh();
    } catch {
      setError(STATEMENT_MESSAGES.unavailable);
    } finally {
      setSaving(false);
    }
  }

  const reviewOnly = selection.kind === "stored";
  const chosen = selection.kind === "file"
    ? { name: selection.file.name, note: `${statementSizeLabel(selection.file.size)} · selected locally` }
    : selection.kind === "stored"
      ? { name: selection.pending.filename, note: `${statementSizeLabel(selection.pending.byteSize)} · stored statement` }
      : selection.kind === "sample"
        ? { name: DEMO_SAMPLE_STATEMENT_FILENAME, note: "Sample statement · provided by the demo" }
        : null;
  return (
    <form id="statement-form" onSubmit={submit} aria-label="Statement">
      {demoMode() ? (
        <div className="upload-zone" id="statement-demo-sample">
          <strong>Uploads are off in the demo</strong>
          <span>Files from visitors aren&apos;t stored here. Use the sample statement to try the review.</span>
          <button className="btn" type="button" onClick={chooseSample}>Use the sample statement</button>
        </div>
      ) : (
        <label className={cx("upload-zone", dragging && "dragging")} htmlFor="statement-file"
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}>
          <span className="upload-icon" aria-hidden="true">↑</span>
          <strong>{provided ? "Drop an updated statement here" : "Drop a statement here"}</strong>
          <span>PDF, JPG or PNG</span>
          <span className="btn">Choose file</span>
          <input ref={input} id="statement-file" className="file-input" type="file" accept={STATEMENT_ACCEPT}
            aria-label="Choose statement file" onChange={(event) => choose(event.target.files?.[0])} />
        </label>
      )}
      <div className="upload-selection" id="statement-selection" role="status" hidden={!chosen}>
        {chosen && (
          <>
            <div><strong>{chosen.name}</strong><small>{chosen.note}</small></div>
            <button className="btn quiet tiny" type="button" onClick={remove}>Remove</button>
          </>
        )}
      </div>
      <p id="statement-upload-error" className="upload-error" role="alert">{error}</p>
      <div className="twocol">
        <label className="field">
          <span>Statement date</span>
          <input id="statement-date" name="date" type="date" required max={easternToday()} value={date}
            onChange={(event) => setDate(event.target.value)} />
        </label>
        <label className="field">
          <span>Statement review</span>
          <select id="statement-review" name="acceptable" value={review}
            onChange={(event) => setReview(event.target.value as StatementReviewOption)}>
            {STATEMENT_REVIEW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <p className="small">
        Adding a file does not clear the blocker until its statement review is accepted. The updated statement will need fresh asset mapping.
      </p>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" id="statement-save" type="submit" disabled={!chosen || !date || saving}>
          {saving ? "Saving…" : reviewOnly ? "Save statement review" : "Add statement"}
        </button>
        <button className="btn" type="button" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** The mockup's "Add a statement" / "Add an updated statement" dialog with file upload, date and review. */
export function StatementDialog({ transferId, version, title, trigger, triggerDisabled, triggerTitle, source, current, provided, pending }: {
  transferId: string;
  version: string;
  title: string;
  trigger: string;
  triggerDisabled?: boolean;
  triggerTitle?: string;
  /** Client, institution, type and last four, as in the mockup's first line. */
  source: { client: string; detail: string };
  current: { name: string; detail: string };
  provided: boolean;
  pending: PendingStatementFile | null;
}) {
  return (
    <WorkspaceDialog key={version} title={title} trigger={trigger} triggerDisabled={triggerDisabled} triggerTitle={triggerTitle}>
      {(close) => (
        <>
          <p><strong>{source.client}</strong>{source.detail ? ` · ${source.detail}` : ""}</p>
          <div className="subtle">
            <div className="kicker">Current statement</div>
            <strong>{current.name}</strong>
            <p>{current.detail}</p>
          </div>
          <StatementUploadForm transferId={transferId} version={version} provided={provided} pending={pending} close={close} />
        </>
      )}
    </WorkspaceDialog>
  );
}

function AccountTypesForm({ action, delivering, receiving, accountTypes, close }: {
  action: IntakeAction; delivering: string; receiving: string; accountTypes: readonly string[]; close: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  useCloseOnSave(state, close);
  return (
    <form action={formAction} aria-label="Account types">
      <p>Record the delivering and receiving registrations. Full ACAT and Partial ACAT need them to match.</p>
      <div className="twocol">
        <label className="field">
          <span>Delivering account type</span>
          <input name="delivering" list="transfer-account-types" defaultValue={delivering} required />
        </label>
        <label className="field">
          <span>Receiving account type</span>
          <input name="receiving" list="transfer-account-types" defaultValue={receiving} required />
        </label>
      </div>
      <datalist id="transfer-account-types">
        {accountTypes.map((type) => <option key={type} value={type} />)}
      </datalist>
      <FormError state={state} />
      <FormButtons submit="Save account types & recheck" pending={pending} close={close} />
    </form>
  );
}

/** The mockup's "Review receiving account" dialog for the recorded account types. */
export function AccountTypesDialog({ action, version, delivering, receiving, accountTypes, context }: {
  action: IntakeAction;
  version: string;
  delivering: string;
  receiving: string;
  accountTypes: readonly string[];
  context?: ReactNode;
}) {
  return (
    <WorkspaceDialog key={version} title="Review account types" trigger="Review account types" triggerStyle={{ tiny: true }} context={context}>
      {(close) => (
        <AccountTypesForm action={action} delivering={delivering} receiving={receiving} accountTypes={accountTypes} close={close} />
      )}
    </WorkspaceDialog>
  );
}
