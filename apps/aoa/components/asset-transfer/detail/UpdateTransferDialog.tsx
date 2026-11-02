"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { recordTransferTracking, saveTransferOutcome, setStage } from "@/app/(authenticated)/asset-transfer/actions";
import { TRANSFER_STAGES, type TransferStage } from "@/lib/data/transfer-types";
import { TRANSFER_OUTCOMES, type TransferOutcomeValue } from "@/lib/transfers/outcome-values";
import { WorkspaceDialog, FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { easternToday } from "@/lib/transfers/eastern-day";
import { FUNDING_STAGE_LABELS, fundingStageNumber } from "./detail-model";

export type UpdateTransferProps = {
  transferId: string;
  contextTitle: string;
  contextDetail: string;
  referenceLine: string;
  stage: TransferStage;
  trackingAvailable: boolean;
  trackingFieldsAvailable: boolean;
  outcomeAvailable: boolean;
  explanation: string | null;
  isOps: boolean;
  submitted: boolean;
  trackingStage: string | null;
  expectedCompletionOn: string | null;
};

type Mode = "tracking" | "outcome";

const TRACKING_SUGGESTIONS = ["Submitted", "Acknowledged", "Under review", "In transit", "Action needed"];

function outcomeChoices(submitted: boolean, isOps: boolean): Array<{ value: TransferOutcomeValue; label: string; allowed: boolean; note: string }> {
  return TRANSFER_OUTCOMES.map(value => {
    switch (value) {
      case "Client declined": return { value, label: "Client declined", allowed: !submitted, note: " · only before submission" };
      case "Deferred": return { value, label: "Deferred · follow up later", allowed: !submitted || isOps, note: " · Operations" };
      case "Canceled": return { value, label: submitted ? "Canceled · custodian confirmation received" : "Canceled · before submission", allowed: isOps, note: " · Operations" };
      case "Purged": return { value, label: "Purged · custodian confirmation received", allowed: isOps, note: " · Operations" };
      default: {
        const unreachable: never = value;
        return unreachable;
      }
    }
  });
}

export function UpdateTransferDialog(props: UpdateTransferProps) {
  const available = props.trackingAvailable || props.outcomeAvailable;
  return (
    <WorkspaceDialog title="Update transfer" trigger="Update transfer" triggerDisabled={!available}
      triggerTitle={available ? undefined : "Operations updates a submitted transfer"}
      context={<FormTransferContext title={props.contextTitle} detail={props.contextDetail} />}>
      {close => <UpdateTransferBody {...props} close={close} />}
    </WorkspaceDialog>
  );
}

function UpdateTransferBody(props: UpdateTransferProps & { close: () => void }) {
  const [mode, setMode] = useState<Mode>(props.trackingAvailable ? "tracking" : "outcome");
  return (
    <>
      <div className="transfer-update-modes" role="group" aria-label="Update transfer options">
        <button className={`btn ${mode === "tracking" ? "selected" : ""}`} type="button" aria-pressed={mode === "tracking"}
          disabled={!props.trackingAvailable} onClick={() => setMode("tracking")}>Tracking update</button>
        <button className={`btn ${mode === "outcome" ? "selected" : ""}`} type="button" aria-pressed={mode === "outcome"}
          disabled={!props.outcomeAvailable} onClick={() => setMode("outcome")}>Transfer outcome</button>
      </div>
      {props.explanation ? <p className="small">{props.explanation}</p> : null}
      {mode === "tracking" ? <TrackingForm {...props} /> : <OutcomeForm {...props} />}
    </>
  );
}

function FormActions({ pending, submit, close }: { pending: boolean; submit: string; close: () => void }) {
  return (
    <div className="row" style={{ marginTop: 16 }}>
      <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : submit}</button>
      <button className="btn" type="button" onClick={close}>Cancel</button>
    </div>
  );
}

function TrackingForm(props: UpdateTransferProps & { close: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stage, setStageValue] = useState<TransferStage>(props.stage);
  const [trackingStage, setTrackingStage] = useState(props.trackingStage ?? "");
  const [expected, setExpected] = useState(props.expectedCompletionOn ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors([]);
    startTransition(async () => {
      const notes: string[] = [];
      if (props.trackingFieldsAvailable && trackingStage.trim() &&
        (trackingStage.trim() !== (props.trackingStage ?? "") || expected !== (props.expectedCompletionOn ?? ""))) {
        const saved = await recordTransferTracking(props.transferId, { trackingStage, expectedCompletionOn: expected });
        if (!saved.ok) { setErrors(saved.errors.map(error => error.message)); return; }
      }
      if (stage !== props.stage) {
        const moved = await setStage(props.transferId, stage);
        if (!moved.ok) {
          setErrors("blocked" in moved ? moved.unmet : moved.errors.map(error => error.message));
          router.refresh();
          return;
        }
        notes.push(...moved.warnings);
      }
      router.refresh();
      if (notes.length) setWarnings(notes);
      else props.close();
    });
  };

  if (warnings) {
    return (
      <>
        <div className="notice" role="status"><strong>Saved with open readiness items</strong><p>{warnings.join(" · ")}</p></div>
        <div className="row" style={{ marginTop: 16 }}><button className="btn primary" type="button" onClick={props.close}>Close</button></div>
      </>
    );
  }

  return (
    <form id="tracking-form" onSubmit={submit}>
      <p>{props.referenceLine}</p>
      <label className="field"><span>Funding stage</span>
        <select name="stage" value={stage} onChange={event => setStageValue(event.target.value as TransferStage)}>
          {TRANSFER_STAGES.map(value => <option key={value} value={value}>{`Stage ${fundingStageNumber(value)} · ${FUNDING_STAGE_LABELS[fundingStageNumber(value) - 1]}`}</option>)}
        </select>
      </label>
      <p className="small">Stage changes keep the readiness checks advisory; any open items are shown after saving and kept in History.</p>
      {props.trackingFieldsAvailable ? (
        <>
          <label className="field"><span>Current transfer status</span>
            <input name="trackingStage" value={trackingStage} maxLength={80} list="tracking-stage-options" onChange={event => setTrackingStage(event.target.value)} />
          </label>
          <datalist id="tracking-stage-options">{TRACKING_SUGGESTIONS.map(value => <option key={value} value={value} />)}</datalist>
          <p className="small">Enter the latest status from Apex. The suggestions are examples.</p>
          <label className="field"><span>Expected completion date (optional)</span>
            <input name="expectedCompletionOn" type="date" value={expected} onChange={event => setExpected(event.target.value)} />
          </label>
          <p className="small">Use the current estimate when available. Leave blank if it is unknown.</p>
        </>
      ) : <p className="small">Tracking status becomes available after the submission is logged and the transfer is In transfer.</p>}
      <p className="small">Changes are timestamped in History. Confirm assets received separately once arrival has been verified.</p>
      {errors.length ? <p className="upload-error" role="alert">{errors.join(" · ")}</p> : null}
      <FormActions pending={pending} submit="Save tracking update" close={props.close} />
    </form>
  );
}

function OutcomeForm(props: UpdateTransferProps & { close: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<TransferOutcomeValue | "">("");
  const [reason, setReason] = useState("");
  const [followUpOn, setFollowUpOn] = useState("");
  const [outcomeOn, setOutcomeOn] = useState(easternToday);
  const [errors, setErrors] = useState<string[]>([]);
  const choices = outcomeChoices(props.submitted, props.isOps);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!outcome) { setErrors(["Choose an outcome."]); return; }
    setErrors([]);
    startTransition(async () => {
      const result = await saveTransferOutcome(props.transferId, { outcome, reason, followUpOn: outcome === "Deferred" ? followUpOn : "", outcomeOn });
      if (!result.ok) { setErrors(result.errors.map(error => error.message)); return; }
      router.refresh();
      props.close();
    });
  };

  return (
    <form id="lifecycle-form" onSubmit={submit}>
      <p>Record a client decision or confirmed custodian outcome. Earlier documents, submissions and receipts stay in history.</p>
      <label className="field"><span>Transfer outcome</span>
        <select id="transfer-outcome" name="status" required value={outcome} onChange={event => setOutcome(event.target.value as TransferOutcomeValue | "")}>
          <option value="">Choose an outcome</option>
          {choices.map(choice => (
            <option key={choice.value} value={choice.value} disabled={!choice.allowed}>{choice.label}{choice.allowed ? "" : choice.note}</option>
          ))}
        </select>
      </label>
      <label className="field"><span>Reason</span>
        <textarea name="reason" required={outcome === "Client declined" || outcome === "Deferred"} maxLength={2000} value={reason}
          placeholder="Record the client instruction or custodian outcome." onChange={event => setReason(event.target.value)} />
      </label>
      <label className="field"><span>Outcome date</span>
        <input name="date" type="date" required value={outcomeOn} onChange={event => setOutcomeOn(event.target.value)} />
      </label>
      {outcome === "Deferred" ? (
        <div id="lifecycle-deferred-fields">
          <label className="field"><span>Follow-up date</span>
            <input name="followUpOn" type="date" required value={followUpOn} onChange={event => setFollowUpOn(event.target.value)} />
          </label>
          <p className="small">The transfer stays paused until someone explicitly resumes it.</p>
        </div>
      ) : null}
      {outcome === "Canceled" || outcome === "Purged" ? (
        <p className="small">Saving this record does not send a cancellation request. Record it once the custodian or the client’s initiating bank has confirmed the outcome.</p>
      ) : null}
      {errors.length ? <p className="upload-error" role="alert">{errors.join(" · ")}</p> : null}
      <FormActions pending={pending} submit="Save transfer outcome" close={props.close} />
    </form>
  );
}
