"use server";

import { auth } from "@/auth";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { readTransferFeeRequests } from "@/lib/data/acat-reimbursement";
import type { TransferFeeRequestsFailureCode, TransferFeeRequestsResult } from "@/lib/data/acat-fee-requests-view";
import { validCedarRidgeUserHint, validMaskedAccountHint, validReimbursementRecordId } from "@/lib/data/acat-reimbursement-view";
import { acatFeeReimbursementEnabled, acatOpsBookEnabled, acatOpsEditsEnabled, operationsFeeRequestsPreviewEnabled } from "@/lib/flags";

// The requests-on-file read for the fee section. It checks the session, the fee release, the Operations
// Tools fee-request release and the role before anything else, then reads only. It writes nothing and
// calls neither the tracker nor FeeStore: the tracker reimbursement log is not part of this path.

type Gate = { ok: true; identity: { role: string; email: string } } | { ok: false; code: TransferFeeRequestsFailureCode };

async function gate(): Promise<Gate> {
  const session = await auth();
  const email = session?.user?.email;
  if (!session?.user || !email) return { ok: false, code: "forbidden" };
  if (!(acatOpsBookEnabled() && acatOpsEditsEnabled() && acatFeeReimbursementEnabled() && operationsFeeRequestsPreviewEnabled())) {
    return { ok: false, code: "off" };
  }
  const rawRole = (session.user as { role?: string }).role ?? "VIEWER";
  const role = normalizeAppRole(rawRole);
  if ((role !== "ADMIN" && role !== "OPERATIONS") || !canSeeUnlinkedAcats(rawRole) || !canReadCustodianLibrary(rawRole)) {
    return { ok: false, code: "forbidden" };
  }
  return { ok: true, identity: { role, email } };
}

/** The Operations Tools requests on file for the client and account this transfer resolves to. Writes nothing. */
export async function loadTransferFeeRequests(
  recordId: string,
  hints: { cedarRidgeUserId: string | null; maskedAccount: string | null },
): Promise<TransferFeeRequestsResult> {
  const allowed = await gate();
  if (!allowed.ok) return { ok: false, code: allowed.code };
  if (!validReimbursementRecordId(recordId) || !hints || !validCedarRidgeUserHint(hints.cedarRidgeUserId) || !validMaskedAccountHint(hints.maskedAccount)) {
    return { ok: false, code: "invalid" };
  }
  try {
    const read = await readTransferFeeRequests(allowed.identity, { recordId, cedarRidgeUserId: hints.cedarRidgeUserId, maskedAccount: hints.maskedAccount });
    return { ok: true, read };
  } catch {
    console.error("[acat-fee-requests] read_failed");
    return { ok: false, code: "unavailable" };
  }
}
