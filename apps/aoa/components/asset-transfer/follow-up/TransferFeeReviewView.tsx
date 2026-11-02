import type { ReactNode } from "react";
import { FEE_FIELDS, type TransferFee } from "@/lib/data/acat-fee-view";
import { feeDirectionLabel } from "@/lib/data/custodian-library-contract";
import { FEE_REQUEST_KIND_LABELS, feeRequestsTruncatedNote, TRANSFER_FEE_REQUESTS_LIMIT } from "@/lib/data/acat-fee-requests-view";
import { reimbursementRequestHref, reimbursementStatusChip } from "@/lib/data/acat-reimbursement-view";
import type { TransferFeeReview } from "@/lib/data/transfer-fee-review-contract";
import { TransferFeeSection } from "@/components/transfers/TransferFeeSection";

const value = (text: string | null | undefined) => text?.trim() || "Not recorded";
const money = (amount: number | null) => amount === null ? "Not recorded" : amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
const date = (text: string) => new Date(text).toLocaleDateString("en-US", { timeZone: "America/New_York" });

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <tr><th scope="row">{label}</th><td>{children}</td></tr>;
}

function LibraryDetails({ review }: { review: TransferFeeReview }) {
  const library = review.library;
  if (library.state !== "ready") {
    const message = library.state === "restricted" ? "Custodian fee details are available to Operations and Admin."
      : library.state === "unavailable" ? "The custodian fee library could not be loaded. Fee rules are unavailable."
      : library.state === "not_linked" ? "Add the transferring custodian to see its fee rules."
      : library.state === "unmatched" && library.reason === "missing_custodian" ? "Choose the delivering firm from the custodian library to see its fee rules."
      : library.state === "unmatched" && library.reason === "conflict" ? "The transfer and linked tracker record name different custodians. Confirm the custodian before reviewing its fees."
      : library.state === "unmatched" && library.reason === "ambiguous" ? "More than one custodian matches this transfer. Confirm the correct custodian in the library."
      : "No matching custodian fee library entry was found. Confirm the transferring custodian.";
    return <section className="section" aria-label="Custodian fee library"><div className="sectionbody"><h3>Custodian fee library</h3><p className="fee-review-notes" role="status">{message}</p></div></section>;
  }
  const custodian = library.custodian;
  return <details className="section workflow-section" open>
    <summary className="sectionhead"><h3>Custodian fee library · {custodian.name}</h3></summary>
    <div className="sectionbody">
      <div className="row small">
        <span>Review status: {value(custodian.reviewStatus)}</span>
        <span>Documentation: {value(custodian.documentationStatus)}</span>
        <a href="/acat-tracking?view=library">Open custodian library</a>
      </div>
      <p className="fee-review-notes">Review the account type, transfer scope and direction for each rule. The charged fee is recorded separately above.</p>
      {custodian.fees.length === 0 ? <p className="fee-review-notes">No fee rules recorded. This does not establish that the transfer is free.</p> :
        <div className="findings">{custodian.fees.map(fee => <article key={fee.id}>
          <div className="row between"><h3>{value(fee.feeType)}</h3><strong>{money(fee.amount)}</strong></div>
          <div className="tablewrap"><table aria-label={`${value(fee.feeType)} fee rule`}><tbody>
            <Field label="Amount qualification">{value(fee.amountText)}</Field>
            <Field label="Account type">{value(fee.accountType)}</Field>
            <Field label="Transfer scope">{value(fee.transferType)}</Field>
            <Field label="Direction">{feeDirectionLabel(fee.direction)}</Field>
            <Field label="Notes">{value(fee.notes)}</Field>
            <Field label="Documentation / source">{value(fee.documentation)}</Field>
            <Field label="Last updated">{date(fee.updatedAt)}</Field>
          </tbody></table></div>
        </article>)}</div>}
      <p className="small fee-review-notes">Legacy base ACAT fee: {money(custodian.acatFeeAmount)}. Use the detailed rules and qualifications to establish the applicable fee.</p>
      <h3>Fee schedule documents</h3>
      {custodian.feeSchedules?.length ? <ul className="small">{custodian.feeSchedules.map(file =>
        <li key={file.id}>{file.filename} · {(file.byteSize / 1024).toFixed(1)} KB · added {date(file.createdAt)}</li>,
      )}</ul> : <p className="fee-review-notes">No fee schedule documents recorded.</p>}
    </div>
  </details>;
}

function feeValue(field: string, text: string | null, feeRequestsHref: string | null) {
  if (!text?.trim()) return "Not recorded";
  if (field === "feeCreditRequestId" && feeRequestsHref) return <a href={reimbursementRequestHref(feeRequestsHref, text)}>{text}</a>;
  if (field === "feeApexTicket") {
    try {
      const url = new URL(text);
      if (url.protocol === "https:" && !url.username && !url.password) return <a href={url.href} target="_blank" rel="noreferrer">{text}</a>;
    } catch { /* A ticket identifier can be plain text. */ }
  }
  return text;
}

function StoredFeeDetails({ review, feeRequestsHref }: { review: TransferFeeReview; feeRequestsHref: string | null }) {
  const actual = review.actual;
  const fee = actual.state === "ready" || actual.state === "partial" ? actual.fee : null;
  const note = actual.state === "partial" ? "Stored tracker details are shown below. The fee service could not be refreshed; editing is unavailable."
    : actual.state === "off" ? "Fee details are not enabled in this environment."
    : actual.state === "not_linked" ? "Link this transfer to its Transfer Tracker record to load and document the charged fee."
    : actual.state === "restricted" ? "Fee details are available to Operations and Admin."
    : actual.state === "unavailable" ? "The linked tracker fee details could not be loaded. Fee status is unknown."
    : null;
  return <section className="section" aria-label="Recorded fee details">
    <div className="sectionhead"><h3>Fee details · Transfer Tracker</h3></div>
    <div className="sectionbody">
    {note && <p className="fee-review-notes" role="status">{note}</p>}
    {fee && <div className="tablewrap"><table aria-label="Recorded tracker fee fields"><tbody>{FEE_FIELDS.map(field =>
      <Field key={field.key} label={field.label}>{feeValue(field.key, fee[field.key], feeRequestsHref)}</Field>,
    )}</tbody></table></div>}
    </div>
  </section>;
}

function RequestHistory({ review, fee, href }: { review: TransferFeeReview; fee: TransferFee | null; href: string | null }) {
  const requests = review.requests;
  const note = requests.state === "off" ? "Operations fee requests are not enabled in this environment."
    : requests.state === "restricted" ? "Reimbursement details are available to Operations and Admin."
    : requests.state === "not_linked" ? "Link the tracker record to load reimbursement requests."
    : requests.state === "unavailable" ? "Reimbursement requests could not be loaded."
    : requests.state === "unmatched" ? `The linked transfer could not be matched to one ${requests.reason === "client" ? "client" : "Apex account"}. Requests are unavailable.`
    : null;
  return <section className="section" aria-label="Reimbursement requests">
    <div className="sectionhead"><h3>Reimbursement requests · Operations Tools</h3></div>
    <div className="sectionbody">
    {note ? <p className="fee-review-notes" role="status">{note}</p> : requests.state === "ready" && <>
      <p className="small">{requests.accountLabel}</p>
      <p className="small fee-review-notes">Requests below belong to this account. Match the Fee Credit Req ID above to identify the request for this transfer.</p>
      {requests.requests.length === 0 ? <p className="fee-review-notes">No requests found for this client and account.</p> :
        <div className="findings tablewrap">{requests.requests.map(request => {
          const chip = reimbursementStatusChip(request.status);
          return <article key={request.id}>
            <div className="row between"><strong>{chip.label}</strong><span>{request.feeAmount === null ? "Amount not recorded" : `$${request.feeAmount}`}</span></div>
            <p>{[FEE_REQUEST_KIND_LABELS[request.kind], ...request.feeTypes].join(" · ")}</p>
            <p>Submitted {date(request.submittedAt)}{request.creditedAt ? ` · Credited ${date(request.creditedAt)}` : ""}</p>
            <p>{href ? <a href={reimbursementRequestHref(href, request.id)}>{request.id}</a> : request.id}
              {request.id === fee?.feeCreditRequestId && <strong> · Linked to this transfer</strong>}</p>
          </article>;
        })}</div>}
      {requests.truncated && <p className="fee-review-notes">{feeRequestsTruncatedNote(TRANSFER_FEE_REQUESTS_LIMIT)}</p>}
    </>}
    {href && <p className="fee-review-notes"><a href={href}>Open Operations fee requests</a></p>}
    </div>
  </section>;
}

export type TransferFeeReviewViewProps = {
  review: TransferFeeReview;
  clientName: string;
  archived: boolean;
  feeRequestsHref: string | null;
  reimbursement: boolean;
  requestsOnFile: boolean;
  legacyEntries: { recordedAt: string }[];
};

export function TransferFeeReviewView({ review, clientName, archived, feeRequestsHref, reimbursement, requestsOnFile, legacyEntries }: TransferFeeReviewViewProps) {
  const fee = review.actual.state === "ready" || review.actual.state === "partial" ? review.actual.fee : null;
  const editor = review.record !== null && review.recordId !== null && review.actual.state === "ready";
  const custodianId = review.library.state === "ready" ? review.library.custodian.id : review.record?.custodianId ?? null;
  return <section className="fee-review-notes" aria-label="Transfer fee review" data-testid="transfer-fee-review">
    <div className="row between"><h3>Fee review</h3><span className="small">Custodian library · Transfer Tracker · Operations Tools</span></div>
    {editor ? <>
      <p className="small fee-review-notes">{archived ? "This transfer is archived. Fee details are read-only." : "Document the charged fee on the linked tracker record. Reimbursement requests are reviewed in Operations Tools."}</p>
      <TransferFeeSection key={review.recordId} recordId={review.recordId!} refreshToken=""
        record={{ ...review.record!, clientName, custodianId }} initialFee={fee}
        initialRules={review.library.state === "ready" ? review.library.custodian.fees : undefined}
        readOnly={archived} showSchedule={review.library.state === "ready"}
        feeRequestsHref={feeRequestsHref} reimbursement={!archived && reimbursement} requestsOnFile={requestsOnFile} />
      {requestsOnFile && <p className="small fee-review-notes">Requests on file are account-wide. Match the Fee Credit Req ID to this transfer; a Pending or Approved request has not yet been credited.</p>}
      {!requestsOnFile && <RequestHistory review={review} fee={fee} href={feeRequestsHref} />}
    </> : <>
      <StoredFeeDetails review={review} feeRequestsHref={feeRequestsHref} />
      <RequestHistory review={review} fee={fee} href={feeRequestsHref} />
    </>}
    <LibraryDetails review={review} />
    {legacyEntries.length > 0 && <details className="fee-review-notes"><summary>Earlier workspace reimbursement entries ({legacyEntries.length})</summary>
      <p className="small fee-review-notes">These manual entries recorded an evidence confirmation and date. Amounts and request IDs were not stored with them.</p>
      <ul>{legacyEntries.map((entry, index) => <li key={`${entry.recordedAt}:${index}`}>Recorded {date(entry.recordedAt)}</li>)}</ul>
    </details>}
  </section>;
}
