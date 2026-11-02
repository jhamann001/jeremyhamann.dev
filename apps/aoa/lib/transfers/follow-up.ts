import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit, TRANSFER_FOLLOW_UP_RECORD } from "@/lib/audit";
import { assetTransferWorkspaceEnabled, paperworkRecordsEnabled } from "@/lib/flags";
import type { FundingType } from "@/lib/data/transfer-types";
import { easternToday, parseIsoDay } from "./eastern-day";

// ATW-09 fee reimbursement, the linked investment request, residuals and ACAT
// rejections (AC-61..AC-69, AC-82..AC-84, AC-101). None of these writes a
// receipt, a submission, a task status, or the transfer's value or stage.

export function followUpRecordsEnabled(): boolean {
  return assetTransferWorkspaceEnabled() && paperworkRecordsEnabled();
}

export const ARRIVAL_PAUSED =
  "Arrival confirmation is paused by the ACAT rejection. Accept the resolution and log the new submission first.";
export const REJECTION_OPEN = "Accept the ACAT rejection resolution before logging a new submission.";
export const REJECTED_TRACKING_STAGE = "ACAT rejected";

export type FollowUpFieldError = { field: string; message: string };

export type FollowUpWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: FollowUpFieldError[] };

export type FollowUpTransfer = {
  id: string;
  funding_type: FundingType | null;
  archived_at: Date | null;
};

export type LatestRejection = {
  id: string;
  arrival_paused: boolean;
  awaiting_operations_review: boolean;
  response: string | null;
  created_at: Date;
} | null;

const OFF: FollowUpFieldError = { field: "form", message: "Follow-up records are not available." };

function fail(field: string, message: string): { ok: false; errors: FollowUpFieldError[] } {
  return { ok: false, errors: [{ field, message }] };
}

function isAcat(fundingType: FundingType | null): boolean {
  return fundingType === "ACAT_FULL" || fundingType === "ACAT_PARTIAL";
}

/** Accepted: Operations reviewed a saved response (AC-69). */
export function rejectionAccepted(latest: LatestRejection): boolean {
  return latest != null && latest.response != null && !latest.awaiting_operations_review;
}

/** AC-69: an unaccepted rejection keeps the submission path closed. */
export function rejectionBlocksSubmission(enabled: boolean, latest: LatestRejection): boolean {
  return enabled && latest != null && !rejectionAccepted(latest);
}

/** AC-84: ATW-10 reads this before Funded. */
export function rejectionBlocksFunded(
  enabled: boolean,
  latest: LatestRejection,
  fundingPlanApprovedAt: Date | null,
): boolean {
  return enabled && rejectionAccepted(latest) && fundingPlanApprovedAt == null;
}

/** AC-83: the latest rejection pauses arrival until a newer submission is logged. */
export function arrivalPaused(
  enabled: boolean,
  latest: LatestRejection,
  latestSubmissionAt: Date | null,
): boolean {
  if (!enabled || latest == null || !latest.arrival_paused) return false;
  return latestSubmissionAt == null || latestSubmissionAt.getTime() <= latest.created_at.getTime();
}

const LATEST = [{ created_at: "desc" as const }, { id: "desc" as const }];

export async function readLatestRejection(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<LatestRejection> {
  const row = await tx.transferAcatRejection.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { id: true, arrival_paused: true, awaiting_operations_review: true, response: true, created_at: true },
  });
  return row ?? null;
}

export async function arrivalPausedFor(
  tx: Prisma.TransactionClient,
  transferId: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  const latest = await readLatestRejection(tx, transferId);
  if (!latest) return false;
  const submission = await tx.transferSubmission.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { created_at: true },
  });
  return arrivalPaused(enabled, latest, submission?.created_at ?? null);
}

async function audit(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  detail: Record<string, string | boolean>,
): Promise<void> {
  await writeAudit(tx, identity, {
    action: TRANSFER_FOLLOW_UP_RECORD,
    entityType: "transfer",
    entityId: transferId,
    detail,
  });
}

/** AC-62: only an evidenced fee is recorded as reimbursed. */
export async function recordFeeReimbursement(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: FollowUpTransfer,
  input: { evidenced: boolean; operationsFeeRequestId?: string | null },
  enabled: boolean,
): Promise<FollowUpWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at) return fail("form", "This transfer is archived.");
  if (input.evidenced !== true) return fail("evidenced", "Confirm the fee evidence before recording the reimbursement.");
  const feeRequestId = input.operationsFeeRequestId ?? null;
  const row = await tx.transferFeeReimbursement.create({
    data: { transfer_id: transfer.id, evidenced: true, operations_fee_request_id: feeRequestId },
    select: { id: true },
  });
  await audit(tx, identity, transfer.id, {
    recordId: row.id, kind: "fee_reimbursement", ...(feeRequestId ? { feeRequestId } : {}),
  });
  return { ok: true, id: row.id };
}

/** AC-63, AC-64: the link is read-only here; the request is edited in Trade Requests. */
export async function linkInvestmentRequest(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: FollowUpTransfer,
  input: { requestId: string },
  enabled: boolean,
): Promise<FollowUpWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at) return fail("form", "This transfer is archived.");
  const requestId = input.requestId.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    return fail("requestId", "Enter the investment request id, within 64 letters, digits, dashes or underscores.");
  }
  const row = await tx.transferInvestmentLink.create({
    data: { transfer_id: transfer.id, linked_investment_request: requestId },
    select: { id: true },
  });
  await audit(tx, identity, transfer.id, { recordId: row.id, kind: "investment_link" });
  return { ok: true, id: row.id };
}

/**
 * AC-65, AC-66, AC-101: a residual is tied to a recorded original control
 * number and never changes the transfer's value or stage. A tracker stage is
 * not a receipt review.
 */
export async function recordResidual(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: FollowUpTransfer,
  input: { originalControlNumber: string; trackerStage: string },
  enabled: boolean,
): Promise<FollowUpWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at || !isAcat(transfer.funding_type)) {
    return fail("form", "Record a residual on an active ACAT transfer.");
  }
  const originalControlNumber = input.originalControlNumber.trim();
  const trackerStage = input.trackerStage.trim();
  if (trackerStage.length > 80) return fail("trackerStage", "Keep the tracker stage within 80 characters.");
  const submission = originalControlNumber
    ? await tx.transferSubmission.findFirst({
        where: { transfer_id: transfer.id, control_number: originalControlNumber },
        select: { id: true },
      })
    : null;
  if (!submission) {
    return fail("originalControlNumber", "Choose a control number recorded on this transfer's submission log.");
  }
  const row = await tx.transferResidual.create({
    data: { transfer_id: transfer.id, original_control_number: originalControlNumber, tracker_stage: trackerStage || null },
    select: { id: true },
  });
  await audit(tx, identity, transfer.id, { recordId: row.id, kind: "residual", hasTrackerStage: trackerStage !== "" });
  return { ok: true, id: row.id };
}

export type RejectionInput = { followUpOwner: string; reason?: string; code?: string; rejectedOn?: string };


/**
 * AC-67, AC-82, AC-83: keeps the attempt in history, clears its completion
 * estimate and pauses arrival confirmation. Logs no new submission.
 */
export async function recordAcatRejection(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: FollowUpTransfer,
  input: RejectionInput,
  enabled: boolean,
  today: string = easternToday(),
): Promise<FollowUpWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at || !isAcat(transfer.funding_type)) {
    return fail("form", "Record a rejection on an active ACAT transfer.");
  }
  const followUpOwner = input.followUpOwner.trim();
  if (followUpOwner === "" || followUpOwner.length > 120) {
    return fail("followUpOwner", "Enter the follow-up owner, within 120 characters.");
  }
  const reason = (input.reason ?? "").trim();
  if (reason === "" || reason.length > 1000) {
    return fail("reason", "Enter the rejection reason supplied by Apex or the delivering firm, within 1,000 characters.");
  }
  const code = (input.code ?? "").trim();
  if (code.length > 120) return fail("code", "Keep the rejection code within 120 characters.");
  const rejectedText = (input.rejectedOn ?? "").trim();
  const rejectedOn = parseIsoDay(rejectedText);
  if (!rejectedOn) return fail("rejectedOn", "Enter the rejection date.");
  if (rejectedText > today) return fail("rejectedOn", "The rejection date cannot be in the future.");
  const submission = await tx.transferSubmission.findFirst({
    where: { transfer_id: transfer.id },
    select: { id: true },
  });
  if (!submission) return fail("form", "Only a submitted ACAT can be rejected.");
  const latest = await readLatestRejection(tx, transfer.id);
  if (latest && !rejectionAccepted(latest)) {
    return fail("form", "Resolve the open rejection before recording another.");
  }
  const row = await tx.transferAcatRejection.create({
    data: {
      transfer_id: transfer.id,
      completion_estimate: null,
      arrival_paused: true,
      follow_up_owner: followUpOwner,
      reason,
      code: code || null,
      rejected_on: rejectedOn,
    },
    select: { id: true },
  });
  await tx.transferTrackingUpdate.create({
    data: { transfer_id: transfer.id, tracking_stage: REJECTED_TRACKING_STAGE, expected_completion_on: null },
    select: { id: true },
  });
  await audit(tx, identity, transfer.id, { recordId: row.id, kind: "acat_rejection" });
  return { ok: true, id: row.id };
}

/** AC-68: the follow-up owner's response marks the rejection awaiting Operations review. */
export async function saveRejectionResponse(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: FollowUpTransfer,
  input: { response: string },
  enabled: boolean,
): Promise<FollowUpWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at) return fail("form", "This transfer is archived.");
  const response = input.response.trim();
  if (response === "" || response.length > 2000) {
    return fail("response", "Enter the response, within 2,000 characters.");
  }
  const latest = await readLatestRejection(tx, transfer.id);
  if (!latest || rejectionAccepted(latest)) return fail("form", "There is no open rejection to respond to.");
  await tx.transferAcatRejection.update({
    where: { id: latest.id },
    data: { response, awaiting_operations_review: true },
  });
  await audit(tx, identity, transfer.id, { recordId: latest.id, kind: "rejection_response" });
  return { ok: true, id: latest.id };
}

/** AC-69: accepting the resolution reopens the submission path. It logs no submission. */
export async function acceptRejectionResolution(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: FollowUpTransfer,
  enabled: boolean,
): Promise<FollowUpWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at) return fail("form", "This transfer is archived.");
  const latest = await readLatestRejection(tx, transfer.id);
  if (!latest || !latest.awaiting_operations_review) {
    return fail("form", "There is no rejection response awaiting Operations review.");
  }
  await tx.transferAcatRejection.update({
    where: { id: latest.id },
    data: { awaiting_operations_review: false },
  });
  await audit(tx, identity, transfer.id, { recordId: latest.id, kind: "rejection_accepted" });
  return { ok: true, id: latest.id };
}

export type FollowUpRecords = {
  rejections: {
    recordedAt: string;
    followUpOwner: string;
    response: string | null;
    reason: string | null;
    code: string | null;
    rejectedOn: string | null;
    state: "open" | "awaiting_review" | "accepted";
  }[];
  residuals: { recordedAt: string; originalControlNumber: string; trackerStage: string | null }[];
  feeReimbursements: { recordedAt: string; feeRequestId: string | null }[];
  investmentRequestId: string | null;
  controlNumbers: string[];
  arrivalPaused: boolean;
  resubmissionOpen: boolean;
};

export async function readFollowUpRecords(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<FollowUpRecords> {
  const where = { transfer_id: transferId };
  const rejections = await tx.transferAcatRejection.findMany({
    where,
    orderBy: LATEST,
    select: {
      id: true, arrival_paused: true, follow_up_owner: true, response: true,
      awaiting_operations_review: true, created_at: true, reason: true, code: true, rejected_on: true,
    },
  });
  const residuals = await tx.transferResidual.findMany({
    where,
    orderBy: LATEST,
    select: { original_control_number: true, tracker_stage: true, created_at: true },
  });
  const fees = await tx.transferFeeReimbursement.findMany({ where, orderBy: LATEST, select: { created_at: true, operations_fee_request_id: true } });
  const link = await tx.transferInvestmentLink.findFirst({
    where,
    orderBy: LATEST,
    select: { linked_investment_request: true },
  });
  const submissions = await tx.transferSubmission.findMany({
    where,
    orderBy: LATEST,
    select: { control_number: true, created_at: true },
  });
  const latest = rejections[0] ?? null;
  const latestSubmissionAt = submissions[0]?.created_at ?? null;
  return {
    rejections: rejections.map((row) => ({
      recordedAt: row.created_at.toISOString(),
      followUpOwner: row.follow_up_owner,
      response: row.response,
      reason: row.reason,
      code: row.code,
      rejectedOn: row.rejected_on ? row.rejected_on.toISOString().slice(0, 10) : null,
      state: row.awaiting_operations_review ? "awaiting_review" : row.response != null ? "accepted" : "open",
    })),
    residuals: residuals.map((row) => ({
      recordedAt: row.created_at.toISOString(),
      originalControlNumber: row.original_control_number,
      trackerStage: row.tracker_stage,
    })),
    feeReimbursements: fees.map((row) => ({ recordedAt: row.created_at.toISOString(), feeRequestId: row.operations_fee_request_id })),
    investmentRequestId: link?.linked_investment_request ?? null,
    controlNumbers: [...new Set(submissions.map((row) => row.control_number))],
    arrivalPaused: arrivalPaused(true, latest, latestSubmissionAt),
    resubmissionOpen: rejectionAccepted(latest) && arrivalPaused(true, latest, latestSubmissionAt),
  };
}

export async function getFollowUpRecords(identity: Identity, transferId: string): Promise<FollowUpRecords> {
  return withUserScope(identity, (tx) => readFollowUpRecords(tx, transferId));
}
