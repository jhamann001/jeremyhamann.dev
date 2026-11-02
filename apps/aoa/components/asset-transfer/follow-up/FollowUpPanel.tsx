"use client";

import { DemoRecordLink } from "@/components/demo/DemoRecordLink";
import { otherDemoLinks } from "@/lib/demo/links";
import { useState, useTransition, type ReactNode } from "react";
import type { FollowUpRecords } from "@/lib/transfers/follow-up";
import {
  acceptAcatRejection,
  respondToAcatRejection,
  saveAcatRejection,
  saveFeeReimbursement,
  saveInvestmentLink,
  saveResidual,
  type FollowUpActionResult,
} from "@/app/(authenticated)/asset-transfer/actions";
import { btnClass, cx, type BadgeTone } from "@/components/asset-transfer/workspace/ui";
import { trackingDate } from "@/components/asset-transfer/detail/detail-model";
import { easternToday } from "@/lib/transfers/eastern-day";
import { FormTransferContext, WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import {
  feeRequestLabel,
  tradeRequestLabel,
  type ClientFeeRequests,
  type ClientTradeRequests,
} from "@/lib/transfers/connections";

/** Which part renders: the mockup splits rejection/residual (Movement) from fee/investment (Follow-up & history). */
export type FollowUpPart = "all" | "movement" | "followups";

export type FollowUpPanelProps = {
  transferId: string;
  isAcat: boolean;
  canRecordOperations: boolean;
  canRespond: boolean;
  records: FollowUpRecords;
  part?: FollowUpPart;
  transferContext?: { title: string; detail: string };
  bare?: boolean;
  /** Server-rendered fee workflow for the workspace; legacy page retains its existing form. */
  feeReview?: ReactNode;
  /** The linked client's Operations fee requests and Trade Requests to choose from. */
  feeRequests?: ClientFeeRequests;
  tradeRequests?: ClientTradeRequests;
};

const UNAVAILABLE = { state: "unavailable" } as const;

function unavailableNote(state: "unlinked" | "unavailable", what: string): string {
  return state === "unlinked"
    ? `Link the transfer to a directory client to choose from the client's ${what}.`
    : `The client's ${what} could not be read. Try again later.`;
}

export const RESIDUAL_UNVERIFIED = "Posted cash or securities on a residual stay unverified until a receipt review is saved.";
export const ARRIVAL_PAUSED_NOTE = "Arrival confirmation is paused until the rejection is resolved and a new submission is logged.";

type Errors = { field: string; message: string }[];
type Rejection = FollowUpRecords["rejections"][number];

function useRecorder(): [boolean, Errors, (run: () => Promise<FollowUpActionResult>, done?: () => void) => void] {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Errors>([]);
  const record = (run: () => Promise<FollowUpActionResult>, done?: () => void) => {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        setErrors([]);
        done?.();
      } else {
        setErrors(result.errors);
      }
    });
  };
  return [pending, errors, record];
}

function FormError({ errors }: { errors: Errors }) {
  return <p id="form-error" className="upload-error" role="alert" tabIndex={-1}>{errors[0]?.message ?? ""}</p>;
}

function DialogButtons({ submit, pending, close }: { submit: string; pending: boolean; close: () => void }) {
  return (
    <div className="row" style={{ marginTop: 16 }}>
      <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : submit}</button>
      <button className="btn" type="button" onClick={close}>Cancel</button>
    </div>
  );
}

function contextOf(props: FollowUpPanelProps): ReactNode {
  return props.transferContext
    ? <FormTransferContext title={props.transferContext.title} detail={props.transferContext.detail} />
    : undefined;
}

function stateLabel(state: Rejection["state"]): string {
  switch (state) {
    case "open":
      return "Open · waiting on the follow-up owner";
    case "awaiting_review":
      return "Awaiting Operations review";
    case "accepted":
      return "Resolution accepted";
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

function rejectionHeading(row: Rejection): { title: string; tone: BadgeTone; badge: string } {
  switch (row.state) {
    case "open":
      return { title: "ACAT rejected · follow-up needed", tone: "blocked", badge: row.followUpOwner };
    case "awaiting_review":
      return { title: "ACAT rejected · response ready for Ops", tone: "blocked", badge: "Ops approval needed" };
    case "accepted":
      return { title: "Rejection resolved · prepare resubmission", tone: "completed", badge: "Resolved" };
    default: {
      const unhandled: never = row.state;
      return unhandled;
    }
  }
}

function Rejections(props: FollowUpPanelProps) {
  const { transferId, canRecordOperations, canRespond, records } = props;
  const [owner, setOwner] = useState("");
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [rejectedOn, setRejectedOn] = useState(easternToday);
  const [response, setResponse] = useState("");
  const [pending, errors, record] = useRecorder();
  const latest = records.rejections[0] ?? null;
  const canRecordRejection = canRecordOperations && (latest == null || latest.state === "accepted") && records.controlNumbers.length > 0;
  const recordDialog = canRecordRejection && (
    <WorkspaceDialog title="Record ACAT rejection" trigger="Record ACAT rejection" triggerStyle={{ tiny: true }} context={contextOf(props)}>
      {(close) => (
        <form id="acat-rejection-form" onSubmit={(event) => {
          event.preventDefault();
          record(() => saveAcatRejection(transferId, { followUpOwner: owner, reason, code, rejectedOn }), () => {
            setOwner(""); setReason(""); setCode(""); close();
          });
        }}>
          <p>Record a rejection against control number <b>{records.controlNumbers[0]}</b>.</p>
          <div className="twocol">
            <label className="field">
              <span>Rejection date</span>
              <input type="date" required value={rejectedOn} onChange={(event) => setRejectedOn(event.target.value)} />
            </label>
            <label className="field">
              <span>Rejection code (optional)</span>
              <input value={code} maxLength={120} onChange={(event) => setCode(event.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Rejection reason</span>
            <textarea required value={reason} maxLength={1000} rows={3}
              placeholder="Enter the reason supplied by Apex or the delivering firm."
              onChange={(event) => setReason(event.target.value)} />
          </label>
          <label className="field">
            <span>Follow-up owner</span>
            <input required value={owner} maxLength={120} onChange={(event) => setOwner(event.target.value)} />
          </label>
          <p className="small">The rejected attempt stays in history. Arrival confirmation is paused until the rejection is resolved and a new submission is logged.</p>
          <FormError errors={errors} />
          <DialogButtons submit="Record ACAT rejection" pending={pending} close={close} />
        </form>
      )}
    </WorkspaceDialog>
  );
  const heading = latest ? rejectionHeading(latest) : null;
  return (
    <div data-testid="follow-up-rejections">
      {records.arrivalPaused && (
        <div className="notice" data-testid="follow-up-arrival-paused"><strong>Arrival confirmation paused</strong><p>{ARRIVAL_PAUSED_NOTE}</p></div>
      )}
      {latest && heading ? (
        <div className={cx("rejection-panel", latest.state === "accepted" && "resolved")} role="note" aria-label="ACAT rejection">
          <div className="row between">
            <strong>{heading.title}</strong>
            <span className={cx("badge", heading.tone)}>{heading.badge}</span>
          </div>
          {latest.reason && <p><b>Reason:</b> {latest.reason}{latest.code ? ` · Code ${latest.code}` : ""}</p>}
          <p><b>Follow-up owner:</b> {latest.followUpOwner}</p>
          {latest.response && <p><b>Response:</b> {latest.response}</p>}
          <small>Rejected {trackingDate(latest.rejectedOn ?? latest.recordedAt)} · {stateLabel(latest.state)}</small>
          <div className="row" style={{ marginTop: 12 }}>
            {canRespond && latest.state === "open" && (
              <WorkspaceDialog title="Record rejection follow-up" trigger="Record follow-up response" context={contextOf(props)}>
                {(close) => (
                  <form id="rejection-response-form" onSubmit={(event) => {
                    event.preventDefault();
                    record(() => respondToAcatRejection(transferId, { response }), () => { setResponse(""); close(); });
                  }}>
                    <div className="subtle"><p><b>Follow-up owner:</b> {latest.followUpOwner}</p></div>
                    <label className="field">
                      <span>Correction / returned information</span>
                      <textarea value={response} maxLength={2000} rows={3}
                        placeholder="Record what was corrected or the information returned for Ops review."
                        onChange={(event) => setResponse(event.target.value)} />
                    </label>
                    <p className="small">Make the applicable updates on the transfer as well. This note sends the follow-up to Ops for review.</p>
                    <FormError errors={errors} />
                    <DialogButtons submit="Send response to Ops" pending={pending} close={close} />
                  </form>
                )}
              </WorkspaceDialog>
            )}
            {canRecordOperations && latest.state === "awaiting_review" && (
              <WorkspaceDialog title="Review rejection resolution" trigger="Review rejection resolution" context={contextOf(props)}>
                {(close) => (
                  <form id="rejection-resolution-form" onSubmit={(event) => {
                    event.preventDefault();
                    record(() => acceptAcatRejection(transferId), close);
                  }}>
                    <div className="subtle"><p><b>Response:</b> {latest.response}</p></div>
                    <p className="small">Accepting the resolution reopens the submission path. The normal statement, account, mapping and approval checks still apply.</p>
                    <FormError errors={errors} />
                    <DialogButtons submit="Accept resolution" pending={pending} close={close} />
                  </form>
                )}
              </WorkspaceDialog>
            )}
            {recordDialog}
          </div>
          <p className="small">
            {latest.state === "accepted"
              ? "The normal statement, account, mapping, authorization, and Ops review checks still apply."
              : latest.state === "awaiting_review"
                ? "Ops reviews the correction before the transfer can be resubmitted."
                : "Update any affected statement, account details, funding plan, or paperwork. Independent work can continue."}
          </p>
        </div>
      ) : (
        <section className="residual-section residual-section--empty" aria-label="ACAT rejections">
          <div className="residual-section-heading">
            <div className="residual-empty-summary"><h3>ACAT rejections</h3><span className="small">No rejection recorded</span></div>
            {recordDialog}
          </div>
        </section>
      )}
      {records.rejections.length > 1 && (
        <details className="rejection-history">
          <summary>Rejected ACAT attempts ({records.rejections.length})</summary>
          {records.rejections.map((row) => (
            <article key={row.recordedAt} className="subtle">
              <div className="row between">
                <strong>Rejected {trackingDate(row.rejectedOn ?? row.recordedAt)}</strong>
                <span className={cx("badge", rejectionHeading(row).tone)}>{stateLabel(row.state)}</span>
              </div>
              <p><b>{row.followUpOwner}</b></p>
              {row.response && <p><b>Response:</b> {row.response}</p>}
            </article>
          ))}
        </details>
      )}
    </div>
  );
}

function Residuals(props: FollowUpPanelProps) {
  const { transferId, canRecordOperations, records } = props;
  const [controlNumber, setControlNumber] = useState(records.controlNumbers[0] ?? "");
  const [trackerStage, setTrackerStage] = useState("");
  const [pending, errors, record] = useRecorder();
  const hasCore = records.controlNumbers.length > 0;
  const add = (
    <WorkspaceDialog
      title="Add recorded residual ACAT"
      trigger="Add recorded residual"
      triggerStyle={{ tiny: true }}
      triggerDisabled={!canRecordOperations || !hasCore}
      triggerTitle={!canRecordOperations
        ? "Operations records residual tracking and reviews posted receipt"
        : hasCore ? undefined : "Record the original ACAT control number first"}
      context={contextOf(props)}
    >
      {(close) => (
        <form id="residual-acat-form" onSubmit={(event) => {
          event.preventDefault();
          record(() => saveResidual(transferId, { originalControlNumber: controlNumber, trackerStage }), () => { setTrackerStage(""); close(); });
        }}>
          <p className="small residual-form-intro">Record an automatic residual shown by Apex. This does not initiate or submit an ACAT.</p>
          <div className="residual-form-fields">
            <label className="field">
              <span>Original ACAT control</span>
              <select value={controlNumber} onChange={(event) => setControlNumber(event.target.value)}>
                {records.controlNumbers.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Transfer Tracker stage (optional)</span>
              <input value={trackerStage} maxLength={80} onChange={(event) => setTrackerStage(event.target.value)} />
            </label>
          </div>
          <p className="small">{RESIDUAL_UNVERIFIED}</p>
          <FormError errors={errors} />
          <DialogButtons submit="Record residual" pending={pending} close={close} />
        </form>
      )}
    </WorkspaceDialog>
  );
  if (records.residuals.length === 0) {
    return (
      <section className="residual-section residual-section--empty" id="residual-acats" data-testid="follow-up-residuals">
        <div className="residual-section-heading">
          <div className="residual-empty-summary"><h3>Residual ACATs</h3><span className="small">No recorded residuals</span></div>
          {add}
        </div>
      </section>
    );
  }
  return (
    <section className="residual-section" id="residual-acats" data-testid="follow-up-residuals">
      <div className="residual-section-heading">
        <div><h3>Residual ACATs</h3><p className="small">Automatic follow-on transfers stay tied to the original ACAT.</p></div>
        {add}
      </div>
      {records.residuals.map((row) => (
        <article key={row.recordedAt} className="residual-record">
          <header className="residual-record-heading">
            <div>
              <span className="kicker">Automatically initiated</span>
              <div className="residual-record-title">
                <strong className="residual-amount">Residual recorded {row.recordedAt.slice(0, 10)}</strong>
                <span className="badge waiting">{row.trackerStage ?? "Stage not recorded"}</span>
              </div>
            </div>
          </header>
          <dl className="residual-control-details">
            <div><dt>Original ACAT control</dt><dd>{row.originalControlNumber}</dd></div>
          </dl>
        </article>
      ))}
      <p className="small residual-evidence-note">{RESIDUAL_UNVERIFIED}</p>
    </section>
  );
}

function FeeAndInvestment(props: FollowUpPanelProps) {
  const { transferId, canRecordOperations, records } = props;
  const feeRequests = props.feeRequests ?? UNAVAILABLE;
  const tradeRequests = props.tradeRequests ?? UNAVAILABLE;
  const [evidenced, setEvidenced] = useState(false);
  const [feeRequestId, setFeeRequestId] = useState("");
  const [requestId, setRequestId] = useState("");
  const feeLabel = (id: string | null) =>
    id && feeRequests.state === "ready" ? feeRequests.requests.find((request) => request.id === id) : undefined;
  const [pending, errors, record] = useRecorder();
  const fees = records.feeReimbursements;
  return (
    <div className="followup-checklist" data-testid="follow-up-fee-investment">
      {props.feeReview}
      <article className="followup-check">
        <div className="followup-check-copy">
          <div className="followup-check-heading">
            <strong>{props.feeReview ? "Fee reimbursement record" : "Fee review"}</strong>
            <span className={cx("badge", fees.length > 0 ? "completed" : "waiting")}>{fees.length > 0 ? "Reimbursement recorded" : "Fee check needed"}</span>
          </div>
          <p>
            {fees.length === 0
              ? "No fee reimbursement recorded."
              : `Evidenced fee reimbursed · ${fees.length} record(s), latest ${fees[0].recordedAt.slice(0, 10)}`}
          </p>
          {fees.map((fee, index) => fee.feeRequestId ? (
            <p className="small" key={`${fee.recordedAt}-${index}`} data-testid="follow-up-fee-request">
              Reimburses {(() => { const request = feeLabel(fee.feeRequestId); return request ? feeRequestLabel(request) : "an Operations fee request"; })()}
            </p>
          ) : null)}
        </div>
        {canRecordOperations && (
          <div className="followup-check-actions">
            <WorkspaceDialog title="Record fee reimbursement" trigger="Record fee reimbursement" context={contextOf(props)}>
              {(close) => (
                <form id="fee-reimbursement-form" onSubmit={(event) => {
                  event.preventDefault();
                  record(() => saveFeeReimbursement(transferId, { evidenced, feeRequestId }), () => { setEvidenced(false); setFeeRequestId(""); close(); });
                }}>
                  {feeRequests.state === "ready" ? (
                    <label className="field">
                      <span>Operations fee request</span>
                      <select value={feeRequestId} required onChange={(event) => setFeeRequestId(event.target.value)}>
                        <option value="" disabled>{feeRequests.requests.length ? "Choose the fee request" : "No fee requests on file"}</option>
                        {feeRequests.requests.map((request) => <option key={request.id} value={request.id}>{feeRequestLabel(request)}</option>)}
                      </select>
                    </label>
                  ) : <p className="small">{unavailableNote(feeRequests.state, "Operations fee requests")}</p>}
                  {feeRequests.state === "ready" && feeRequests.truncated ? <p className="small">Showing the newest fee requests only.</p> : null}
                  <label className="check">
                    <input type="checkbox" checked={evidenced} onChange={(event) => setEvidenced(event.target.checked)} />
                    Fee evidence is on file
                  </label>
                  <p className="small">Reimbursement is recorded only with fee evidence on file.</p>
                  <FormError errors={errors} />
                  <DialogButtons submit="Record fee reimbursement" pending={pending} close={close} />
                </form>
              )}
            </WorkspaceDialog>
          </div>
        )}
      </article>
      <article className="followup-check">
        <div className="followup-check-copy">
          <div className="followup-check-heading">
            <strong>Trade instructions</strong>
            <span className={cx("badge", records.investmentRequestId ? "completed" : "neutral")}>
              {records.investmentRequestId ? "Approved request linked" : "Not linked"}
            </span>
          </div>
          {records.investmentRequestId ? (
            <p data-testid="follow-up-investment-link">
              Linked investment request: {records.investmentRequestId} · approval and allocation are edited in Trade Requests
            </p>
          ) : (
            <p>No Trade Requests record linked to this transfer.</p>
          )}
        </div>
        <div className="followup-check-actions">
          {records.investmentRequestId ? (
            <>
              <a className={btnClass()} href={`/trade-requests/${encodeURIComponent(records.investmentRequestId)}`}>View trade instructions</a>
              <DemoRecordLink href={otherDemoLinks.tradeRequest(records.investmentRequestId)} demo="Trade Request" />
            </>
          ) : canRecordOperations ? (
            <WorkspaceDialog title="Link investment request" trigger="Link investment request" context={contextOf(props)}>
              {(close) => (
                <form id="investment-link-form" onSubmit={(event) => {
                  event.preventDefault();
                  record(() => saveInvestmentLink(transferId, { requestId }), () => { setRequestId(""); close(); });
                }}>
                  {tradeRequests.state === "ready" ? (
                    <label className="field">
                      <span>Trade request</span>
                      <select value={requestId} required onChange={(event) => setRequestId(event.target.value)}>
                        <option value="" disabled>{tradeRequests.requests.length ? "Choose the trade request" : "No Trade Requests for this client"}</option>
                        {tradeRequests.requests.map((request) => <option key={request.id} value={request.id}>{tradeRequestLabel(request)}</option>)}
                      </select>
                    </label>
                  ) : <p className="small">{unavailableNote(tradeRequests.state, "Trade Requests")}</p>}
                  <p className="small">Approval and allocation stay in Trade Requests; this links the record to the transfer.</p>
                  <FormError errors={errors} />
                  <DialogButtons submit="Link investment request" pending={pending} close={close} />
                </form>
              )}
            </WorkspaceDialog>
          ) : null}
        </div>
      </article>
    </div>
  );
}

export function FollowUpPanel(props: FollowUpPanelProps) {
  const part = props.part ?? "all";
  const movement = part !== "followups" && props.isAcat;
  const body = (
    <>
      {movement && <Rejections {...props} />}
      {movement && <Residuals {...props} />}
      {part !== "movement" && <FeeAndInvestment {...props} />}
    </>
  );
  return props.bare ? body : <div className="sectionbody">{body}</div>;
}
