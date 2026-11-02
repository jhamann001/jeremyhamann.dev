// Pure predicates for the transfer write affordances (WO TKT — New-transfer
// button + ACAT-link CTA). PURE: no Prisma, no React — unit-tested in
// test/transfer-write.test.ts and consumed by the board + detail server pages.
//
// These only gate whether the UI SHOWS a write affordance. The DB RLS write
// policies remain the real enforcement (TDD ADR-4): a VIEWER who reaches
// /asset-transfer/new by URL still hits a clean RLS rejection on submit. The
// gate uses an explicit current-role allowlist, centralised here and
// fail-closed — an unknown, retired, or missing role is never a writer.

const TRANSFER_WRITE_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
  "ADVISOR",
  "CLIENT_SERVICE",
]);

const FUNDING_PLAN_APPROVAL_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

/** Current application roles that may write transfers. */
export function canWriteTransfers(role: string | null | undefined): boolean {
  return role != null && TRANSFER_WRITE_ROLES.has(role);
}

/** Funding-plan approval is an Operations control, not a general edit right. */
export function canApproveFundingPlan(
  role: string | null | undefined,
): boolean {
  return role != null && FUNDING_PLAN_APPROVAL_ROLES.has(role);
}

/** Receipt, residual, ACAT rejection, and fee reimbursement. Not funding-plan approval. */
export function canRecordOperationsOnlyTransferFact(
  role: string | null | undefined,
): boolean {
  return role === "ADMIN" || role === "OPERATIONS";
}

/** Statement replacement, paperwork after approval, sent packet, signature, ACH initiation, check ticket, mailing. */
export function canRecordClientServiceTransferFact(
  role: string | null | undefined,
): boolean {
  return (
    role === "CLIENT_SERVICE" || role === "OPERATIONS" || role === "ADMIN"
  );
}

/**
 * Whether to render the "Link live ACAT status" CTA on a transfer detail:
 * only for a writer, and only when no ACAT is linked yet. When an id IS set
 * the detail page renders the live <AcatStatusSection> instead (no
 * regression); a VIEWER never sees the CTA (canWrite === false).
 */
export function showAcatLinkCta(args: {
  canWrite: boolean;
  acatTransferId: string | null | undefined;
}): boolean {
  const linked =
    typeof args.acatTransferId === "string" && args.acatTransferId.trim() !== "";
  return args.canWrite && !linked;
}
