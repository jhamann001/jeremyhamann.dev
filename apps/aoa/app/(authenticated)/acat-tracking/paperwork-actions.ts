"use server";

import { auth } from "@/auth";
import { getAcatStatusByRecordId } from "@/lib/data/acat-status";
import { getCustodianLibrary } from "@/lib/data/custodian-library";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import {
  confirmTrackerReceivingTitle,
  generateTrackerTransferForm,
  loadTrackerTransferForm,
  TransferFormBridgeError,
  type TransferFormActor,
} from "@/lib/data/transfer-form-bridge";
import { acatOpsEditsEnabled, acatPaperworkEnabled } from "@/lib/flags";
import {
  confirmReceivingTitleSchema,
  generateTransferFormSchema,
  type ConfirmReceivingTitle,
  type GenerateTransferForm,
  type TransferFormPreparation,
} from "@/lib/transfers/transfer-form-contract";
import type { PaperworkCustodian, PaperworkFailureReason } from "@/lib/transfers/paperwork-section";
import { resolveTransferPreparation, type PreparationContext } from "@/lib/transfers/transfer-preparation";

// ticket: gated reads and writes behind the paperwork section of the transfer
// drawer. They reuse the ticket preparation endpoints through the existing
// bridge; no second contract. Order is fixed: session and role, then the paperwork
// gate, then the edits gate (writes only), then input checks, then any tracker call.

const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WATCHOUT_DEADLINE_MS = 8_000;

type Failure = { ok: false; reason: PaperworkFailureReason };
export type PaperworkResult<T> = { ok: true; data: T } | Failure;
export type PaperworkWatchoutsResult =
  | {
    ok: true;
    custodian: PaperworkCustodian | null;
    match: "MATCHED" | "CONFIRMATION_REQUIRED" | "AMBIGUOUS" | "UNKNOWN";
    candidates: string[];
    retrievedAt: string;
    checkedAt: string;
  }
  | Failure;

type Gate = { ok: true; actor: TransferFormActor } | Failure;

async function gate(kind: "read" | "write"): Promise<Gate> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const email = session?.user?.email;
  if (!email || (role !== "ADMIN" && role !== "OPERATIONS") || !canReadCustodianLibrary(role)) {
    return { ok: false, reason: "forbidden" };
  }
  if (!acatPaperworkEnabled()) return { ok: false, reason: "off" };
  if (kind === "write" && !acatOpsEditsEnabled()) return { ok: false, reason: "off" };
  return { ok: true, actor: { email, role } };
}

function failed(action: string, error: unknown): Failure {
  const reason: PaperworkFailureReason = error instanceof TransferFormBridgeError ? error.reason : "unavailable";
  // One bounded line: the action and a member of the failure set. No identifier,
  // title, error message or payload ever reaches the log.
  console.error(`[acat-paperwork] ${action} ${reason}`);
  return { ok: false, reason };
}

export async function loadPaperwork(recordId: string): Promise<PaperworkResult<TransferFormPreparation>> {
  const allowed = await gate("read");
  if (!allowed.ok) return allowed;
  try {
    return { ok: true, data: await loadTrackerTransferForm(allowed.actor, recordId) };
  } catch (error) {
    return failed("load", error);
  }
}

export async function confirmPaperworkTitle(recordId: string, input: ConfirmReceivingTitle): Promise<PaperworkResult<TransferFormPreparation>> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  try {
    const parsed = confirmReceivingTitleSchema.safeParse(input);
    if (!parsed.success) return failed("confirm", new TransferFormBridgeError("invalid"));
    return { ok: true, data: await confirmTrackerReceivingTitle(allowed.actor, recordId, parsed.data) };
  } catch (error) {
    return failed("confirm", error);
  }
}

export async function generatePaperwork(recordId: string, input: GenerateTransferForm): Promise<PaperworkResult<{ documentId: string }>> {
  const allowed = await gate("write");
  if (!allowed.ok) return allowed;
  try {
    const parsed = generateTransferFormSchema.safeParse(input);
    if (!parsed.success) return failed("generate", new TransferFormBridgeError("invalid"));
    return { ok: true, data: await generateTrackerTransferForm(allowed.actor, recordId, parsed.data) };
  } catch (error) {
    return failed("generate", error);
  }
}

/** The current custodian playbook for this transfer. A live library read every
 * call (never cached), matched with the AoA custodian rules, so a playbook change
 * made after the transfer opened shows on the next reload. */
export async function loadPaperworkWatchouts(recordId: string): Promise<PaperworkWatchoutsResult> {
  const allowed = await gate("read");
  if (!allowed.ok) return allowed;
  if (!RECORD_ID.test(recordId)) return failed("watchouts", new TransferFormBridgeError("invalid"));
  try {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new Error("watchouts_source_timeout"));
      }, WATCHOUT_DEADLINE_MS);
    });
    let sources;
    try {
      sources = await Promise.race([
        Promise.all([
          getAcatStatusByRecordId(recordId, { signal: controller.signal }),
          getCustodianLibrary(allowed.actor.role),
        ]),
        expired,
      ]);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
    const [record, library] = sources;
    if (!record) return failed("watchouts", new TransferFormBridgeError("not_found"));
    const context: PreparationContext = {
      recordId,
      record: {
        direction: record.direction,
        type: record.type,
        accountType: record.accountType,
        transferringContra: record.transferringContra,
      },
      library,
    };
    const { custodianMatch } = resolveTransferPreparation(context);
    const profile = custodianMatch.status === "MATCHED" && custodianMatch.selected
      ? library.custodians.find((custodian) => custodian.id === custodianMatch.selected?.id)
      : undefined;
    const custodian: PaperworkCustodian | null = profile ? {
      id: profile.id,
      name: profile.name,
      reviewStatus: profile.reviewStatus,
      watchouts: profile.watchouts,
      letterOfAcceptance: profile.letterOfAcceptance,
      receivingAccountNumber: profile.receivingAccountNumber,
      medallionRequired: profile.medallionRequired,
      signature: profile.signature,
      returnMethod: profile.returnMethod,
      liquidationMethod: profile.liquidationMethod,
    } : null;
    return {
      ok: true,
      custodian,
      match: custodianMatch.status,
      candidates: custodian ? [] : custodianMatch.candidates.map((candidate) => candidate.name),
      retrievedAt: library.retrievedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return failed("watchouts", error);
  }
}
