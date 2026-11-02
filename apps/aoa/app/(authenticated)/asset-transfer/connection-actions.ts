"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit, TRANSFER_UPDATE } from "@/lib/audit";
import { assetMapTransferLinkEnabled, assetTransferWorkspaceEnabled } from "@/lib/flags";
import { canWriteTransfers } from "@/lib/data/transfer-write";
import { canReviewAssetMapLinks } from "@/lib/data/asset-map-review-authz";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";
import { fundingPlanInvalidation } from "@/lib/data/transfer-plan-approval";
import { listAssignableAssetMapAccounts, type AssetMapAccountOption } from "@/lib/data/transfer-asset-map";
import {
  listCustodianOptions,
  openApexReceivingOptions,
  readApexAccountRows,
  readCustodianOption,
  readDealOptions,
  readDirectoryClient,
  searchDirectoryClients,
  type DealOption,
  type IntakeReceivingOption,
} from "@/lib/data/transfer-connections";
import type { ConnectedClient, CustodianOption } from "@/lib/transfers/connections";
import { scheduleCrmIdentityReconciliation } from "@/lib/crm/post-commit-signal";

// Workspace-only (ASSET_TRANSFER_WORKSPACE) reads and writes that tie a
// transfer to the AOA records it names. Identity always comes from auth();
// each write is one withUserScope transaction with its audit entry, so RLS
// remains the write gate. With the flag off every action refuses.

export type ConnectionResult = { ok: true } | { ok: false; error: string };

const REFUSED: ConnectionResult = { ok: false, error: "Save failed. The record may have changed, or your role cannot make this change." };

async function identityFromSession(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
}

async function writer(): Promise<Identity | null> {
  if (!assetTransferWorkspaceEnabled()) return null;
  const identity = await identityFromSession();
  return canWriteTransfers(identity.role) && identity.email ? identity : null;
}

const clientKey = (value: string | null | undefined) => (value ?? "").trim().slice(0, 15).toUpperCase();

function revalidateTransfer(id: string): void {
  revalidatePath("/asset-transfer");
  revalidatePath(`/asset-transfer/${id}`);
}

export type ClientSearchResult = { ok: true; clients: ConnectedClient[] } | { ok: false };

/** The client directory search behind the intake and the edit dialog's client picker. */
export async function searchTransferClients(query: string): Promise<ClientSearchResult> {
  const identity = await writer();
  if (!identity || typeof query !== "string" || query.length > 120) return { ok: false };
  try {
    return { ok: true, clients: await searchDirectoryClients(identity, query) };
  } catch {
    return { ok: false };
  }
}

export type IntakeOptions =
  | {
      ok: true;
      client: ConnectedClient;
      deals: DealOption[];
      receiving: IntakeReceivingOption[];
      custodians: CustodianOption[] | null;
      assetMaps: AssetMapAccountOption[] | null;
    }
  | { ok: false };

/** Everything the intake offers for one directory client, read under the caller's scope. */
export async function loadTransferIntakeOptions(clientSfId: string): Promise<IntakeOptions> {
  const identity = await writer();
  if (!identity || typeof clientSfId !== "string" || !clientSfId.trim() || clientSfId.length > 64) return { ok: false };
  try {
    const read = await withUserScope(identity, async (tx) => {
      const client = await readDirectoryClient(tx, clientSfId);
      if (!client) return null;
      const deals = await readDealOptions(tx, client.sfId, client.householdSfId);
      const receiving = openApexReceivingOptions(await readApexAccountRows(tx, client.sfId));
      return { client, deals, receiving };
    });
    if (!read) return { ok: false };
    const custodians = await listCustodianOptions(identity);
    const assetMaps = assetMapTransferLinkEnabled() && canReviewAssetMapLinks(identity.role)
      ? await listAssignableAssetMapAccounts(identity, {
          client: { clientSfId: read.client.sfId, householdSfId: read.client.householdSfId },
        }).then((list) => [...list.recommended, ...list.others])
      : null;
    const { sfId, name, householdSfId, householdName } = read.client;
    return {
      ok: true,
      client: { sfId, name, householdSfId, householdName },
      deals: read.deals,
      receiving: read.receiving,
      custodians,
      assetMaps,
    };
  } catch {
    return { ok: false };
  }
}

export type TransferRecordOptions =
  | { ok: true; deals: DealOption[]; custodians: CustodianOption[] | null }
  | { ok: false };

/** The deals and custodian profiles the edit dialog offers for a transfer. */
export async function loadTransferRecordOptions(transferId: string): Promise<TransferRecordOptions> {
  const identity = await writer();
  if (!identity || typeof transferId !== "string" || !transferId.trim()) return { ok: false };
  try {
    const deals = await withUserScope(identity, async (tx) => {
      const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { client_sf_id: true, household_sf_id: true } });
      if (!transfer?.client_sf_id) return [];
      return readDealOptions(tx, transfer.client_sf_id, transfer.household_sf_id);
    });
    return { ok: true, deals, custodians: await listCustodianOptions(identity) };
  } catch {
    return { ok: false };
  }
}

/**
 * Links a directory client. The transfer's client and household fields are
 * rewritten from the directory; a linked deal for a different client refuses.
 */
export async function linkTransferClient(transferId: string, clientSfId: string): Promise<ConnectionResult> {
  const identity = await writer();
  if (!identity || typeof transferId !== "string" || !transferId.trim() || typeof clientSfId !== "string" || !clientSfId.trim()) return REFUSED;
  let outcome: ConnectionResult;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { archived_at: true, client_sf_id: true, deal_id: true },
      });
      if (!transfer || transfer.archived_at) return REFUSED;
      const client = await readDirectoryClient(tx, clientSfId);
      if (!client) return { ok: false, error: "Choose a client from the client directory." };
      if (transfer.deal_id) {
        const deal = await tx.deal.findUnique({ where: { id: transfer.deal_id }, select: { client_sf_id: true } });
        if (deal?.client_sf_id && clientKey(deal.client_sf_id) !== clientKey(client.sfId)) {
          return { ok: false, error: "The linked deal belongs to a different client." };
        }
      }
      if (transfer.client_sf_id === client.sfId) return { ok: true };
      await tx.transfer.update({
        where: { id: transferId },
        data: {
          client_sf_id: client.sfId,
          client_first_name: client.firstName || client.name,
          client_last_name: client.lastName,
          household_sf_id: client.householdSfId,
          household_name: client.householdName,
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { clientLink: { from: transfer.client_sf_id, to: client.sfId } },
      });
      return { ok: true };
    });
  } catch {
    return REFUSED;
  }
  if (outcome.ok) {
    scheduleCrmIdentityReconciliation("transfer_action");
    revalidateTransfer(transferId);
  }
  return outcome;
}

/**
 * Links a deal to a transfer that has none. A deal links at most one transfer,
 * and its client must be the transfer's client. A linked deal is not changed
 * here: the deal sync keys on it.
 */
export async function linkTransferDeal(transferId: string, dealId: string): Promise<ConnectionResult> {
  const identity = await writer();
  if (!identity || typeof transferId !== "string" || !transferId.trim() || typeof dealId !== "string" || !dealId.trim()) return REFUSED;
  let outcome: ConnectionResult;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { archived_at: true, client_sf_id: true, household_sf_id: true, deal_id: true },
      });
      if (!transfer || transfer.archived_at) return REFUSED;
      if (transfer.deal_id) return transfer.deal_id === dealId ? { ok: true } : { ok: false, error: "This transfer already has a linked deal." };
      if (!transfer.client_sf_id) return { ok: false, error: "Link the client before linking a deal." };
      const deal = (await readDealOptions(tx, transfer.client_sf_id, transfer.household_sf_id)).find((option) => option.id === dealId);
      if (!deal) return { ok: false, error: "Choose one of this client's open deals." };
      if (deal.clientSfId && clientKey(deal.clientSfId) !== clientKey(transfer.client_sf_id)) {
        return { ok: false, error: "That deal belongs to a different client." };
      }
      if (deal.linkedTransferId) return { ok: false, error: `That deal is already linked to transfer ${deal.linkedTransferId}.` };
      await tx.transfer.update({
        where: { id: transferId },
        data: { deal_id: deal.id, deal_sf_id: deal.sfDealId, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { dealLink: { from: null, to: deal.id } },
      });
      return { ok: true };
    });
  } catch {
    return REFUSED;
  }
  if (outcome.ok) revalidateTransfer(transferId);
  return outcome;
}

/**
 * Sets the delivering firm to a custodian profile. The firm name shown, the
 * fee-rule lookup and the manual-form catalog all follow the profile. A
 * change in Preparation reopens funding plan approval.
 */
export async function setDeliveringCustodian(transferId: string, custodianId: string): Promise<ConnectionResult> {
  const identity = await writer();
  if (!identity || !canReadCustodianLibrary(identity.role) ||
      typeof transferId !== "string" || !transferId.trim() || typeof custodianId !== "string" || !custodianId.trim()) return REFUSED;
  let outcome: ConnectionResult;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { archived_at: true, stage: true, delivering_custodian_id: true },
      });
      if (!transfer || transfer.archived_at) return REFUSED;
      if (transfer.stage !== "DECISION") return { ok: false, error: "The delivering firm can be changed while the transfer is in Preparation." };
      const custodian = await readCustodianOption(tx, custodianId);
      if (!custodian) return { ok: false, error: "Choose an active custodian profile." };
      if (transfer.delivering_custodian_id === custodian.id) return { ok: true };
      await tx.transfer.update({
        where: { id: transferId },
        data: {
          delivering_custodian_id: custodian.id,
          transferring_firm: custodian.name,
          ...fundingPlanInvalidation(),
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { deliveringCustodian: { from: transfer.delivering_custodian_id, to: custodian.id } },
      });
      return { ok: true };
    });
  } catch {
    return REFUSED;
  }
  if (outcome.ok) revalidateTransfer(transferId);
  return outcome;
}
