// Pure, client-safe contract for the "requests on file" list in the ACAT drawer's fee section. The
// server read, the server action, the list component, and the tests import from here. Nothing in this
// file reads a flag, a session, a database, or the tracker.

import type { ReimbursementRequestStatus } from "./acat-reimbursement-view";

/** The most requests one open transfer lists; the server reads one more to know whether it cut the list. */
export const TRANSFER_FEE_REQUESTS_LIMIT = 50;

export type TransferFeeRequestKind = "FEE_CREDIT" | "SERVICE_GUARANTEE" | "BILLING_EXCEPTION" | "LARGE_HOUSEHOLD_EXCEPTION";

export const FEE_REQUEST_KIND_LABELS: Record<TransferFeeRequestKind, string> = {
  FEE_CREDIT: "Fee credit",
  SERVICE_GUARANTEE: "Service guarantee",
  BILLING_EXCEPTION: "Billing exception",
  LARGE_HOUSEHOLD_EXCEPTION: "Large household exception",
};

/** One Operations Tools request, trimmed to what the section shows (no emails, reasons, tickets or events). */
export type TransferFeeRequest = {
  id: string;
  kind: TransferFeeRequestKind;
  status: ReimbursementRequestStatus;
  feeAmount: string | null;
  feeTypes: string[];
  submittedAt: string;
  creditedAt: string | null;
};

/**
 * `resolved`: the transfer is tied to one client and one Apex account by id, and `requests` is every
 * request on file for them (newest first, at most the limit). `unresolved`: no such tie exists, so
 * nothing is read and the section must not claim there are none.
 */
export type TransferFeeRequestsRead =
  | { identity: "resolved"; clientName: string; accountLabel: string; requests: TransferFeeRequest[]; truncated: boolean }
  | { identity: "unresolved"; reason: "client" | "account" };

export type TransferFeeRequestsFailureCode = "off" | "forbidden" | "invalid" | "unavailable";

export type TransferFeeRequestsResult =
  | { ok: true; read: TransferFeeRequestsRead }
  | { ok: false; code: TransferFeeRequestsFailureCode };

export const FEE_REQUESTS_COPY = {
  title: "Requests on file",
  loading: "Checking the requests on file...",
  none: "No reimbursement requests are on file for this client and account.",
  unresolvedClient: "This transfer could not be matched to a specific client, so its existing requests are not shown.",
  unresolvedAccount: "This transfer could not be matched to one Apex account, so its existing requests are not shown.",
  failed: "The requests on file could not be loaded.",
  retry: "Retry",
  open: "Open",
  credited: "Credited",
  submitted: "Submitted",
} as const;

export function feeRequestsTruncatedNote(limit: number): string {
  return `Showing the ${limit} most recent requests. Open Operations Tools for the rest.`;
}
