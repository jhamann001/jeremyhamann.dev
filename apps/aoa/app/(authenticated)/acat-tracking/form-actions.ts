"use server";

import { auth } from "@/auth";
import {
  confirmTrackerReceivingTitle, updateTrackerTransferScope, generateTrackerTransferForm, loadTrackerTransferForm,
  TransferFormBridgeError, type TransferFormActor,
} from "@/lib/data/transfer-form-bridge";
import type { ConfirmReceivingTitle, UpdateTransferScope, GenerateTransferForm, TransferFormPreparation, TransferFormResult } from "@/lib/transfers/transfer-form-contract";

async function perform<T>(operation: (actor: TransferFormActor) => Promise<T>): Promise<TransferFormResult<T>> {
  try {
    const session = await auth();
    const role = (session?.user as { role?: string } | undefined)?.role;
    if (!session?.user?.email || (role !== "ADMIN" && role !== "OPERATIONS")) return { ok: false, reason: "forbidden" };
    return { ok: true, data: await operation({ email: session.user.email, role }) };
  } catch (error) {
    return { ok: false, reason: error instanceof TransferFormBridgeError ? error.reason : "unavailable" };
  }
}

export async function loadTransferForm(recordId: string): Promise<TransferFormResult<TransferFormPreparation>> {
  return perform((actor) => loadTrackerTransferForm(actor, recordId));
}
export async function confirmReceivingTitle(recordId: string, input: ConfirmReceivingTitle): Promise<TransferFormResult<TransferFormPreparation>> {
  return perform((actor) => confirmTrackerReceivingTitle(actor, recordId, input));
}
export async function generateTransferForm(recordId: string, input: GenerateTransferForm): Promise<TransferFormResult<{ documentId: string }>> {
  return perform((actor) => generateTrackerTransferForm(actor, recordId, input));
}
export async function updateTransferScope(recordId: string, input: UpdateTransferScope): Promise<TransferFormResult<TransferFormPreparation>> {
  return perform((actor) => updateTrackerTransferScope(actor, recordId, input));
}
