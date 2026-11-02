"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { ACAT_DEFINITION } from "@/lib/forms/acat-definition";
import { formDownloadResponseIssue } from "@/components/forms/ira-beneficiary-ui";
import {
  formTitleVersion,
  routeRequiresSignature,
  type RouteLabel,
} from "@/lib/transfers/route-label";
import type { ManualTransferFormRule } from "@/lib/transfers/manual-transfer-catalog";
import type { PaperworkRecords } from "@/lib/data/transfer-paperwork-store";
import {
  recordAppAuthorization,
  recordFormReview,
  recordMailedPaperwork,
  recordReturnedSignature,
  recordSentPacket,
} from "@/app/(authenticated)/asset-transfer/actions";
import { btnClass, cx } from "@/components/asset-transfer/workspace/ui";
import { FormTransferContext, WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";

export type ReviewDownloadProps = {
  transferId: string;
  route: RouteLabel;
  clientId: string | null;
  accounts: { accountId: string; maskedAccountNumber: string; accountType: string; status: string }[];
  latestFormReview: PaperworkRecords["latestFormReview"];
  canGenerate: boolean;
  canDownload: boolean;
  canRecord: boolean;
  manualForms: readonly ManualTransferFormRule[];
  records: Pick<PaperworkRecords, "sentPacketRecorded" | "returnedSignatureRecorded" | "mailedPaperworkRecorded">;
  drsTicket: {
    clientName: string;
    transferringFirm: string | null;
    fundingPlanVersion: number;
    sourceAccountSuffix: string;
    returnedSignatureRecorded: boolean;
  } | null;
  transferContext?: { title: string; detail: string };
  bare?: boolean;
};

export const GENERATE_UNAVAILABLE =
  "Generate paperwork is unavailable until Operations approves the current funding plan and the statement and account checks are clear.";
export const NO_MANUAL_FORM =
  "No reviewed form workflow is available for this custodian and route. Operations must confirm the applicable paperwork.";

const DRS_REQUIRED_FIELDS = [
  "Registered client name and full source DRS account number, preserving any letters and leading zeros",
  "Full receiving Apex account number",
  "Security name, symbol / CUSIP, exact share quantity, and full or partial transfer instructions",
  "Current source statement and current signed CAT form, with all pages; include the DocuSign completion certificate when applicable",
  "A share certificate only when required / available; any fractional-share, restriction or lockup instructions must be explicitly authorized",
];

/** The presentation's DRS ticket draft, without the Transfer scope line. */
export function drsTicketText(ticket: NonNullable<ReviewDownloadProps["drsTicket"]>): string {
  return [
    `Subject: Inbound DRS transfer — ${ticket.clientName} — Apex •••• account needed`,
    "",
    "Please have Apex Securities Processing key the inbound DRS transfer into the receiving client account below, using the attached source statement and signed CAT form.",
    "",
    "Receiving Apex account: [Full receiving Apex account number needed]",
    "Receiving account registration: [Registration needed]",
    "Receiving account type: [Account type needed]",
    `Transfer agent / source institution: ${ticket.transferringFirm?.trim() || "[Transfer agent needed]"}`,
    "Source DRS account number: [Source DRS account number needed]",
    "Source registered name: [Registered name needed]",
    `Current funding plan: version ${ticket.fundingPlanVersion}`,
    "",
    "Securities requested:",
    "[Select the securities and quantities in the funding plan]",
    "",
    "Attachments:",
    "- Source statement: [Source statement needed]",
    `- Current signed CAT form, all pages: ${ticket.returnedSignatureRecorded
      ? "[Attach the current signed paperwork; signature evidence is recorded]"
      : "[Current signed paperwork has not been received]"}`,
    "- DocuSign completion certificate: [Attach when the CAT form was signed through DocuSign]",
    "- Share certificate: [Attach only when required / available]",
    "",
    "Service request category: Funding & Money Movement",
    "Request type: Process a transaction or make a request",
    "Topic: Account transfer or rollover",
    "Select the DRS / transfer-agent request option shown in the live form. The final option is not listed in the published guide.",
    "",
    "Confirm before creating the ticket:",
    ...DRS_REQUIRED_FIELDS.map((item) => `- ${item}`),
    "",
    "Fractional shares / restrictions / lockups: [Include only the specific authorized instructions, if applicable; do not infer liquidation from full transfer scope.]",
    "",
    "Review the account numbers, security identifiers and exact share quantities against the attached documents before creating the request.",
  ].join("\n");
}

function acatFormApplies(route: RouteLabel, manualForms: readonly ManualTransferFormRule[]): boolean {
  switch (route) {
    case "Full ACAT · signed paperwork · Apex API":
    case "Partial ACAT · signed paperwork · Ascend entry":
      return true;
    case "Manual · custodian-library process":
      return manualForms.some((rule) =>
        rule.template === "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST" && rule.generationSupport !== "MANUAL_ONLY");
    case "Full ACAT · app authorization · Apex API":
    case "DRS · Apex service request":
    case "Rollover · physical check":
    case "ACH · client self-service":
    case "Wire · client instructions":
      return false;
    default: {
      const unhandled: never = route;
      return unhandled;
    }
  }
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

type PaperworkStep = {
  key: string;
  title: string;
  label: string;
  done: boolean;
  action: (id: string) => Promise<{ ok: boolean }>;
  waiting: string;
  blockedReason?: string;
};

function paperworkTitle(route: RouteLabel): string {
  return route === "Manual · custodian-library process"
    ? "Signature required by the contra instructions"
    : "Signed transfer paperwork required";
}

export function ReviewDownload(props: ReviewDownloadProps) {
  const {
    transferId, route, clientId, accounts, latestFormReview, canGenerate, canDownload, canRecord, manualForms, records, drsTicket,
    transferContext, bare = false,
  } = props;
  const [accountId, setAccountId] = useState(latestFormReview?.apex_account_id ?? accounts[0]?.accountId ?? "");
  const [receivingFormTitle, setReceivingFormTitle] = useState(latestFormReview?.receiving_form_title ?? "");
  const [sourceFormTitle, setSourceFormTitle] = useState(latestFormReview?.source_form_title ?? "");
  const [titleOwnersConfirmed, setTitleOwnersConfirmed] = useState(
    latestFormReview?.title_owners_confirmed != null &&
      latestFormReview.title_owners_confirmed === formTitleVersion(latestFormReview.receiving_form_title ?? "", latestFormReview.source_form_title ?? ""),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [ticketOpen, setTicketOpen] = useState(false);
  const ticketRef = useRef<HTMLTextAreaElement>(null);

  const formApplies = acatFormApplies(route, manualForms);
  const signatureRoute = routeRequiresSignature(route);
  const disabled = busy || pending;
  const context: ReactNode = transferContext
    ? <FormTransferContext title={transferContext.title} detail={transferContext.detail} />
    : undefined;

  const editTitle = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setConfirmed(false);
    setTitleOwnersConfirmed(false);
  };

  const download = async (body: { formId: string; accountId: string; accountHolderName: string }): Promise<boolean> => {
    const response = await fetch("/api/forms/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        transferId,
        formId: body.formId,
        clientId,
        accountIds: [body.accountId],
        values: { accountHolderName: body.accountHolderName, accountHolderTaxId: "", confirmAccountTitle: true },
      }),
    });
    const responseIssue = formDownloadResponseIssue({
      status: response.status, redirected: response.redirected, contentType: response.headers.get("content-type"),
    });
    if (responseIssue) { setMessage(responseIssue); return false; }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { details?: { message?: string }[] } | null;
      setMessage(payload?.details?.[0]?.message ?? "The form could not be generated");
      return false;
    }
    const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "acat-transfer.pdf";
    saveBlob(await response.blob(), filename);
    return true;
  };

  const saveReview = async (reviewed: boolean, close: () => void) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await recordFormReview(transferId, {
        reviewed,
        receivingFormTitle,
        sourceFormTitle,
        titleOwnersConfirmed: titleOwnersConfirmed ? formTitleVersion(receivingFormTitle, sourceFormTitle) : null,
        apexAccountId: accountId,
        formId: ACAT_DEFINITION.id,
      });
      if (!result.ok) { setMessage("The review could not be saved."); return; }
      if (reviewed && !(await download({ formId: ACAT_DEFINITION.id, accountId, accountHolderName: receivingFormTitle.trim() }))) return;
      close();
    } catch {
      setMessage("The form could not be generated. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const viewCurrent = async () => {
    if (!latestFormReview) return;
    setBusy(true);
    setMessage(null);
    try {
      await download({
        formId: latestFormReview.form_id,
        accountId: latestFormReview.apex_account_id,
        accountHolderName: latestFormReview.receiving_form_title ?? "",
      });
    } catch {
      setMessage("The form could not be generated. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const record = (action: (id: string) => Promise<{ ok: boolean }>) => () => {
    startTransition(async () => {
      const result = await action(transferId);
      if (!result.ok) setMessage("That record could not be saved.");
    });
  };

  const copyTicket = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setTicketOpen(true);
      ticketRef.current?.select();
    }
  };

  const steps: PaperworkStep[] = [
    ...(signatureRoute ? [
      {
        key: "send_form", title: "Packet sent", label: "Record packet sent", done: records.sentPacketRecorded, action: recordSentPacket,
        waiting: "Record when the current packet was sent to the client.",
        blockedReason: latestFormReview?.reviewed === true ? undefined : "Review the populated PDF for this current packet before recording it as sent.",
      },
      {
        key: "sign", title: "Signed paperwork received", label: "Record returned signature", done: records.returnedSignatureRecorded,
        action: recordReturnedSignature, waiting: "Waiting for the client. Record the returned signature when it arrives.",
      },
    ] : []),
    ...(route === "Full ACAT · signed paperwork · Apex API" ? [{
      key: "app_authorization", title: "App authorization", label: "Record app authorization", done: false, action: recordAppAuthorization,
      waiting: "Record a client app authorization when the client authorizes this plan in the app instead.",
    }] : []),
    ...(route === "Manual · custodian-library process" ? [{
      key: "mailed", title: "Paperwork mailed", label: "Record mailed paperwork", done: records.mailedPaperworkRecorded,
      action: recordMailedPaperwork, waiting: "Record when the custodian paperwork is mailed.",
    }] : []),
  ];

  const ticket = drsTicket ? drsTicketText(drsTicket) : null;
  const reviewState = latestFormReview == null ? null : latestFormReview.reviewed ? "Current packet · PDF reviewed" : "Draft review saved";

  const body = (
    <div data-route={route}>
      {message && <div className="notice" role="alert"><strong>{message}</strong></div>}

      {route === "Manual · custodian-library process" && (
        manualForms.length === 0 ? (
          <div className="notice"><strong>Paperwork route needs confirmation</strong><p>{NO_MANUAL_FORM}</p></div>
        ) : (
          <div className="subtle">
            <strong>Custodian forms</strong>
            <ul aria-label="Custodian forms">
              {manualForms.map((rule) => <li key={rule.id}>{rule.displayName}</li>)}
            </ul>
          </div>
        )
      )}

      {formApplies && (
        <>
          <div className="row between">
            <div>
              <strong>{paperworkTitle(route)}</strong>
              <p className="small">
                {latestFormReview?.reviewed
                  ? `Populated PDF reviewed${latestFormReview.receiving_form_title ? ` · ${latestFormReview.receiving_form_title}` : ""}`
                  : "Ops approves the current funding plan first; either team can then generate the paperwork."}
              </p>
            </div>
            {canGenerate && (
              <WorkspaceDialog title="Review & edit transfer form" trigger="Generate paperwork" triggerStyle={{ primary: latestFormReview?.reviewed !== true }}
                triggerDisabled={disabled} context={context}>
                {(close) => (
                  <form onSubmit={(event) => { event.preventDefault(); void saveReview(true, close); }} aria-label="Review the transfer form">
                    {message && <p className="upload-error" role="alert">{message}</p>}
                    <label className="field">
                      <span>Receiving Apex account</span>
                      <select value={accountId} disabled={disabled}
                        onChange={(event) => { setAccountId(event.target.value); setConfirmed(false); }}>
                        {accounts.map((account) => (
                          <option key={account.accountId} value={account.accountId}>
                            {account.accountType} · {account.maskedAccountNumber} · {account.status || "Status unavailable"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <section className="real-form-titles">
                      <h3>Titles printed on the form</h3>
                      <p className="small">Paperwork wording changes keep the funding-plan approval. The verified account stays unchanged.</p>
                      <label className="field">
                        <span>Receiving account title on the form</span>
                        <input maxLength={250} value={receivingFormTitle} disabled={disabled}
                          onChange={(event) => editTitle(setReceivingFormTitle)(event.target.value)} />
                      </label>
                      <label className="field">
                        <span>Delivering account title on the form</span>
                        <input maxLength={250} value={sourceFormTitle} disabled={disabled}
                          onChange={(event) => editTitle(setSourceFormTitle)(event.target.value)} />
                      </label>
                    </section>
                    <div className="real-form-review">
                      <label className="check">
                        <input type="checkbox" name="titleOwnersConfirmed" value={formTitleVersion(receivingFormTitle, sourceFormTitle)}
                          checked={titleOwnersConfirmed} disabled={disabled}
                          onChange={(event) => setTitleOwnersConfirmed(event.target.checked)} />
                        I confirmed that both form titles identify the same registered owners as the verified accounts.
                      </label>
                      <label className="check">
                        <input type="checkbox" name="confirmed" checked={confirmed} disabled={disabled}
                          onChange={(event) => setConfirmed(event.target.checked)} />
                        I checked the populated PDF, account titles and numbers, and approved transfer instructions.
                      </label>
                    </div>
                    <div className="row" style={{ marginTop: 16 }}>
                      <button type="submit" className="btn primary" disabled={disabled || !confirmed || !accountId}>
                        Confirm review &amp; download PDF
                      </button>
                      <button type="button" className="btn" disabled={disabled || !accountId} onClick={() => void saveReview(false, close)}>
                        Save draft
                      </button>
                      <button type="button" className="btn quiet" onClick={close}>Cancel</button>
                    </div>
                  </form>
                )}
              </WorkspaceDialog>
            )}
          </div>
          {!canGenerate && <p className="small" style={{ marginTop: 9 }}>{GENERATE_UNAVAILABLE}</p>}
          {(reviewState || canDownload) && (
            <div className="row" style={{ marginTop: 14 }}>
              {reviewState && <span className={cx("badge", latestFormReview?.reviewed ? "neutral" : "waiting")}>{reviewState}</span>}
              {canDownload && (
                <button type="button" className={btnClass({ tiny: true })} disabled={disabled} onClick={viewCurrent}>View current paperwork</button>
              )}
            </div>
          )}
        </>
      )}

      {steps.length > 0 && (
        <div className="paperwork-steps" aria-label="Paperwork progress">
          {steps.map((step, index) => {
            const reasonId = `paperwork-${step.key}-reason`;
            const enabled = canRecord && !disabled && !step.blockedReason;
            return (
              <article key={step.key} className={cx("paperwork-step", step.done && "is-complete")} id={`paperwork-${step.key}`}>
                <span className="step-indicator" aria-hidden="true">{step.done ? "✓" : index + 1}</span>
                <div className="step-copy">
                  <strong>{step.title}</strong>
                  <p id={reasonId}>{step.done ? "Recorded on this movement." : step.blockedReason ?? step.waiting}</p>
                </div>
                {step.done ? (
                  <div className="row"><span className="badge completed">Recorded</span></div>
                ) : canRecord ? (
                  <button type="button" className={btnClass({ primary: enabled })} disabled={!enabled}
                    aria-describedby={reasonId} onClick={record(step.action)}>
                    {step.label}
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {drsTicket && ticket && (
        <section className="drs-service-request" aria-label="Prepare Apex DRS service request">
          <div className="drs-service-heading">
            <div>
              <span className="kicker">Operations · Apex service request</span>
              <h3>Everything for the DRS request</h3>
              <p className="small">Review the prepared request details, then create the Apex ticket.</p>
            </div>
          </div>
          <details className="drs-required-checklist">
            <summary>Information Apex needs with this request</summary>
            <ul>{DRS_REQUIRED_FIELDS.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
          <details className="drs-ticket-draft" open={ticketOpen} onToggle={(event) => setTicketOpen(event.currentTarget.open)}>
            <summary>Prepared ticket text</summary>
            <label className="field">
              <span className="sr-only">DRS ticket draft</span>
              <textarea ref={ticketRef} readOnly value={ticket} rows={10} />
            </label>
          </details>
          <div className="row drs-ticket-actions">
            <button type="button" className="btn" onClick={() => copyTicket(ticket)}>Copy ticket text</button>
            <button type="button" className="btn"
              onClick={() => saveBlob(new Blob([ticket], { type: "text/plain" }), `DRS-ticket-${drsTicket.sourceAccountSuffix}.txt`)}>
              Download ticket draft
            </button>
          </div>
          <p className="small drs-service-footer">
            Preparing or downloading this draft does not submit a request.
          </p>
        </section>
      )}
    </div>
  );
  return bare ? body : <div className="sectionbody">{body}</div>;
}
