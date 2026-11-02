import { normalizeAppRole } from "@/lib/auth/app-roles";
import { acatFeeReimbursementEnabled, acatFeeRequestCreateEnabled, operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";

// Stage 1 of the staged fee decision on epic ticket (work order ticket):
// the ACAT drawer's fee section links to the Operations Tools fee-request page
// for reimbursement status, history and Log Reimbursement. The page supports no
// client or account query state, so the link carries no parameters.

/** Canonical route of `app/(authenticated)/operations/fee-requests/page.tsx`. */
export const OPERATIONS_FEE_REQUESTS_HREF = "/operations/fee-requests";

/**
 * The destination when this role may open it, else null. It applies the same two
 * checks the destination page applies before it renders, so the drawer never
 * receives a link its user would only find a 404 behind. Server side only.
 */
export function acatFeeRequestsHref(role: string | null | undefined): string | null {
  return operationsFeeRequestsPreviewEnabled() && canAccessOperationsTools(role)
    ? OPERATIONS_FEE_REQUESTS_HREF
    : null;
}

/**
 * Whether Log Reimbursement opens the preview-and-confirm flow (ticket) instead of the link-out:
 * the create release is on, the Operations Tools fee requests it writes to are on, and the role is
 * one the create path accepts. Off keeps the ticket link. Server side only; the actions check again.
 */
export function acatReimbursementCreateEnabled(role: string | null | undefined): boolean {
  const normalized = normalizeAppRole(role);
  return acatFeeRequestCreateEnabled()
    && operationsFeeRequestsPreviewEnabled()
    && (normalized === "ADMIN" || normalized === "OPERATIONS");
}

/**
 * Whether the fee section lists the Operations Tools requests already on file: the fee
 * release is on, the Operations Tools fee requests it reads are on, and the role is one the read admits.
 * Server side only; the action checks again.
 */
export function acatFeeRequestsReadEnabled(role: string | null | undefined): boolean {
  const normalized = normalizeAppRole(role);
  return acatFeeReimbursementEnabled()
    && operationsFeeRequestsPreviewEnabled()
    && (normalized === "ADMIN" || normalized === "OPERATIONS");
}
