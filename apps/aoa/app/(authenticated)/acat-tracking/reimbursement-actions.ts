"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import {
  createReimbursementRequest,
  readPendingReimbursements,
  readReimbursementPrefill,
} from "@/lib/data/acat-reimbursement";
import {
  isClientSfId,
  isSubmissionKey,
  REIMBURSEMENT_FEE_TYPES,
  validCedarRidgeUserHint,
  validMaskedAccountHint,
  validReimbursementRecordId,
  type ReimbursementFailureCode,
  type ReimbursementPendingResult,
  type ReimbursementPreviewResult,
  type ReimbursementSubmitInput,
  type ReimbursementSubmitResult,
} from "@/lib/data/acat-reimbursement-view";
import { acatFeeRequestCreateEnabled, acatOpsBookEnabled, acatOpsEditsEnabled, operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { OPERATIONS_FEE_REQUESTS_HREF } from "@/lib/operations/fee-request-link";

// Reimbursement preview and confirm for the fee section (ticket). Each action checks the
// session, the release switches and the role before anything else. Previews and lookups only
// read. Submit is the only write: one Pending Operations Tools fee request through the
// intake's own create path. Nothing here calls the tracker, and the tracker's `log` write has
// no caller in AoA.

type Gate = { ok: true; identity: { role: string; email: string } } | { ok: false; code: ReimbursementFailureCode };

async function gate(): Promise<Gate> {
  const session = await auth();
  const email = session?.user?.email;
  if (!session?.user || !email) return { ok: false, code: "forbidden" };
  if (!(acatOpsBookEnabled() && acatOpsEditsEnabled() && acatFeeRequestCreateEnabled() && operationsFeeRequestsPreviewEnabled())) {
    return { ok: false, code: "off" };
  }
  const rawRole = (session.user as { role?: string }).role ?? "VIEWER";
  const role = normalizeAppRole(rawRole);
  if ((role !== "ADMIN" && role !== "OPERATIONS") || !canSeeUnlinkedAcats(rawRole) || !canReadCustodianLibrary(rawRole)) {
    return { ok: false, code: "forbidden" };
  }
  return { ok: true, identity: { role, email } };
}

/** The client and account this transfer resolves to, and the Pending requests on file for them. Writes nothing. */
export async function previewTransferReimbursement(
  recordId: string,
  hints: { cedarRidgeUserId: string | null; maskedAccount: string | null },
): Promise<ReimbursementPreviewResult> {
  const allowed = await gate();
  if (!allowed.ok) return { ok: false, code: allowed.code };
  if (!validReimbursementRecordId(recordId) || !hints || !validCedarRidgeUserHint(hints.cedarRidgeUserId) || !validMaskedAccountHint(hints.maskedAccount)) {
    return { ok: false, code: "invalid" };
  }
  try {
    const prefill = await readReimbursementPrefill(allowed.identity, { recordId, cedarRidgeUserId: hints.cedarRidgeUserId, maskedAccount: hints.maskedAccount });
    return { ok: true, prefill };
  } catch {
    console.error("[acat-reimbursement] preview_failed");
    return { ok: false, code: "unavailable" };
  }
}

/** Pending requests for the client and account chosen in the preview. Writes nothing. */
export async function lookupPendingReimbursements(clientSfId: string, accountId: string): Promise<ReimbursementPendingResult> {
  const allowed = await gate();
  if (!allowed.ok) return { ok: false, code: allowed.code };
  if (!isClientSfId(clientSfId) || typeof accountId !== "string" || accountId === "" || accountId.length > 128) {
    return { ok: false, code: "invalid" };
  }
  try {
    return { ok: true, pending: await readPendingReimbursements(allowed.identity, clientSfId, accountId) };
  } catch {
    console.error("[acat-reimbursement] pending_failed");
    return { ok: false, code: "unavailable" };
  }
}

function wellFormed(input: unknown): input is ReimbursementSubmitInput {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return isSubmissionKey(value.submissionKey)
    && isClientSfId(value.clientSfId)
    && typeof value.accountId === "string" && value.accountId !== "" && value.accountId.length <= 128
    && typeof value.feeAmount === "string" && value.feeAmount.length <= 32
    && Array.isArray(value.feeTypes) && value.feeTypes.length >= 1 && value.feeTypes.length <= REIMBURSEMENT_FEE_TYPES.length
    && value.feeTypes.every((type) => typeof type === "string" && type.length <= 40)
    && typeof value.reason === "string" && value.reason.length <= 4000
    && typeof value.tickets === "string" && value.tickets.length <= 6000;
}

/**
 * The only write. Creates one Pending fee request for the client and account the user confirmed.
 * The client and account ids come from the confirmed form and are verified against the client
 * directory by the create path; a name is never accepted in their place.
 */
export async function submitTransferReimbursement(input: ReimbursementSubmitInput): Promise<ReimbursementSubmitResult> {
  const allowed = await gate();
  if (!allowed.ok) return { ok: false, code: allowed.code, field: null };
  if (!wellFormed(input)) return { ok: false, code: "invalid", field: null };
  const result = await createReimbursementRequest(allowed.identity, {
    submissionKey: input.submissionKey,
    clientSfId: input.clientSfId,
    accountId: input.accountId,
    feeAmount: input.feeAmount,
    feeTypes: input.feeTypes,
    reason: input.reason,
    tickets: input.tickets,
  });
  if (result.ok) revalidatePath(OPERATIONS_FEE_REQUESTS_HREF);
  return result;
}
