"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import {
  recordTransferMailing, updateTransferMailingLegs, type MailingFormState,
} from "@/app/(authenticated)/asset-transfer/actions";
import { MAILING_CARRIERS, MAILING_CONTENTS, MAILING_JOURNEYS, MAILING_REASONS } from "@/lib/transfers/mailing-journeys";
import { WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";

const INITIAL: MailingFormState = { ok: false, errors: [] };

function FieldError({ message }: { message: string | undefined }) {
  return message ? <small className="field-error-message">{message}</small> : null;
}

/** A saved leg's values for the edit dialog; blank when not recorded. */
export type MailingLegValues = {
  number: number; label: string; from: string;
  carrier: string; trackingNumber: string; mailedOn: string; receivedOn: string;
};

function stopsOf(journey: string): string[] {
  return journey ? journey.split(" to ") : [];
}

function legsOf(journey: string): MailingLegValues[] {
  const stops = stopsOf(journey);
  return stops.slice(1).map((to, index) => ({
    number: index + 1,
    label: `${stops[index].charAt(0).toUpperCase()}${stops[index].slice(1)} → ${to}`,
    from: stops[index],
    carrier: "", trackingNumber: "", mailedOn: "", receivedOn: "",
  }));
}

/** The mockup's per-leg carrier, tracking and dates. */
export function MailingLegFields({ legs, errors }: { legs: MailingLegValues[]; errors: (field: string) => string | undefined }) {
  return <>
    {legs.map((leg, index) => {
      const prefix = `leg${leg.number}`;
      const fromClient = leg.from === "the client";
      return (
        <details key={`${prefix}:${leg.label}`} className="mailing-leg-form" open={index === 0 || Boolean(leg.mailedOn || leg.trackingNumber)}>
          <summary><span>{leg.label}</span></summary>
          <div className="mailing-fields">
            <label className="field"><span>Carrier (if known)</span>
              <select name={`${prefix}_carrier`} defaultValue={leg.carrier}>
                <option value="">Not recorded</option>
                {MAILING_CARRIERS.map(carrier => <option key={carrier} value={carrier}>{carrier}</option>)}
              </select>
            </label>
            <label className="field"><span>Tracking number (if known)</span>
              <input name={`${prefix}_trackingNumber`} maxLength={250} defaultValue={leg.trackingNumber} />
            </label>
            <label className="field"><span>{fromClient ? "Client mailed onward" : "Mailed date"}</span>
              <input name={`${prefix}_mailedOn`} type="date" defaultValue={leg.mailedOn} />
            </label>
            <label className="field"><span>{fromClient ? "Received at the next stop" : "Received date"}</span>
              <input name={`${prefix}_receivedOn`} type="date" defaultValue={leg.receivedOn} />
            </label>
          </div>
          <FieldError message={errors(prefix)} />
        </details>
      );
    })}
  </>;
}

export function MailingForm({ transferId, onSaved, onCancel }: {
  transferId: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const [state, action, pending] = useActionState(recordTransferMailing.bind(null, transferId), INITIAL);
  const [journey, setJourney] = useState("");
  const [otherChecked, setOtherChecked] = useState(false);
  const error = (field: string) => state.errors.find((item) => item.field === field)?.message;
  useEffect(() => {
    if (state.ok) onSaved?.();
  }, [state, onSaved]);
  return (
    <form action={action} id="mailing-form" aria-label="Record a mailing" onReset={() => setOtherChecked(false)}>
      <div className="mailing-fields">
        <label className="field">
          <span>Reason</span>
          <select name="reason" defaultValue="" required>
            <option value="" disabled>Choose reason</option>
            {MAILING_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select>
          <FieldError message={error("reason")} />
        </label>
        <label className="field">
          <span>Mailing journey</span>
          <select name="journey" value={journey} required onChange={(event) => setJourney(event.target.value)}>
            <option value="" disabled>Choose a journey</option>
            {MAILING_JOURNEYS.map((journey) => <option key={journey} value={journey}>{journey}</option>)}
          </select>
          <FieldError message={error("journey")} />
        </label>
      </div>
      <fieldset className="mailing-contents" aria-label="Envelope contents">
        <legend>What is in the envelope?</legend>
        <div>
          {MAILING_CONTENTS.map((item) => (
            <label key={item}>
              <input type="checkbox" name="contents" value={item}
                onChange={item === "Other" ? (event) => setOtherChecked(event.target.checked) : undefined} /> {item}
            </label>
          ))}
        </div>
        <FieldError message={error("contents")} />
      </fieldset>
      <details className="mailing-content-details" open={otherChecked || Boolean(error("contentsNote")) || undefined}>
        <summary>{otherChecked ? "Describe other envelope contents" : "Additional envelope details (optional)"}</summary>
        <label className="field">
          <span>{otherChecked ? "Describe other items (required)" : "Envelope details (optional)"}</span>
          <input name="contentsNote" maxLength={1000} required={otherChecked}
            placeholder="Document names, dates, or details to identify what was included" />
          <FieldError message={error("contentsNote")} />
        </label>
      </details>
      <MailingLegFields legs={legsOf(journey)} errors={error} />
      <div className="mailing-fields">
        <label className="field">
          <span>Postage cost ($, if known)</span>
          <input name="postage" inputMode="decimal" placeholder="Leave blank if unknown" />
          <FieldError message={error("postage")} />
        </label>
      </div>
      <p className="upload-error" role="alert" tabIndex={-1}>{error("form") ?? ""}</p>
      {state.ok && <p className="small" role="status">Mailing saved.</p>}
      <div className="row" style={{ marginTop: 16 }}>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save mailing"}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
      <p className="small">Delivery is tracked here. Returned signatures and receipt of assets are recorded in their own steps.</p>
    </form>
  );
}

function EditMailingForm({ transferId, mailingId, legs, onSaved, onCancel }: {
  transferId: string; mailingId: string; legs: MailingLegValues[]; onSaved: () => void; onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(updateTransferMailingLegs.bind(null, transferId, mailingId), INITIAL);
  const error = (field: string) => state.errors.find((item) => item.field === field)?.message;
  useEffect(() => {
    if (state.ok) onSaved();
  }, [state, onSaved]);
  return (
    <form action={action} aria-label="Update mailing tracking">
      <p className="small">Record the carrier, tracking number and dates as each leg moves. The reason, contents and journey stay as saved.</p>
      <MailingLegFields legs={legs} errors={error} />
      <p className="upload-error" role="alert" tabIndex={-1}>{error("form") ?? ""}</p>
      <div className="row" style={{ marginTop: 16 }}>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save mailing"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** The mockup's "Edit mailing" dialog for a saved mailing's leg tracking. */
export function EditMailingDialog({ transferId, mailingId, legs, context }: {
  transferId: string; mailingId: string; legs: MailingLegValues[]; context?: ReactNode;
}) {
  return (
    <WorkspaceDialog title="Edit mailing" trigger="Edit mailing" triggerStyle={{ tiny: true }} context={context}>
      {(close) => <EditMailingForm transferId={transferId} mailingId={mailingId} legs={legs} onSaved={close} onCancel={close} />}
    </WorkspaceDialog>
  );
}

/** The mockup's "Add mailing" dialog; the form mounts only while it is open. */
export function MailingDialog({ transferId, context, compact = false }: {
  transferId: string;
  context?: ReactNode;
  compact?: boolean;
}) {
  return (
    <WorkspaceDialog title="Add mailing" trigger="Add mailing" triggerStyle={compact ? { tiny: true } : { primary: true }} context={context}>
      {(close) => <MailingForm transferId={transferId} onSaved={close} onCancel={close} />}
    </WorkspaceDialog>
  );
}
