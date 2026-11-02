"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { OutcomeRecords } from "@/lib/transfers/outcomes";
import { TRANSFER_OUTCOMES, type TransferOutcomeValue } from "@/lib/transfers/outcome-values";
import {
  resumeDeferredTransfer,
  saveTransferCorrection,
  saveTransferOutcome,
  type OutcomeActionResult,
} from "@/app/(authenticated)/asset-transfer/actions";
import { btnClass, cx } from "@/components/asset-transfer/workspace/ui";
import { FormTransferContext, WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { trackingDate } from "@/components/asset-transfer/detail/detail-model";
import { easternToday } from "@/lib/transfers/eastern-day";

/** Which part renders: the outcome banner (top of the detail) or the history timeline. */
export type OutcomesPart = "all" | "banner" | "history";

export type OutcomesPanelProps = {
  transferId: string;
  canRecord: boolean;
  records: OutcomeRecords;
  part?: OutcomesPart;
  transferContext?: { title: string; detail: string };
  bare?: boolean;
};

export const PAUSED_NOTE = "Preparation and movement actions are paused. Recorded assets and follow-up stay on the movement.";

type Errors = { field: string; message: string }[];
type Outcome = OutcomeRecords["outcomes"][number];

function useRecorder(): [boolean, Errors, (run: () => Promise<OutcomeActionResult>, done?: () => void) => void] {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Errors>([]);
  const record = (run: () => Promise<OutcomeActionResult>, done?: () => void) => {
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

function contextOf(props: OutcomesPanelProps): ReactNode {
  return props.transferContext
    ? <FormTransferContext title={props.transferContext.title} detail={props.transferContext.detail} />
    : undefined;
}

function outcomeHint(outcome: TransferOutcomeValue): string {
  switch (outcome) {
    case "Client declined":
      return "Only before a submission or receipt. Record Canceled for an initiated movement.";
    case "Deferred":
      return "Pauses the movement until it is resumed on the follow-up date.";
    case "Canceled":
      return "Ends the movement. Nothing recorded is deleted.";
    case "Purged":
      return "Closes the movement out. Nothing recorded is deleted.";
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

function bannerOf(outcome: TransferOutcomeValue): { className: string; description: string } {
  switch (outcome) {
    case "Client declined":
      return { className: "declined", description: "The client chose not to proceed. The statement, plan and recorded activity remain available." };
    case "Deferred":
      return { className: "deferred", description: "Preparation and submission are paused. Resume this transfer when the client is ready." };
    case "Canceled":
      return { className: "canceled", description: "This transfer is stopped. Its submission and any received assets remain in the record." };
    case "Purged":
      return { className: "purged", description: "This transfer was purged at the custodian. Its earlier evidence and activity remain available." };
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

function knownOutcome(value: string): TransferOutcomeValue | null {
  return (TRANSFER_OUTCOMES as readonly string[]).includes(value) ? value as TransferOutcomeValue : null;
}

function outcomeLine(row: Outcome): string {
  return [
    row.outcome,
    row.reason,
    row.followUpOn ? `follow up ${row.followUpOn}` : null,
    row.priorAssignment ? `previously assigned to ${row.priorAssignment}` : null,
    row.resumed ? "resumed" : null,
  ].filter(Boolean).join(" · ");
}

function Banner({ transferId, canRecord, records }: OutcomesPanelProps) {
  const [pending, errors, record] = useRecorder();
  const latest = records.outcomes[0] ?? null;
  const current = latest && !latest.resumed ? latest : null;
  if (!current && !records.paused) return null;
  const known = current ? knownOutcome(current.outcome) : null;
  const banner = known ? bannerOf(known) : null;
  const resumable = current?.outcome === "Deferred";
  const previous = records.outcomes.slice(current ? 1 : 0);
  return (
    <section className={cx("lifecycle-banner", banner?.className)} aria-label="Transfer outcome" data-testid="outcomes-outcome">
      <div className="row between"><strong>{current ? current.outcome : "Movement paused"}</strong></div>
      {records.paused ? <p data-testid="outcomes-paused">{PAUSED_NOTE}</p> : banner && <p>{banner.description}</p>}
      {current?.reason && <p><b>Reason:</b> {current.reason}</p>}
      {current?.followUpOn && <p><b>Follow up:</b> {current.followUpOn}</p>}
      {current?.priorAssignment && <p><b>Previously assigned to:</b> {current.priorAssignment}</p>}
      {current && <small>Outcome date · {current.outcomeOn ? trackingDate(current.outcomeOn) : "Not recorded"} · recorded {trackingDate(current.recordedAt)}</small>}
      {canRecord && resumable && (
        <div className="row">
          <button type="button" className={btnClass({ primary: true, tiny: true })} disabled={pending}
            onClick={() => record(() => resumeDeferredTransfer(transferId))}>
            Resume transfer
          </button>
        </div>
      )}
      {errors[0] && <p className="upload-error" role="alert">{errors[0].message}</p>}
      {previous.length > 0 && (
        <details>
          <summary>Previous transfer outcomes ({previous.length})</summary>
          {previous.map((row) => <p key={row.recordedAt}>{trackingDate(row.outcomeOn ?? row.recordedAt)} · {outcomeLine(row)}</p>)}
        </details>
      )}
    </section>
  );
}

function OutcomeDialog(props: OutcomesPanelProps) {
  const { transferId } = props;
  const [outcome, setOutcome] = useState<TransferOutcomeValue>("Deferred");
  const [reason, setReason] = useState("");
  const [followUpOn, setFollowUpOn] = useState("");
  const [outcomeOn, setOutcomeOn] = useState(easternToday);
  const [pending, errors, record] = useRecorder();
  return (
    <WorkspaceDialog title="Record transfer outcome" trigger="Record transfer outcome" triggerStyle={{ quiet: true, tiny: true }} context={contextOf(props)}>
      {(close) => (
        <form id="lifecycle-form" onSubmit={(event) => {
          event.preventDefault();
          record(() => saveTransferOutcome(transferId, { outcome, reason, followUpOn, outcomeOn }), () => {
            setReason("");
            setFollowUpOn("");
            close();
          });
        }}>
          <label className="field">
            <span>Transfer outcome</span>
            <select value={outcome} onChange={(event) => setOutcome(event.target.value as TransferOutcomeValue)}>
              {TRANSFER_OUTCOMES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <p className="small">{outcomeHint(outcome)}</p>
          <label className="field">
            <span>Reason</span>
            <textarea value={reason} maxLength={2000} rows={2} onChange={(event) => setReason(event.target.value)} />
          </label>
          <label className="field">
            <span>Outcome date</span>
            <input type="date" required value={outcomeOn} onChange={(event) => setOutcomeOn(event.target.value)} />
          </label>
          {outcome === "Deferred" && (
            <label className="field">
              <span>Follow-up date</span>
              <input type="date" value={followUpOn} onChange={(event) => setFollowUpOn(event.target.value)} />
            </label>
          )}
          <FormError errors={errors} />
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Record outcome"}</button>
            <button className="btn" type="button" onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </WorkspaceDialog>
  );
}

function CorrectionDialog(props: OutcomesPanelProps) {
  const { transferId } = props;
  const [correction, setCorrection] = useState("");
  const [pending, errors, record] = useRecorder();
  return (
    <WorkspaceDialog title="Add correction" trigger="Add correction" triggerStyle={{ tiny: true }} context={contextOf(props)}>
      {(close) => (
        <form id="correction-form" onSubmit={(event) => {
          event.preventDefault();
          record(() => saveTransferCorrection(transferId, { correction }), () => { setCorrection(""); close(); });
        }}>
          <label className="field">
            <span>Correction</span>
            <textarea value={correction} maxLength={2000} rows={3} onChange={(event) => setCorrection(event.target.value)} />
          </label>
          <p className="small">Corrections are appended to the history. Nothing recorded is changed or deleted.</p>
          <FormError errors={errors} />
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Add correction"}</button>
            <button className="btn" type="button" onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </WorkspaceDialog>
  );
}

type HistoryEntry = { key: string; at: string; label: string; text: string };

function History(props: OutcomesPanelProps) {
  const { canRecord, records } = props;
  const entries: HistoryEntry[] = [
    ...records.outcomes.map((row) => ({ key: `outcome-${row.recordedAt}`, at: row.recordedAt, label: "Transfer outcome", text: outcomeLine(row) })),
    ...records.stageChanges.map((row) => ({
      key: `stage-${row.recordedAt}`, at: row.recordedAt, label: "Stage change", text: `Stage ${row.previousStage} → ${row.newStage}`,
    })),
    ...records.corrections.map((row) => ({
      key: `correction-${row.recordedAt}`, at: row.recordedAt, label: "Correction", text: row.correction,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div data-testid="outcomes-history">
      {canRecord && (
        <div className="row" style={{ marginBottom: 12 }}>
          {!records.paused && <OutcomeDialog {...props} />}
          <CorrectionDialog {...props} />
        </div>
      )}
      {entries.length === 0 ? (
        <p className="small">No outcome, stage change or correction recorded.</p>
      ) : (
        <ol className="timeline">
          {entries.map((entry) => (
            <li key={entry.key}>
              <small>{entry.at.slice(0, 16).replace("T", " ")} · {entry.label}</small>
              <p>{entry.text}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function OutcomesPanel(props: OutcomesPanelProps) {
  const part = props.part ?? "all";
  const body = (
    <>
      {part !== "history" && <Banner {...props} />}
      {part !== "banner" && <History {...props} />}
    </>
  );
  return props.bare ? body : <div className="sectionbody">{body}</div>;
}
