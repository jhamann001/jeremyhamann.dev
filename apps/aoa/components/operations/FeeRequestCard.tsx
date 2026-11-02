"use client";

import Link from "next/link";
import { FeeRequestWorkflow } from "./FeeRequestWorkflow";
import { Pill } from "@/components/ui";
import type { OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";
import { feeRequestWaiverDates } from "@/lib/operations/fee-request-dates";
import styles from "@/app/(authenticated)/operations/fee-requests/page.module.css";

function kindLabel(kind: OperationsFeeRequestListRow["kind"]): string {
  if (kind === "FEE_CREDIT") return "Fee credit";
  if (kind === "SERVICE_GUARANTEE") return "Service guarantee";
  if (kind === "LARGE_HOUSEHOLD_EXCEPTION") return "$10M+ household billing exception";
  return "Billing exception";
}

function statusTone(status: OperationsFeeRequestListRow["status"]): "amber" | "green" | "red" | "gray" {
  if (status === "PENDING") return "amber";
  if (status === "APPROVED" || status === "CREDITED") return "green";
  if (status === "REJECTED") return "red";
  return "gray";
}

function statusLabel(status: OperationsFeeRequestListRow["status"]): string {
  if (status === "CREDITED") return "Credited";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function requestDetail(request: OperationsFeeRequestListRow): string {
  if (request.kind === "FEE_CREDIT") {
    return `${request.feeTypes.join(", ")} · $${Number(request.feeAmount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return request.indefiniteDuration ? "Indefinite" : `${request.waiverDurationMonths ?? "Not provided"} months`;
}

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(new Date(`${value}T00:00:00.000Z`));
}


export function FeeRequestCard({ request, defaultCreditedDate, open = false, onToggle, onOpen }: {
  request: OperationsFeeRequestListRow;
  defaultCreditedDate: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  onOpen?: () => void;
}) {
  const waiverDates = feeRequestWaiverDates(request);
  const hasWaiver = request.kind !== "FEE_CREDIT";

  return (<details className={styles.requestCard} id={`request-${request.id}`} data-request-id={request.id} open={open} onToggle={(event) => { if (event.target === event.currentTarget) onToggle?.(event.currentTarget.open); }}>
                  <summary className={`${styles.requestSummary}${hasWaiver ? ` ${styles.waiverSummary}` : ""}`}>
                    <span className={styles.summaryStatus}><Pill tone={statusTone(request.status)}>{statusLabel(request.status)}</Pill></span>
                    <span className={styles.summaryType}><b>{kindLabel(request.kind)}</b><small>{requestDetail(request)}</small></span>
                    <span className={styles.summaryClient}><b>{request.clientName}</b><small>{request.householdName ?? "No household name"}</small></span>
                    {hasWaiver && (
                      <>
                        <span className={`${styles.summaryStart} ${styles.summaryDate}`}><small>Waiver start</small><b>{waiverDates.waiverStart}</b></span>
                        <span className={`${styles.summaryRestart} ${styles.summaryDate}`}><small>Billing restart</small><b>{waiverDates.billingRestart}</b></span>
                      </>
                    )}
                    <span className={styles.summaryMetadata}><b>{request.accounts.length} account{request.accounts.length === 1 ? "" : "s"}</b><small>{displayTimestamp(request.submittedAt)}</small></span>
                    <span className={styles.openLabel}>Open</span>
                  </summary>
                  <div className={styles.requestBody}>
                    <div className={styles.detailHeading}>
                      <div>
                        <h3>Submitted request</h3>
                        {onOpen && <Link href={`/operations/fee-requests?request=${encodeURIComponent(request.id)}`} onClick={onOpen} prefetch={false}>Open request page →</Link>}
                        <p>The complete request as it was recorded in AOA.</p>
                      </div>
                      <Pill tone={statusTone(request.status)}>{statusLabel(request.status)}</Pill>
                    </div>
                    <div className={styles.requestFacts}>
                      <div><span>Request type</span><b>{kindLabel(request.kind)}</b></div>
                      {request.kind === "FEE_CREDIT" ? (
                        <>
                          <div><span>Fee type{request.feeTypes.length === 1 ? "" : "s"}</span><b>{request.feeTypes.length ? request.feeTypes.join(", ") : "Not provided"}</b></div>
                          <div><span>Requested credit amount</span><b>${Number(request.feeAmount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
                        </>
                      ) : (
                        <>
                          <div><span>Waiver start</span><b>{waiverDates.waiverStart}</b></div>
                          <div><span>Billing restart</span><b>{waiverDates.billingRestart}</b></div>
                          <div><span>Duration</span><b>{request.indefiniteDuration ? "Indefinite" : `${request.waiverDurationMonths ?? "Not provided"} months`}</b></div>
                        </>
                      )}
                      <div>
                        <span>{request.scope === "HOUSEHOLD" ? "Legacy source reference" : "Client"}</span>
                        <b>{request.clientName}</b>
                        <small>{request.householdName ?? "No household name"}</small>
                      </div>
                      <div><span>Request scope</span><b>{request.scope === "HOUSEHOLD" ? "Household" : "Client"}</b>{request.canonicalClientName && <small>Canonical contact: {request.canonicalClientName}</small>}</div>
                      <div><span>Submitted by</span><b>{request.submittedBy}</b><small>{displayTimestamp(request.submittedAt)}</small></div>
                      <div className={styles.wideFact}><span>Accounts</span>{request.accounts.map((account) => <b key={account.id}>{account.label}{account.ownerName ? ` · ${account.ownerName}` : ""}</b>)}</div>
                      <div className={styles.wideFact}><span>Reason or context</span><b>{request.reason || "No context provided"}</b></div>
                      <div className={styles.wideFact}><span>Relevant tickets</span><b>{request.relevantTicketRefs.length ? request.relevantTicketRefs.join(", ") : "None provided"}</b></div>
                      <div><span>Request ID</span><b>{request.id}</b></div>
                      {request.legacySource && <div><span>Imported source</span><b>{request.legacySource}</b><small>Source record {request.legacySourceId ?? "unavailable"}</small></div>}
                      {request.legacyApexContext && <div><span>Legacy Apex context</span><b>{request.legacyApexContext}</b></div>}
                      {request.reviewedAt && <div><span>Reviewed</span><b>{request.reviewedBy}</b><small>{displayTimestamp(request.reviewedAt)}</small></div>}
                      {request.creditedAt && <div><span>Credit completed</span><b>{displayDate(request.creditedAt)}</b><small>Apex request {request.apexRequestId}</small>{request.completedBy && request.completedAt && <small>{request.completedBy} · {displayTimestamp(request.completedAt)}</small>}</div>}
                    </div>
                    <div className={styles.workflowPanel} onSubmitCapture={onOpen}>
                      <FeeRequestWorkflow request={request} defaultCreditedDate={defaultCreditedDate} />
                    </div>
                    <details className={styles.history}>
                      <summary>Workflow history ({request.events.length})</summary>
                      <ol>
                        {request.events.map((event) => (
                          <li key={event.id}>
                            <b>{statusLabel(event.toStatus ?? request.status)}</b>
                            <span>{displayTimestamp(event.at)} · {event.actorDisplay}</span>
                            {event.note && <p>{event.note}</p>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </div>
                </details>);
}
