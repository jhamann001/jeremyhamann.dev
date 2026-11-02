"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  lineResolved,
  receiptCsv,
  type ReceiptLineDraft,
  type ReceiptLineStatus,
} from "@/lib/transfers/receipt-compare";
import type { ReceiptRecords } from "@/lib/transfers/receipt";
import {
  applyReceiptComparison,
  logTransferSubmission,
  recordTransferTracking,
  sampleReceiptCsv,
  saveTransferReceipt,
  type ReceiptActionResult,
} from "@/app/(authenticated)/asset-transfer/actions";
import { demoMode } from "@/lib/demo/mode";
import { cx } from "@/components/asset-transfer/workspace/ui";
import { FormTransferContext, WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { controlNumberCheck, type ControlNumberCheck } from "@/lib/transfers/connections";

export type ReceiptPanelProps = {
  transferId: string;
  stage: string;
  canRecord: boolean;
  submissionBlockers: string[];
  records: ReceiptRecords;
  resubmissionOpen?: boolean;
  transferContext?: { title: string; detail: string };
  bare?: boolean;
  /** The linked Transfer Tracker record's control number, when the transfer has one. */
  trackerControlNumber?: string | null;
};

function ControlNumberNote({ check }: { check: ControlNumberCheck }) {
  switch (check.state) {
    case "none":
    case "tracker-only":
      return null;
    case "match":
      return <p className="small" data-testid="control-number-check">Matches the Transfer Tracker control number.</p>;
    case "mismatch":
      return (
        <p className="small upload-error" role="status" data-testid="control-number-check">
          The Transfer Tracker records control number {check.tracker}, not {check.typed}. Confirm which Apex returned before saving.
        </p>
      );
    default: {
      const unhandled: never = check;
      return unhandled;
    }
  }
}

export const PARTIAL_UPDATE_TEXT =
  "Partial-arrival client update: some assets have arrived and Operations is following up on the rest.";
export const FULL_ARRIVAL_TEXT = "Full-arrival client notification: all expected assets and cash were verified as arrived.";

type Errors = { field: string; message: string }[];

function firstError(errors: Errors, field?: string): string | null {
  return (field ? errors.find((error) => error.field === field) : errors[0])?.message ?? null;
}

function FieldError({ errors, field }: { errors: Errors; field: string }) {
  const message = firstError(errors, field);
  return message ? <small className="field-error-message">{message}</small> : null;
}

function FormError({ errors }: { errors: Errors }) {
  return <p id="form-error" className="upload-error" role="alert" tabIndex={-1}>{firstError(errors, "form") ?? ""}</p>;
}

function useRecorder(): [boolean, Errors, string | null, (run: () => Promise<ReceiptActionResult>, done?: () => void) => void] {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Errors>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const record = (run: () => Promise<ReceiptActionResult>, done?: () => void) => {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        setErrors([]);
        setNotice(result.stageNotice);
        done?.();
      } else {
        setErrors(result.errors);
      }
    });
  };
  return [pending, errors, notice, record];
}

function contextOf(props: ReceiptPanelProps): ReactNode {
  return props.transferContext
    ? <FormTransferContext title={props.transferContext.title} detail={props.transferContext.detail} />
    : undefined;
}

function DialogButtons({ submit, pending, close }: { submit: string; pending: boolean; close: () => void }) {
  return (
    <div className="row" style={{ marginTop: 16 }}>
      <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : submit}</button>
      <button className="btn" type="button" onClick={close}>Cancel</button>
    </div>
  );
}

function SubmissionLog(props: ReceiptPanelProps) {
  const { transferId, stage, canRecord, submissionBlockers, records, resubmissionOpen } = props;
  const tracker = props.trackerControlNumber?.trim() || null;
  const [controlNumber, setControlNumber] = useState(tracker ?? "");
  const [submittedOn, setSubmittedOn] = useState("");
  const [pending, errors, notice, record] = useRecorder();
  const latest = records.latestSubmission;
  const open = canRecord && (!latest || resubmissionOpen === true) && (stage === "DECISION" || stage === "IN_TRANSFER");
  return (
    <div className="subtle" data-testid="receipt-submission">
      <div className="row between">
        <strong>ACAT submission</strong>
        <span className={cx("badge", latest ? "completed" : "waiting")}>{latest ? "Submitted" : "Not submitted"}</span>
      </div>
      <p>{latest ? `Submitted ${latest.submittedOn} · control number ${latest.controlNumber}` : "No submission logged."}</p>
      {latest ? <ControlNumberNote check={controlNumberCheck(latest.controlNumber, tracker)} /> : null}
      {open && submissionBlockers.length > 0 && (
        <div className="notice" data-testid="receipt-submission-blockers">
          <strong>Resolve before logging the submission</strong>
          <ul>{submissionBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </div>
      )}
      {open && submissionBlockers.length === 0 && (
        <div className="row" style={{ marginTop: 12 }}>
          <WorkspaceDialog title="Log ACAT submission" trigger="Log ACAT submission" triggerStyle={{ primary: true }} context={contextOf(props)}>
            {(close) => (
              <form id="submission-form" onSubmit={(event) => {
                event.preventDefault();
                record(() => logTransferSubmission(transferId, { controlNumber, submittedOn }), close);
              }}>
                <p>Record the ACAT control number Apex returned for this submission.</p>
                <div className="twocol">
                  <label className="field">
                    <span>ACAT control number</span>
                    <input value={controlNumber} maxLength={64} onChange={(event) => setControlNumber(event.target.value)} />
                    {tracker ? <small>Prefilled from the Transfer Tracker.</small> : null}
                    <FieldError errors={errors} field="controlNumber" />
                    <ControlNumberNote check={controlNumberCheck(controlNumber, tracker)} />
                  </label>
                  <label className="field">
                    <span>Submitted on</span>
                    <input type="date" value={submittedOn} onChange={(event) => setSubmittedOn(event.target.value)} />
                    <FieldError errors={errors} field="submittedOn" />
                  </label>
                </div>
                <FormError errors={errors} />
                <DialogButtons submit="Log submission" pending={pending} close={close} />
              </form>
            )}
          </WorkspaceDialog>
        </div>
      )}
      <p className="small" style={{ marginTop: 8 }}>Ops records the submission and monitors its status here.</p>
      {notice && <p className="small" role="status">{notice}</p>}
    </div>
  );
}

function TrackingLog(props: ReceiptPanelProps) {
  const { transferId, stage, canRecord, records } = props;
  const [trackingStage, setTrackingStage] = useState("");
  const [expectedCompletionOn, setExpectedCompletionOn] = useState("");
  const [pending, errors, , record] = useRecorder();
  const latest = records.latestTracking;
  const open = canRecord && stage === "IN_TRANSFER" && records.latestSubmission != null;
  return (
    <div className="subtle" data-testid="receipt-tracking">
      <div className="row between">
        <strong>Tracking</strong>
        <span className={cx("badge", latest ? "progress" : "neutral")}>{latest ? latest.trackingStage : "Not tracked"}</span>
      </div>
      <p>
        {latest
          ? `${latest.trackingStage}${latest.expectedCompletionOn ? ` · expected ${latest.expectedCompletionOn}` : ""}`
          : "No tracking update recorded."}
      </p>
      {open && (
        <div className="row" style={{ marginTop: 12 }}>
          <WorkspaceDialog title="Record tracking update" trigger="Record tracking update" context={contextOf(props)}>
            {(close) => (
              <form id="tracking-form" onSubmit={(event) => {
                event.preventDefault();
                record(() => recordTransferTracking(transferId, { trackingStage, expectedCompletionOn }), () => {
                  setTrackingStage("");
                  setExpectedCompletionOn("");
                  close();
                });
              }}>
                <div className="twocol">
                  <label className="field">
                    <span>Tracking stage</span>
                    <input value={trackingStage} maxLength={80} onChange={(event) => setTrackingStage(event.target.value)} />
                    <FieldError errors={errors} field="trackingStage" />
                  </label>
                  <label className="field">
                    <span>Expected completion (optional)</span>
                    <input type="date" value={expectedCompletionOn} onChange={(event) => setExpectedCompletionOn(event.target.value)} />
                    <FieldError errors={errors} field="expectedCompletionOn" />
                  </label>
                </div>
                <p className="small">An expected date does not count as completion.</p>
                <FormError errors={errors} />
                <DialogButtons submit="Record tracking update" pending={pending} close={close} />
              </form>
            )}
          </WorkspaceDialog>
        </div>
      )}
    </div>
  );
}

function ReceiptReview(props: ReceiptPanelProps) {
  const { transferId, stage, canRecord, records } = props;
  const [lines, setLines] = useState<ReceiptLineDraft[] | null>(null);
  const [verified, setVerified] = useState(false);
  const [nextAction, setNextAction] = useState("");
  const [followUpOwner, setFollowUpOwner] = useState("");
  const [nextCheckOn, setNextCheckOn] = useState("");
  const [comparing, startCompare] = useTransition();
  const [compareError, setCompareError] = useState<string | null>(null);
  const [pending, errors, notice, record] = useRecorder();
  const open = canRecord && stage === "IN_TRANSFER" && records.latestSubmission != null;
  if (!open) return null;

  const compare = async (text: string) => {
    const result = await applyReceiptComparison(transferId, text);
    if (result.ok) {
      setCompareError(null);
      setLines(result.lines);
    } else {
      setCompareError(result.errors[0]?.message ?? "The comparison could not be applied.");
    }
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    startCompare(async () => compare(await file.text()));
  };
  // Demo only: a visitor has no custodian file, so the demo offers one in which everything expected arrived.
  const compareSample = () => {
    startCompare(async () => {
      const sample = await sampleReceiptCsv(transferId);
      if (sample.ok) await compare(sample.csv);
      else setCompareError(sample.errors[0]?.message ?? "The sample receipt could not be made.");
    });
  };
  const update = (lineNumber: number, patch: Partial<ReceiptLineDraft>) => {
    setLines((current) => current?.map((line) => (line.lineNumber === lineNumber ? { ...line, ...patch } : line)) ?? null);
  };
  const unresolved = lines?.filter((line) => !lineResolved(line)).length ?? 0;
  const save = (close: () => void) => {
    if (!lines) return;
    record(() => saveTransferReceipt(transferId, {
      partial: !verified,
      lines: lines.map((line) => ({
        classification: line.classification,
        quantity: line.quantity,
        lineStatus: line.lineStatus,
        variancePercentage: line.variancePercentage,
        reviewNote: line.reviewNote,
        explanation: line.explanation,
      })),
      nextAction,
      followUpOwner,
      nextCheckOn,
    }), () => {
      setLines(null);
      close();
    });
  };
  const latest = records.latestSubmission;

  return (
    <div className="row" data-testid="receipt-review" style={{ marginTop: 14 }}>
      <WorkspaceDialog
        title={records.receipts.length > 0 ? "Update receipt comparison" : "Confirm assets received"}
        trigger={records.receipts.length > 0 ? "Update receipt comparison" : "Confirm assets received"}
        triggerStyle={{ primary: true }}
        className="receipt-dialog"
        context={contextOf(props)}
      >
        {(close) => (
          <form id="receipt-form" onSubmit={(event) => { event.preventDefault(); save(close); }}>
            <div className="receipt-context">
              <div>
                <span className="kicker">Submitted instruction</span>
                <strong>{latest ? `Control number ${latest.controlNumber}` : "No submission logged"}</strong>
                <small>{latest ? `Submitted ${latest.submittedOn}` : ""}</small>
              </div>
              <div>
                <span className="kicker">Receipt review</span>
                <strong>{records.receipts[0] ? `Version ${records.receipts[0].version} saved` : "No receipt review saved"}</strong>
                <small>A new review is saved as the next version.</small>
              </div>
            </div>
            <p>Upload the custodian receipt to fill <strong>posted quantities and cash</strong>, then review each line.</p>
            <div className="receipt-source-grid">
              <article className="receipt-source-card">
                <div className="kicker">Received assets</div>
                <h3>Custodian receipt file</h3>
                <div className="receipt-upload-drop">
                  <label className="btn">
                    <input type="file" accept=".csv,text/csv" disabled={comparing} aria-label="Upload receipt CSV"
                      onChange={(event) => upload(event.target.files?.[0])} />
                    {comparing ? "Comparing…" : "Upload receipt CSV"}
                  </label>
                  {demoMode() && (
                    <button type="button" className="btn" disabled={comparing} onClick={compareSample}>
                      Use the sample receipt
                    </button>
                  )}
                  <p>CSV with Symbol and Quantity columns.</p>
                  <small>A replacement upload replaces the comparison; rows are not added twice.</small>
                </div>
              </article>
            </div>
            <p id="receipt-upload-error" className="upload-error" role="alert">{compareError ?? ""}</p>
            {lines && (
              <>
                <div className="row between receipt-table-heading">
                  <h3>Expected versus received</h3>
                  <span className="small">{unresolved === 0 ? "Every line is resolved." : `${unresolved} line(s) unresolved.`}</span>
                </div>
                <div className="tablewrap receipt-comparison-wrap">
                  <table className="receipt-comparison-table" data-testid="receipt-comparison">
                    <thead>
                      <tr>
                        <th>Asset</th><th>Expected</th><th>Received to date</th><th>Difference</th><th>Status / review</th><th>Explanation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <tr key={line.lineNumber} data-classification={line.classification}>
                          <td><strong>{line.label}</strong><small>{line.classification}</small></td>
                          <td>{line.expectedQuantity ?? "—"}</td>
                          <td>{line.quantity ?? "—"}</td>
                          <td>{line.variancePercentage == null ? "—" : `${line.variancePercentage}%`}</td>
                          <td>
                            <select value={line.lineStatus} aria-label={`Status for line ${line.lineNumber}`}
                              onChange={(event) => update(line.lineNumber, { lineStatus: event.target.value as ReceiptLineStatus })}>
                              <option value="outstanding">Still outstanding</option>
                              <option value="verified">Verified</option>
                            </select>
                            <input value={line.reviewNote} maxLength={2000} placeholder="Review note"
                              aria-label={`Review note for line ${line.lineNumber}`}
                              onChange={(event) => update(line.lineNumber, { reviewNote: event.target.value })} />
                          </td>
                          <td>
                            <input value={line.explanation} maxLength={2000} placeholder="Explanation"
                              aria-label={`Explanation for line ${line.lineNumber}`}
                              onChange={(event) => update(line.lineNumber, { explanation: event.target.value })} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <fieldset role="radiogroup" aria-label="Receipt outcome">
                  <legend>Receipt outcome</legend>
                  <label className="check">
                    <input type="radio" name="receipt-outcome" checked={!verified} onChange={() => setVerified(false)} />
                    Partial arrival — keep the transfer in transfer
                  </label>
                  <label className="check">
                    <input type="radio" name="receipt-outcome" checked={verified} onChange={() => setVerified(true)} />
                    All expected assets/cash verified as arrived
                  </label>
                </fieldset>
                {!verified && (
                  <div className="twocol">
                    <label className="field">
                      <span>Next action</span>
                      <input value={nextAction} maxLength={200} onChange={(event) => setNextAction(event.target.value)} />
                      <FieldError errors={errors} field="nextAction" />
                    </label>
                    <label className="field">
                      <span>Follow-up owner</span>
                      <input value={followUpOwner} maxLength={120} onChange={(event) => setFollowUpOwner(event.target.value)} />
                      <FieldError errors={errors} field="followUpOwner" />
                    </label>
                    <label className="field">
                      <span>Next check date</span>
                      <input type="date" value={nextCheckOn} onChange={(event) => setNextCheckOn(event.target.value)} />
                      <FieldError errors={errors} field="nextCheckOn" />
                    </label>
                  </div>
                )}
                {firstError(errors, "lines") && <p className="upload-error" role="alert">{firstError(errors, "lines")}</p>}
              </>
            )}
            <FormError errors={errors} />
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn primary" type="submit" disabled={pending || !lines}>{pending ? "Saving…" : "Save receipt review"}</button>
              <button className="btn" type="button" onClick={close}>Cancel</button>
            </div>
          </form>
        )}
      </WorkspaceDialog>
      {notice && <p className="small" role="status">{notice}</p>}
    </div>
  );
}

function ReceiptHistory({ records }: Pick<ReceiptPanelProps, "records">) {
  const [latest, ...previous] = records.receipts;
  if (!latest) return null;
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(receiptCsv(latest.lines))}`;
  return (
    <div className="subtle" data-testid="receipt-history">
      <div className="row between">
        <strong>Receipt review · version {latest.version}</strong>
        <span className={cx("badge", latest.partial ? "waiting" : "completed")}>{latest.partial ? "Partial arrival" : "Verified as arrived"}</span>
      </div>
      {latest.partial ? (
        <>
          <p data-testid="receipt-partial-update">{PARTIAL_UPDATE_TEXT}</p>
          <p className="small">
            Next action: {latest.nextAction} · owner {latest.followUpOwner} · check {latest.nextCheckOn}
          </p>
        </>
      ) : (
        <p data-testid="receipt-full-arrival">{FULL_ARRIVAL_TEXT}</p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <a className="btn tiny" href={href} download={`receipt-v${latest.version}.csv`}>Download receipt review</a>
      </div>
      {previous.length > 0 && (
        <details>
          <summary>Previous receipt versions ({previous.length})</summary>
          {previous.map((receipt) => (
            <p key={receipt.version} className="small">
              Version {receipt.version} · {receipt.partial ? "partial" : "verified"} · {receipt.lines.length} line(s)
              · recorded {receipt.recordedAt.slice(0, 10)}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

export function ReceiptPanel(props: ReceiptPanelProps) {
  const body = (
    <div style={{ display: "grid", gap: 12 }}>
      <SubmissionLog {...props} />
      <TrackingLog {...props} />
      <ReceiptHistory records={props.records} />
      <ReceiptReview {...props} />
    </div>
  );
  return props.bare ? body : <div className="sectionbody">{body}</div>;
}
