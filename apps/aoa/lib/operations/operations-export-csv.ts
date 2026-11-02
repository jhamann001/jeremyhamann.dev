import { toCsv } from "@/lib/deals/import-csv";
import type { OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";
import { feeRequestWaiverDates } from "@/lib/operations/fee-request-dates";
import { meridianMatchRate, formatMatchRate } from "@/lib/operations/trade-reconciliation";

export const FEE_REQUEST_EXPORT_COLUMNS = [
  "Request ID",
  "Request type",
  "Status",
  "Request scope",
  "Client",
  "Canonical contact",
  "Household",
  "Fee types",
  "Requested credit amount",
  "Waiver start",
  "Billing restart",
  "Duration",
  "Accounts",
  "Reason or context",
  "Relevant tickets",
  "Submitted by",
  "Submitted at",
  "Reviewed by",
  "Reviewed at",
  "Credit completed",
  "Apex request ID",
  "Completed by",
  "Completed at",
  "Imported source",
  "Source record",
  "Legacy Apex context",
  "Workflow history",
] as const;

export const TRADE_RECONCILIATION_EXPORT_COLUMNS = [
  "Run ID",
  "Run date",
  "Trade date",
  "Completed at",
  "Apex records",
  "Meridian records",
  "Raw matches",
  "Explained",
  "Unresolved",
  "Meridian match rate",
  "Run note",
] as const;

export type TradeReconciliationRunExport = {
  id: string;
  runDate: string;
  tradeDate: string;
  completedAt: string;
  apexRecords: number;
  meridianRecords: number;
  matched: number;
  explained: number;
  unresolved: number;
  runNote: string;
};

function csvText(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function kindLabel(kind: OperationsFeeRequestListRow["kind"]): string {
  switch (kind) {
    case "FEE_CREDIT":
      return "Fee credit";
    case "SERVICE_GUARANTEE":
      return "Service guarantee";
    case "BILLING_EXCEPTION":
      return "Billing exception";
    case "LARGE_HOUSEHOLD_EXCEPTION":
      return "$10M+ household billing exception";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function statusLabel(status: OperationsFeeRequestListRow["status"]): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "APPROVED":
      return "Approved";
    case "CREDITED":
      return "Credited";
    case "REJECTED":
      return "Rejected";
    case "CANCELLED":
      return "Cancelled";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function workflowHistory(request: OperationsFeeRequestListRow): string {
  return request.events.map((event) => {
    const status = statusLabel(event.toStatus ?? request.status);
    const note = event.note ? ` — ${event.note}` : "";
    return `${event.at} ${status} · ${event.actorDisplay}${note}`;
  }).join(" | ");
}

function feeRequestCells(request: OperationsFeeRequestListRow): string[] {
  const credit = request.kind === "FEE_CREDIT";
  const waiver = credit ? null : feeRequestWaiverDates(request);
  const duration = credit
    ? ""
    : request.indefiniteDuration
      ? "Indefinite"
      : `${request.waiverDurationMonths ?? "Not provided"} months`;
  return [
    request.id,
    kindLabel(request.kind),
    statusLabel(request.status),
    request.scope === "HOUSEHOLD" ? "Household" : "Client",
    request.clientName,
    request.canonicalClientName ?? "",
    request.householdName ?? "",
    credit ? request.feeTypes.join(", ") : "",
    credit ? request.feeAmount ?? "" : "",
    waiver?.waiverStart ?? "",
    waiver?.billingRestart ?? "",
    duration,
    request.accounts.map((account) => account.ownerName ? `${account.label} · ${account.ownerName}` : account.label).join(" | "),
    request.reason,
    request.relevantTicketRefs.join(", "),
    request.submittedBy,
    request.submittedAt,
    request.reviewedBy ?? "",
    request.reviewedAt ?? "",
    request.creditedAt ?? "",
    request.apexRequestId ?? "",
    request.completedBy ?? "",
    request.completedAt ?? "",
    request.legacySource ?? "",
    request.legacySourceId ?? "",
    request.legacyApexContext ?? "",
    workflowHistory(request),
  ].map(csvText);
}

export function feeRequestExportFilename(area: "credits" | "exceptions"): string {
  return area === "credits" ? "fee-credits.csv" : "service-guarantees-and-billing-exceptions.csv";
}

export function feeRequestsToCsv(requests: readonly OperationsFeeRequestListRow[]): string {
  return toCsv([
    [...FEE_REQUEST_EXPORT_COLUMNS],
    ...requests.map(feeRequestCells),
  ]);
}

export function tradeReconciliationRunsToCsv(runs: readonly TradeReconciliationRunExport[]): string {
  return toCsv([
    [...TRADE_RECONCILIATION_EXPORT_COLUMNS],
    ...runs.map((run) => [
      run.id,
      run.runDate,
      run.tradeDate,
      run.completedAt,
      String(run.apexRecords),
      String(run.meridianRecords),
      String(run.matched),
      String(run.explained),
      String(run.unresolved),
      formatMatchRate(meridianMatchRate(run.matched, run.meridianRecords), run.meridianRecords),
      run.runNote,
    ].map(csvText)),
  ]);
}

export function csvAttachment(body: string, filename: string, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/csv; charset=utf-8");
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Vary", "Cookie");
  return new Response(`\uFEFF${body}`, { headers });
}
