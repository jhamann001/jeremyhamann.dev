"use client";

import { useState, useTransition, type ReactNode } from "react";
import type { ChannelRecords } from "@/lib/transfers/channels";
import {
  saveAchInitiation,
  saveCheckTicket,
  type ChannelActionResult,
} from "@/app/(authenticated)/asset-transfer/actions";
import { cx } from "@/components/asset-transfer/workspace/ui";
import { FormTransferContext, WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";

export type ChannelKind = "check" | "ach" | "linked";

export type ChannelsPanelProps = {
  transferId: string;
  kind: ChannelKind;
  canRecord: boolean;
  records: ChannelRecords;
  transferContext?: { title: string; detail: string };
  bare?: boolean;
};

export const CASH_UNRECEIVED = "Cash is not received until a posted receipt is saved.";
export const AWAITING_AUTOMATIC = "Linked account: waiting on the automatic submission from the transfer feed.";
export const LINKED_SUBMITTED = "Linked account: submission recorded.";

type Errors = { field: string; message: string }[];

function useRecorder(): [boolean, Errors, (run: () => Promise<ChannelActionResult>, done?: () => void) => void] {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Errors>([]);
  const record = (run: () => Promise<ChannelActionResult>, done?: () => void) => {
    startTransition(async () => {
      const result = await run();
      setErrors(result.ok ? [] : result.errors);
      if (result.ok) done?.();
    });
  };
  return [pending, errors, record];
}

function messageFor(errors: Errors, field: string): string | null {
  return errors.find((error) => error.field === field)?.message ?? null;
}

function contextOf(props: ChannelsPanelProps): ReactNode {
  return props.transferContext
    ? <FormTransferContext title={props.transferContext.title} detail={props.transferContext.detail} />
    : undefined;
}

function DialogFooter({ errors, submit, pending, close }: { errors: Errors; submit: string; pending: boolean; close: () => void }) {
  return (
    <>
      <p id="form-error" className="upload-error" role="alert" tabIndex={-1}>{messageFor(errors, "form") ?? ""}</p>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : submit}</button>
        <button className="btn" type="button" onClick={close}>Cancel</button>
      </div>
    </>
  );
}

function CheckTicket(props: ChannelsPanelProps) {
  const { transferId, canRecord, records } = props;
  const latest = records.latestCheckTicket;
  const [withClient, setWithClient] = useState(latest?.withClient ?? false);
  const [mailerSent, setMailerSent] = useState(latest?.mailerSent ?? false);
  const [checkMailed, setCheckMailed] = useState(latest?.checkMailed ?? false);
  const [optionalCall, setOptionalCall] = useState(latest?.optionalCall ?? false);
  const [pending, errors, record] = useRecorder();
  const possession = latest == null
    ? "Check possession not yet recorded"
    : latest.withClient ? "Client has the check" : "Check is not with the client";
  return (
    <div className="subtle" data-testid="channel-check">
      <div className="row between">
        <strong>Check delivery</strong>
        <span className={cx("badge", latest ? "completed" : "waiting")}>{latest ? "Apex ticket recorded" : "Ticket needed"}</span>
      </div>
      <p>{possession}{latest ? ` · Ticket recorded ${latest.recordedAt.slice(0, 10)}` : ""}</p>
      {latest?.withClient && (
        <p className="small" data-testid="channel-client-records">
          Mailer {latest.mailerSent ? "sent" : "not sent"} · Check {latest.checkMailed ? "mailed" : "not mailed"}
          {latest.optionalCall ? " · CS call requested" : ""}
        </p>
      )}
      {!records.postedReceiptSaved && <p className="small" data-testid="channel-cash-unreceived">{CASH_UNRECEIVED}</p>}
      {canRecord && (
        <div className="row" style={{ marginTop: 12 }}>
          <WorkspaceDialog title="Record Apex notice & ticket" trigger="Record Apex notice & ticket" triggerStyle={{ tiny: true }} context={contextOf(props)}>
            {(close) => (
              <form id="check-ticket-form" onSubmit={(event) => {
                event.preventDefault();
                record(() => saveCheckTicket(transferId, { withClient, mailerSent, checkMailed, optionalCall }), close);
              }}>
                <p>Record the Apex check ticket and where the check is.</p>
                <label className="check">
                  <input type="checkbox" checked={withClient} onChange={(event) => setWithClient(event.target.checked)} />
                  The check is with the client
                </label>
                {withClient && (
                  <fieldset aria-label="Client check steps">
                    <legend>Client steps</legend>
                    <label className="check">
                      <input type="checkbox" checked={mailerSent} onChange={(event) => setMailerSent(event.target.checked)} />
                      Mailer sent
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={checkMailed} onChange={(event) => setCheckMailed(event.target.checked)} />
                      Check mailed
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={optionalCall} onChange={(event) => setOptionalCall(event.target.checked)} />
                      Optional call
                    </label>
                  </fieldset>
                )}
                <DialogFooter errors={errors} submit="Record check ticket" pending={pending} close={close} />
              </form>
            )}
          </WorkspaceDialog>
        </div>
      )}
      <p className="small" style={{ marginTop: 8 }}>Ticket and check details stay attached to the same transfer.</p>
    </div>
  );
}

function AchInitiation(props: ChannelsPanelProps) {
  const { transferId, canRecord, records } = props;
  const latest = records.latestAchInitiation;
  const [instructionsSent, setInstructionsSent] = useState(false);
  const [clientInitiationOn, setClientInitiationOn] = useState("");
  const [pending, errors, record] = useRecorder();
  return (
    <div className="method-card" data-movement-method="ach" data-testid="channel-ach">
      <div className="row between">
        <strong>Client self-service ACH</strong>
        <span className={cx("badge", latest ? "completed" : "ready")}>{latest ? "Client initiated" : "Initiation needed"}</span>
      </div>
      <p className="small">
        {latest ? `Client initiated ${latest.clientInitiationOn}` : "The client initiates ACH through self-service. No ACH initiation recorded."}
      </p>
      {canRecord && !latest && (
        <div className="row" style={{ marginTop: 12 }}>
          <WorkspaceDialog title="Record client initiation" trigger="Record client initiation" context={contextOf(props)}>
            {(close) => (
              <form id="ach-initiation-form" onSubmit={(event) => {
                event.preventDefault();
                record(() => saveAchInitiation(transferId, { instructionsSent, clientInitiationOn }), close);
              }}>
                <label className="check">
                  <input type="checkbox" checked={instructionsSent} onChange={(event) => setInstructionsSent(event.target.checked)} />
                  ACH instructions sent to the client
                </label>
                {messageFor(errors, "instructionsSent") && <small className="field-error-message">{messageFor(errors, "instructionsSent")}</small>}
                <label className="field">
                  <span>Client initiation date</span>
                  <input type="date" value={clientInitiationOn} onChange={(event) => setClientInitiationOn(event.target.value)} />
                  {messageFor(errors, "clientInitiationOn") && <small className="field-error-message">{messageFor(errors, "clientInitiationOn")}</small>}
                </label>
                <DialogFooter errors={errors} submit="Record ACH initiation" pending={pending} close={close} />
              </form>
            )}
          </WorkspaceDialog>
        </div>
      )}
      {!records.postedReceiptSaved && <p className="small" style={{ marginTop: 8 }}>{CASH_UNRECEIVED}</p>}
    </div>
  );
}

function LinkedAccount({ records }: Pick<ChannelsPanelProps, "records">) {
  return (
    <div className="subtle" data-testid="channel-linked">
      <div className="row between">
        <strong>Account linked through the app</strong>
        <span className={cx("badge", records.submissionRecorded ? "completed" : "waiting")}>
          {records.submissionRecorded ? "Submitted automatically" : "Awaiting submission"}
        </span>
      </div>
      <p>{records.submissionRecorded ? LINKED_SUBMITTED : AWAITING_AUTOMATIC}</p>
    </div>
  );
}

function ChannelBody(props: ChannelsPanelProps) {
  switch (props.kind) {
    case "check":
      return <CheckTicket {...props} />;
    case "ach":
      return <AchInitiation {...props} />;
    case "linked":
      return <LinkedAccount records={props.records} />;
    default: {
      const unhandled: never = props.kind;
      return unhandled;
    }
  }
}

export function ChannelsPanel(props: ChannelsPanelProps) {
  return props.bare ? <ChannelBody {...props} /> : <div className="sectionbody"><ChannelBody {...props} /></div>;
}
