"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { getCustodianLibrary } from "@/lib/data/custodian-library";
import { postTransferFee, readTransferFee } from "@/lib/data/acat-fee";
import { markAcatBookStale } from "@/lib/data/acat-workspace";
import {
  isFeeField,
  validRecordId,
  validRuleIds,
  type FeeActionResult,
  type FeeFailureCode,
  type FeeRulesResult,
} from "@/lib/data/acat-fee-view";
import { acatFeeReimbursementEnabled, acatOpsBookEnabled, acatOpsEditsEnabled } from "@/lib/flags";

// Fee section actions (ticket). Each one checks the session, the role, and
// the release switches before anything else; with the release off no tracker
// call is made. The playbook is never written from here. Reimbursements are not
// logged from here: ticket moved them to the Operations Tools fee-request page,
// so no action posts the tracker's `log` write.

type Gate = { ok: true; role: string } | { ok: false; code: FeeFailureCode };

async function gate(): Promise<Gate> {
  const session = await auth();
  if (!session?.user) return { ok: false, code: "forbidden" };
  if (!(acatOpsBookEnabled() && acatOpsEditsEnabled() && acatFeeReimbursementEnabled())) return { ok: false, code: "off" };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canSeeUnlinkedAcats(role) || !canReadCustodianLibrary(role)) return { ok: false, code: "forbidden" };
  return { ok: true, role };
}

function refusal(code: FeeFailureCode): FeeActionResult {
  return { ok: false, code, fee: null, log: null };
}

function wrote(result: FeeActionResult): FeeActionResult {
  if (result.ok) {
    markAcatBookStale();
    revalidatePath("/acat-tracking");
  }
  return result;
}

export async function loadTransferFee(recordId: string): Promise<FeeActionResult> {
  const allowed = await gate();
  if (!allowed.ok) return refusal(allowed.code);
  if (!validRecordId(recordId)) return refusal("invalid");
  return readTransferFee(recordId);
}

export async function saveTransferFeeField(recordId: string, field: string, value: string): Promise<FeeActionResult> {
  const allowed = await gate();
  if (!allowed.ok) return refusal(allowed.code);
  if (!validRecordId(recordId) || !isFeeField(field) || typeof value !== "string") return refusal("invalid");
  return wrote(await postTransferFee(recordId, { action: "save", fields: { [field]: value } }));
}

export async function applyTransferFeeRules(recordId: string, feeRuleIds: string[]): Promise<FeeActionResult> {
  const allowed = await gate();
  if (!allowed.ok) return refusal(allowed.code);
  if (!validRecordId(recordId) || !validRuleIds(feeRuleIds)) return refusal("invalid");
  return wrote(await postTransferFee(recordId, { action: "apply", feeRuleIds }));
}

/** The matching custodian's fee rules from the custodian library; an unknown custodian has none. */
export async function loadFeeRules(custodianId: string | null): Promise<FeeRulesResult> {
  const allowed = await gate();
  if (!allowed.ok) return { ok: false, reason: allowed.code === "off" ? "off" : "forbidden" };
  if (typeof custodianId !== "string" || custodianId === "" || custodianId.length >= 200) return { ok: true, rules: [] };
  try {
    const library = await getCustodianLibrary(allowed.role);
    const custodian = library.custodians.find((c) => c.id === custodianId);
    return {
      ok: true,
      rules: (custodian?.fees ?? []).map((fee) => ({
        id: fee.id, feeType: fee.feeType, accountType: fee.accountType, transferType: fee.transferType,
        direction: fee.direction, amount: fee.amount, amountText: fee.amountText, notes: fee.notes,
      })),
    };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
