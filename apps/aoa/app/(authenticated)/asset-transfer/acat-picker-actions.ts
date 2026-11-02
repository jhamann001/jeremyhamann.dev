"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { attachAcatToTransfer, normalizeAcatTransferId } from "@/lib/data/acat-link";
import { fetchAcatList } from "@/lib/data/acat-status";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";
import {
  destinationConfirmationKey,
  pickerCandidates,
  pickerDestination,
  sourceConfirmationKey,
} from "@/lib/data/transfer-acat-picker";
import type {
  TransferAcatCandidatesResult,
  TransferAcatLinkInput,
  TransferAcatLinkResult,
} from "@/lib/data/transfer-acat-picker-types";

const FORBIDDEN = "Only Operations and Admin can find and link ACATs. Sign in with an authorized account and try again.";
const TARGET_UNAVAILABLE = "This transfer is unavailable, archived, or funded. Refresh the transfer before linking.";
const TARGET_LINKED = "This transfer already has an ACAT linked. Refresh the transfer to see its current link.";
const SOURCE_UNAVAILABLE = "Transfer Tracker is unavailable. Try loading the available ACATs again.";
const SOURCE_CHANGED = "The selected ACAT changed or is no longer available. Reload the list and review it again.";
const TARGET_CHANGED = "The transfer's client or household changed. Reload the list and review the destination again.";
const WRITE_FAILED = "The link could not be saved. Refresh the transfer and try again.";

// Select only the target identity and states used to authorize this operation.
const targetSelect = {
  id: true,
  client_sf_id: true,
  household_sf_id: true,
  client_first_name: true,
  client_last_name: true,
  household_name: true,
  stage: true,
  archived_at: true,
  acat_record_id: true,
  acat_transfer_id: true,
} satisfies Prisma.TransferSelect;

type PickerTarget = Prisma.TransferGetPayload<{ select: typeof targetSelect }>;

function targetError(target: PickerTarget | null): string | null {
  if (!target || target.archived_at != null || target.stage === "FUNDED") return TARGET_UNAVAILABLE;
  if (target.acat_record_id != null || target.acat_transfer_id != null) return TARGET_LINKED;
  return null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

async function pickerIdentity(): Promise<Identity | null> {
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  // This gate precedes EVERY database/source read, including target lookup.
  if (!session?.user || !canSeeUnlinkedAcats(role)) return null;
  return { role, email: session.user.email };
}

async function freshSourceRows() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    // Direct read: no cross-request workspace snapshot may authorize a link.
    return await fetchAcatList({ signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadTransferAcatCandidates(transferId: string): Promise<TransferAcatCandidatesResult> {
  try {
    const identity = await pickerIdentity();
    if (!identity) return { ok: false, message: FORBIDDEN };
    if (!validId(transferId)) return { ok: false, message: TARGET_UNAVAILABLE };

    const context = await withUserScope(identity, async (tx) => {
      const target = await tx.transfer.findUnique({ where: { id: transferId }, select: targetSelect });
      const message = targetError(target);
      if (message || !target) return { ok: false, message: message ?? TARGET_UNAVAILABLE } as const;
      // Archived rows retain link uniqueness. Include them, but project no
      // destination/client metadata from any other transfer to the browser.
      const links = await tx.transfer.findMany({
        where: { OR: [{ acat_record_id: { not: null } }, { acat_transfer_id: { not: null } }] },
        select: { acat_record_id: true, acat_transfer_id: true },
      });
      return { ok: true, target, links } as const;
    });
    if (!context.ok) return context;

    let rows;
    try { rows = await freshSourceRows(); }
    catch { return { ok: false, message: SOURCE_UNAVAILABLE }; }
    return {
      ok: true,
      destination: pickerDestination(context.target),
      candidates: pickerCandidates(rows, context.links),
    };
  } catch {
    // Do not return or log source/database errors, which may contain PII.
    return { ok: false, message: "Available ACATs could not be loaded. Refresh the transfer and try again." };
  }
}

export async function linkAcatRecordToTransfer(
  transferId: string,
  input: TransferAcatLinkInput,
): Promise<TransferAcatLinkResult> {
  try {
    const identity = await pickerIdentity();
    if (!identity) return { ok: false, message: FORBIDDEN };
    if (!validId(transferId)) return { ok: false, message: TARGET_UNAVAILABLE };
    if (!input || input.confirmed !== true || !validId(input.recordId)
      || typeof input.confirmationKey !== "string" || !/^[a-f0-9]{64}$/.test(input.confirmationKey)
      || typeof input.destinationConfirmationKey !== "string" || !/^[a-f0-9]{64}$/.test(input.destinationConfirmationKey)) {
      return { ok: false, message: "Select an ACAT and confirm that the client and accounts match before linking." };
    }

    // Authorize the target before the firm-wide source read. Do not keep a
    // database lock/transaction open while waiting on the external service.
    const target = await withUserScope(identity, (tx) => tx.transfer.findUnique({
      where: { id: transferId }, select: targetSelect,
    }));
    const message = targetError(target);
    if (message || !target) return { ok: false, message: message ?? TARGET_UNAVAILABLE };
    if (destinationConfirmationKey(target) !== input.destinationConfirmationKey) {
      return { ok: false, message: TARGET_CHANGED };
    }

    let rows;
    try { rows = await freshSourceRows(); }
    catch { return { ok: false, message: SOURCE_UNAVAILABLE }; }
    // The named list is the authoritative identity projection: the existing
    // by-record detail endpoint omits clientName. Resolve by record ID in a
    // NEW list read so names, accounts and UUID all participate in revalidation.
    const matches = rows.filter((row) => row.id === input.recordId);
    const selected = matches.length === 1 ? matches[0] : null;
    if (!selected || sourceConfirmationKey(selected) !== input.confirmationKey) {
      return { ok: false, message: SOURCE_CHANGED };
    }

    const result = await withUserScope(identity, async (tx): Promise<TransferAcatLinkResult> => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({ where: { id: transferId }, select: targetSelect });
      const currentError = targetError(current);
      if (currentError || !current) return { ok: false, message: currentError ?? TARGET_UNAVAILABLE };
      if (destinationConfirmationKey(current) !== input.destinationConfirmationKey) {
        return { ok: false, message: TARGET_CHANGED };
      }
      // Reuse the record + UUID duplicate checks, unique-index backstop,
      // link-only update and SAME-transaction audit. UUID comes only from source.
      const attached = await attachAcatToTransfer(tx, identity, transferId, {
        recordId: selected.id,
        acatTransferId: normalizeAcatTransferId(selected.acatTransferId),
      });
      return attached.ok ? { ok: true } : { ok: false, message: attached.errors[0]?.message ?? WRITE_FAILED };
    });
    if (!result.ok) return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, message: "This ACAT is already linked to a transfer. Reload the list and choose another ACAT." };
    }
    return { ok: false, message: WRITE_FAILED };
  }

  // The mutation has committed. A cache-refresh failure must not report that
  // nothing was saved and invite another write; the client also refreshes.
  try {
    revalidatePath(`/asset-transfer/${transferId}`);
    revalidatePath("/asset-transfer");
    revalidatePath("/acat-tracking");
  } catch { /* Saved successfully; the next navigation reads the persisted link. */ }
  return { ok: true };
}
