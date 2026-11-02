import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { assetTransferWorkspaceEnabled, paperworkRecordsEnabled } from "@/lib/flags";
import { routeLabel, titlesSectionComplete } from "@/lib/transfers/route-label";
import { accountMatchBlocks, statementBlocks } from "@/lib/transfers/intake-gates";

export type PaperworkRecords = {
  appAuthorizationRecorded: boolean;
  sentPacketRecorded: boolean;
  returnedSignatureRecorded: boolean;
  mailedPaperworkRecorded: boolean;
  drsServiceRequestRecorded: boolean;
  latestFormReview: {
    reviewed: boolean;
    receiving_form_title: string | null;
    source_form_title: string | null;
    title_owners_confirmed: string | null;
    apex_account_id: string;
    form_id: string;
  } | null;
};

export type PaperworkPageRecords = PaperworkRecords & {
  latestStatement: { accepted: boolean } | null;
  latestAccountMatch: {
    delivering_account_type: string | null;
    receiving_account_type: string | null;
  } | null;
};

const LATEST = [{ created_at: "desc" as const }, { id: "desc" as const }];

export async function readPaperworkRecords(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<PaperworkRecords> {
  const where = { transfer_id: transferId };
  const select = { id: true } as const;
  const appAuthorization = await tx.transferAppAuthorization.findFirst({ where, select });
  const sentPacket = await tx.transferSentPacket.findFirst({ where, select });
  const returnedSignature = await tx.transferReturnedSignature.findFirst({ where, select });
  const mailedPaperwork = await tx.transferMailedPaperwork.findFirst({ where, select });
  const drsServiceRequest = await tx.transferDrsServiceRequest.findFirst({ where, select });
  const latestFormReview = await tx.transferFormReview.findFirst({
    where,
    orderBy: LATEST,
    select: {
      reviewed: true,
      receiving_form_title: true,
      source_form_title: true,
      title_owners_confirmed: true,
      apex_account_id: true,
      form_id: true,
    },
  });
  return {
    appAuthorizationRecorded: appAuthorization != null,
    sentPacketRecorded: sentPacket != null,
    returnedSignatureRecorded: returnedSignature != null,
    mailedPaperworkRecorded: mailedPaperwork != null,
    drsServiceRequestRecorded: drsServiceRequest != null,
    latestFormReview: latestFormReview ?? null,
  };
}

export async function readIntakeRecords(tx: Prisma.TransactionClient, transferId: string) {
  const latestStatement = await tx.transferStatement.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { accepted: true },
  });
  const latestAccountMatch = await tx.transferAccountMatch.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { delivering_account_type: true, receiving_account_type: true },
  });
  return { latestStatement: latestStatement ?? null, latestAccountMatch: latestAccountMatch ?? null };
}

export async function getPaperworkRecords(
  identity: Identity,
  transferId: string,
): Promise<PaperworkPageRecords> {
  return withUserScope(identity, async (tx) => ({
    ...(await readPaperworkRecords(tx, transferId)),
    ...(await readIntakeRecords(tx, transferId)),
  }));
}

export function paperworkTitlesComplete(review: PaperworkRecords["latestFormReview"]): boolean {
  return titlesSectionComplete({
    receivingFormTitle: review?.receiving_form_title ?? null,
    sourceFormTitle: review?.source_form_title ?? null,
    titleOwnersConfirmed: review?.title_owners_confirmed ?? null,
    receivingAccountTitle: null,
    sourceAccountTitle: null,
  });
}

/** AC-30, AC-31: server refusal for a workspace paperwork download. */
export async function paperworkDownloadAllowed(
  identity: Identity,
  transferId: string,
  clientId: string,
  accountId: string,
  formId: string,
): Promise<boolean> {
  if (!(assetTransferWorkspaceEnabled() && paperworkRecordsEnabled())) return false;
  try {
    return await withUserScope(identity, async (tx) => {
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { client_sf_id: true, archived_at: true, funding_plan_approved_at: true, funding_type: true },
      });
      if (!transfer || transfer.archived_at || !transfer.funding_plan_approved_at || !transfer.funding_type) {
        return false;
      }
      if (!clientId || transfer.client_sf_id !== clientId) return false;
      const records = await readPaperworkRecords(tx, transferId);
      const review = records.latestFormReview;
      if (review?.reviewed !== true) return false;
      const intake = await readIntakeRecords(tx, transferId);
      const route = routeLabel(transfer.funding_type, records.appAuthorizationRecorded);
      if (statementBlocks(true, intake.latestStatement)) return false;
      if (accountMatchBlocks(
        true,
        route,
        intake.latestAccountMatch?.delivering_account_type ?? null,
        intake.latestAccountMatch?.receiving_account_type ?? null,
        paperworkTitlesComplete(review),
      )) return false;
      return Boolean(accountId) && review.apex_account_id === accountId && review.form_id === formId;
    });
  } catch {
    return false;
  }
}
