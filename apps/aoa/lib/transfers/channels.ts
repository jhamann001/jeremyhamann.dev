import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  TRANSFER_ACH_INITIATION_RECORD,
  TRANSFER_CHECK_TICKET_RECORD,
  TRANSFER_STAGE_CHANGE,
} from "@/lib/audit";
import { assetTransferWorkspaceEnabled, paperworkRecordsEnabled } from "@/lib/flags";
import type { FundingType } from "@/lib/data/transfer-types";

// ATW-07 check tickets, ACH initiations and the linked-account submission wait
// (AC-55..AC-60, AC-81, AC-100). A check ticket or an ACH initiation is never a
// receipt or an ACAT submission. Writes run inside the caller's user-scoped
// transaction.

export function channelRecordsEnabled(): boolean {
  return assetTransferWorkspaceEnabled() && paperworkRecordsEnabled();
}

export const CHECK_LOCATION_CLIENT = "client";

export const AUTOMATIC_SUBMISSION_PENDING =
  "This movement is waiting on the automatic submission from the transfer feed. An Operations submission cannot replace it.";

export type ChannelFieldError = { field: string; message: string };

export type ChannelWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: ChannelFieldError[] };

export type ChannelTransfer = {
  id: string;
  stage: string;
  funding_type: FundingType | null;
  archived_at: Date | null;
};

export type CheckTicketInput = {
  withClient: boolean;
  mailerSent: boolean;
  checkMailed: boolean;
  optionalCall: boolean;
};

export type AchInitiationInput = { instructionsSent: boolean; clientInitiationOn: string };

const OFF: ChannelFieldError = { field: "form", message: "Check and ACH records are not available." };

function fail(field: string, message: string): { ok: false; errors: ChannelFieldError[] } {
  return { ok: false, errors: [{ field, message }] };
}

function parseIsoDay(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text ? null : day;
}

/**
 * AC-59, AC-60: a client-authorized movement (ACH, or a full ACAT on the app
 * authorization route) waits on the automatic submission from the transfer
 * feed. Until that record exists, an Operations-typed submission is refused.
 */
export function awaitingAutomaticSubmission(movement: {
  fundingType: FundingType | null;
  appAuthorizationRecorded: boolean;
  submissionRecorded: boolean;
}): boolean {
  if (movement.submissionRecorded) return false;
  return movement.fundingType === "ACH" ||
    (movement.fundingType === "ACAT_FULL" && movement.appAuthorizationRecorded);
}

export function automaticSubmissionRefused(
  enabled: boolean,
  movement: Parameters<typeof awaitingAutomaticSubmission>[0],
): boolean {
  return enabled && awaitingAutomaticSubmission(movement);
}

/** AC-55, AC-56, AC-100, AC-81: records the ticket; the cash stays unreceived. */
export async function recordCheckTicket(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: ChannelTransfer,
  input: CheckTicketInput,
  enabled: boolean,
): Promise<ChannelWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at || transfer.funding_type !== "CHECK") {
    return fail("form", "Record a check ticket on an active check transfer.");
  }
  if (transfer.stage === "FUNDED") return fail("form", "This transfer is already funded.");
  const withClient = input.withClient === true;
  const row = await tx.transferCheckTicket.create({
    data: {
      transfer_id: transfer.id,
      location: withClient ? CHECK_LOCATION_CLIENT : null,
      mailer_sent: withClient && input.mailerSent === true,
      check_mailed: withClient && input.checkMailed === true,
      optional_call: withClient && input.optionalCall === true,
    },
    select: { id: true },
  });
  await writeAudit(tx, identity, {
    action: TRANSFER_CHECK_TICKET_RECORD,
    entityType: "transfer",
    entityId: transfer.id,
    detail: { checkTicketId: row.id, withClient },
  });
  return { ok: true, id: row.id };
}

/**
 * AC-57, AC-58: instructions sent plus a client initiation date set In
 * transfer with no confirmation number. This is the bound action, so it seeds
 * no stage checklist: no paper-signature or Operations submission task.
 */
export async function recordAchInitiation(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: ChannelTransfer,
  input: AchInitiationInput,
  enabled: boolean,
): Promise<ChannelWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at || transfer.funding_type !== "ACH") {
    return fail("form", "Record an ACH initiation on an active ACH transfer.");
  }
  if (transfer.stage === "FUNDED") return fail("form", "This transfer is already funded.");
  const errors: ChannelFieldError[] = [];
  if (input.instructionsSent !== true) {
    errors.push({ field: "instructionsSent", message: "Confirm the ACH instructions were sent to the client." });
  }
  const clientInitiationOn = parseIsoDay(input.clientInitiationOn.trim());
  if (!clientInitiationOn) {
    errors.push({ field: "clientInitiationOn", message: "Enter the date the client initiated the ACH." });
  } else if (clientInitiationOn.getTime() > Date.now()) {
    errors.push({ field: "clientInitiationOn", message: "The initiation date cannot be in the future." });
  }
  if (errors.length) return { ok: false, errors };
  const row = await tx.transferAchInitiation.create({
    data: { transfer_id: transfer.id, instructions_sent: true, client_initiation_on: clientInitiationOn as Date },
    select: { id: true },
  });
  const stageMoved = transfer.stage !== "IN_TRANSFER";
  if (stageMoved) {
    await tx.transfer.update({
      where: { id: transfer.id },
      data: { stage: "IN_TRANSFER", stage_entered_at: new Date(), updated_by: identity.email },
    });
    await writeAudit(tx, identity, {
      action: TRANSFER_STAGE_CHANGE,
      entityType: "transfer",
      entityId: transfer.id,
      detail: { from: transfer.stage, to: "IN_TRANSFER" },
    });
  }
  await writeAudit(tx, identity, {
    action: TRANSFER_ACH_INITIATION_RECORD,
    entityType: "transfer",
    entityId: transfer.id,
    detail: { achInitiationId: row.id, stageMoved },
  });
  return { ok: true, id: row.id };
}

export type ChannelRecords = {
  latestCheckTicket: {
    withClient: boolean;
    mailerSent: boolean;
    checkMailed: boolean;
    optionalCall: boolean;
    recordedAt: string;
  } | null;
  latestAchInitiation: { clientInitiationOn: string; recordedAt: string } | null;
  appAuthorizationRecorded: boolean;
  submissionRecorded: boolean;
  postedReceiptSaved: boolean;
};

const LATEST = [{ created_at: "desc" as const }, { id: "desc" as const }];

export async function readChannelRecords(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<ChannelRecords> {
  const where = { transfer_id: transferId };
  const ticket = await tx.transferCheckTicket.findFirst({
    where,
    orderBy: LATEST,
    select: { location: true, mailer_sent: true, check_mailed: true, optional_call: true, created_at: true },
  });
  const ach = await tx.transferAchInitiation.findFirst({
    where,
    orderBy: LATEST,
    select: { client_initiation_on: true, created_at: true },
  });
  const appAuthorization = await tx.transferAppAuthorization.findFirst({ where, select: { id: true } });
  const submission = await tx.transferSubmission.findFirst({ where, select: { id: true } });
  const receipt = await tx.transferReceipt.findFirst({
    where,
    orderBy: { version: "desc" },
    select: { partial: true },
  });
  return {
    latestCheckTicket: ticket
      ? {
          withClient: ticket.location === CHECK_LOCATION_CLIENT,
          mailerSent: ticket.mailer_sent,
          checkMailed: ticket.check_mailed,
          optionalCall: ticket.optional_call,
          recordedAt: ticket.created_at.toISOString(),
        }
      : null,
    latestAchInitiation: ach
      ? {
          clientInitiationOn: ach.client_initiation_on.toISOString().slice(0, 10),
          recordedAt: ach.created_at.toISOString(),
        }
      : null,
    appAuthorizationRecorded: appAuthorization != null,
    submissionRecorded: submission != null,
    postedReceiptSaved: receipt != null && !receipt.partial,
  };
}

export async function getChannelRecords(identity: Identity, transferId: string): Promise<ChannelRecords> {
  return withUserScope(identity, (tx) => readChannelRecords(tx, transferId));
}
