import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  TRANSFER_RECEIPT_RECORD,
  TRANSFER_SUBMISSION_RECORD,
  TRANSFER_TRACKING_RECORD,
} from "@/lib/audit";
import { assetTransferWorkspaceEnabled, paperworkRecordsEnabled } from "@/lib/flags";
import type { FundingType } from "@/lib/data/transfer-types";
import {
  paperworkTitlesComplete,
  readIntakeRecords,
  readPaperworkRecords,
  type PaperworkPageRecords,
} from "@/lib/data/transfer-paperwork-store";
import { accountMatchBlocks, statementBlocks } from "@/lib/transfers/intake-gates";
import { routeLabel, signatureBlocks } from "@/lib/transfers/route-label";
import { AUTOMATIC_SUBMISSION_PENDING, automaticSubmissionRefused } from "@/lib/transfers/channels";
import {
  ARRIVAL_PAUSED,
  arrivalPausedFor,
  readLatestRejection,
  rejectionBlocksSubmission,
  REJECTION_OPEN,
} from "@/lib/transfers/follow-up";
import {
  isReceiptClassification,
  isReceiptLineStatus,
  lineResolved,
  MAX_RECEIPT_LINES,
  MAX_RECEIPT_TEXT,
  type ReceiptClassification,
  type ReceiptLineStatus,
  type SavedReceiptLine,
} from "@/lib/transfers/receipt-compare";

// ATW-06 Operations submission log, tracking updates and receipt review
// (AC-46..AC-54, AC-79, AC-80, AC-99). Writes run inside the caller's
// user-scoped transaction; the caller moves the stage through setStage after
// the record commits.

export function receiptRecordsEnabled(): boolean {
  return assetTransferWorkspaceEnabled() && paperworkRecordsEnabled();
}

export type ReceiptFieldError = { field: string; message: string };

export type ReceiptWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: ReceiptFieldError[] };

export type ConfirmArrivalResult =
  | { ok: true; id: string; version: number; funded: boolean }
  | { ok: false; errors: ReceiptFieldError[] };

export type ReceiptTransfer = {
  id: string;
  stage: string;
  funding_type: FundingType | null;
  funding_plan_approved_at: Date | null;
  archived_at: Date | null;
};

export type SubmissionInput = { controlNumber: string; submittedOn: string };
export type TrackingInput = { trackingStage: string; expectedCompletionOn: string };

export type ReceiptLineInput = {
  classification: string;
  quantity: number | null;
  lineStatus: string;
  variancePercentage: number | null;
  reviewNote: string;
  explanation: string;
};

export type ReceiptInput = {
  partial: boolean;
  lines: ReceiptLineInput[];
  nextAction: string;
  followUpOwner: string;
  nextCheckOn: string;
};

export const SUBMISSION_REQUIRES_APPROVAL = "Approve the funding plan before logging the submission.";
export const SUBMISSION_REQUIRES_SIGNATURE = "Record the returned signature before logging the submission.";
export const SUBMISSION_REQUIRES_STATEMENT = "Accept the latest statement before logging the submission.";
export const SUBMISSION_REQUIRES_MATCH = "Resolve the account-type match before logging the submission.";
export const UNRESOLVED_RECEIPT =
  "Resolve every expected and unexpected line before choosing All expected assets/cash verified as arrived.";

const OFF: ReceiptFieldError = { field: "form", message: "Receipt records are not available." };

function fail(field: string, message: string): { ok: false; errors: ReceiptFieldError[] } {
  return { ok: false, errors: [{ field, message }] };
}

export function parseIsoDay(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text ? null : day;
}

function isoDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function isAcat(fundingType: FundingType | null): boolean {
  return fundingType === "ACAT_FULL" || fundingType === "ACAT_PARTIAL";
}

export function submissionBlocked(transfer: Pick<ReceiptTransfer, "funding_plan_approved_at">): boolean {
  return transfer.funding_plan_approved_at == null;
}

/** AC-47: every refusal that applies, in the order the server checks them. */
export function submissionBlockers(
  transfer: Pick<ReceiptTransfer, "funding_plan_approved_at">,
  fundingType: FundingType,
  records: PaperworkPageRecords,
): string[] {
  const blockers: string[] = [];
  if (submissionBlocked(transfer)) blockers.push(SUBMISSION_REQUIRES_APPROVAL);
  const route = routeLabel(fundingType, records.appAuthorizationRecorded);
  if (signatureBlocks(route, records.returnedSignatureRecorded)) blockers.push(SUBMISSION_REQUIRES_SIGNATURE);
  if (statementBlocks(true, records.latestStatement)) blockers.push(SUBMISSION_REQUIRES_STATEMENT);
  if (accountMatchBlocks(
    true,
    route,
    records.latestAccountMatch?.delivering_account_type ?? null,
    records.latestAccountMatch?.receiving_account_type ?? null,
    paperworkTitlesComplete(records.latestFormReview),
  )) blockers.push(SUBMISSION_REQUIRES_MATCH);
  return blockers;
}

/** ATW-10 reads this before Funded: no receipt, or a partial latest receipt, blocks. */
export function receiptBlocksFunded(enabled: boolean, latest: { partial: boolean } | null): boolean {
  if (!enabled) return false;
  return latest == null || latest.partial;
}

/** AC-46, AC-47: Operations logs the ACAT submission; the caller then moves to In transfer. */
export async function logOperationsSubmission(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: ReceiptTransfer,
  input: SubmissionInput,
  enabled: boolean,
): Promise<ReceiptWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  const appAuthorization = await tx.transferAppAuthorization.findFirst({
    where: { transfer_id: transfer.id },
    select: { id: true },
  });
  const priorSubmission = await tx.transferSubmission.findFirst({
    where: { transfer_id: transfer.id },
    select: { id: true },
  });
  if (automaticSubmissionRefused(enabled, {
    fundingType: transfer.funding_type,
    appAuthorizationRecorded: appAuthorization != null,
    submissionRecorded: priorSubmission != null,
  })) return fail("form", AUTOMATIC_SUBMISSION_PENDING);
  if (rejectionBlocksSubmission(enabled, await readLatestRejection(tx, transfer.id))) {
    return fail("form", REJECTION_OPEN);
  }
  if (transfer.archived_at || !transfer.funding_type || !isAcat(transfer.funding_type)) {
    return fail("form", "Log a submission on an active ACAT transfer.");
  }
  if (transfer.stage !== "DECISION" && transfer.stage !== "IN_TRANSFER") {
    return fail("form", "This transfer is past the submission step.");
  }
  const errors: ReceiptFieldError[] = [];
  const controlNumber = input.controlNumber.trim();
  if (controlNumber === "" || controlNumber.length > 64) {
    errors.push({ field: "controlNumber", message: "Enter the ACAT control number, within 64 characters." });
  }
  const submittedOn = parseIsoDay(input.submittedOn.trim());
  if (!submittedOn) errors.push({ field: "submittedOn", message: "Enter the submission date." });
  else if (submittedOn.getTime() > Date.now()) {
    errors.push({ field: "submittedOn", message: "The submission date cannot be in the future." });
  }
  if (errors.length) return { ok: false, errors };
  const records = await readPaperworkRecords(tx, transfer.id);
  const intake = await readIntakeRecords(tx, transfer.id);
  const blockers = submissionBlockers(transfer, transfer.funding_type, { ...records, ...intake });
  if (blockers.length) return fail("form", blockers[0]);
  const row = await tx.transferSubmission.create({
    data: { transfer_id: transfer.id, control_number: controlNumber, submitted_on: submittedOn as Date },
    select: { id: true },
  });
  await writeAudit(tx, identity, {
    action: TRANSFER_SUBMISSION_RECORD,
    entityType: "transfer",
    entityId: transfer.id,
    detail: { submissionId: row.id },
  });
  return { ok: true, id: row.id };
}

/** AC-48: a tracking update never changes the funding stage. */
export async function saveTrackingUpdate(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: ReceiptTransfer,
  input: TrackingInput,
  enabled: boolean,
): Promise<ReceiptWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at || transfer.stage !== "IN_TRANSFER") {
    return fail("form", "Record tracking updates while the transfer is in transfer.");
  }
  const errors: ReceiptFieldError[] = [];
  const trackingStage = input.trackingStage.trim();
  if (trackingStage === "" || trackingStage.length > 80) {
    errors.push({ field: "trackingStage", message: "Enter the tracking stage, within 80 characters." });
  }
  const completionText = input.expectedCompletionOn.trim();
  const expectedCompletionOn = completionText === "" ? null : parseIsoDay(completionText);
  if (completionText !== "" && !expectedCompletionOn) {
    errors.push({ field: "expectedCompletionOn", message: "Enter a valid expected completion date." });
  }
  if (errors.length) return { ok: false, errors };
  const submission = await tx.transferSubmission.findFirst({
    where: { transfer_id: transfer.id },
    select: { id: true },
  });
  if (!submission) return fail("form", "Log the submission before recording tracking updates.");
  const row = await tx.transferTrackingUpdate.create({
    data: { transfer_id: transfer.id, tracking_stage: trackingStage, expected_completion_on: expectedCompletionOn },
    select: { id: true },
  });
  await writeAudit(tx, identity, {
    action: TRANSFER_TRACKING_RECORD,
    entityType: "transfer",
    entityId: transfer.id,
    detail: { trackingUpdateId: row.id, hasExpectedCompletion: expectedCompletionOn != null },
  });
  return { ok: true, id: row.id };
}

type ValidLine = {
  classification: ReceiptClassification;
  quantity: number | null;
  lineStatus: ReceiptLineStatus;
  variancePercentage: number | null;
  reviewNote: string;
  explanation: string;
};

function validLine(line: ReceiptLineInput): ValidLine | null {
  if (!isReceiptClassification(line.classification) || !isReceiptLineStatus(line.lineStatus)) return null;
  const quantity = line.quantity;
  if (quantity != null && (!Number.isFinite(quantity) || quantity < 0 || quantity >= 1e18)) return null;
  const variance = line.variancePercentage;
  if (variance != null && (!Number.isFinite(variance) || Math.abs(variance) >= 1e8)) return null;
  if (typeof line.reviewNote !== "string" || typeof line.explanation !== "string") return null;
  const reviewNote = line.reviewNote.trim();
  const explanation = line.explanation.trim();
  if (reviewNote.length > MAX_RECEIPT_TEXT || explanation.length > MAX_RECEIPT_TEXT) return null;
  return {
    classification: line.classification,
    quantity,
    lineStatus: line.lineStatus,
    variancePercentage: variance,
    reviewNote,
    explanation,
  };
}

/**
 * AC-50..AC-53, AC-80: saves a new receipt version. A partial save keeps the
 * transfer In transfer and needs a next action, owner and check date. A
 * verified save needs every line resolved; the caller then moves to Funded.
 * Earlier versions are never updated.
 */
export async function confirmArrival(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: ReceiptTransfer,
  input: ReceiptInput,
  enabled: boolean,
): Promise<ConfirmArrivalResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (await arrivalPausedFor(tx, transfer.id, enabled)) return fail("form", ARRIVAL_PAUSED);
  if (transfer.archived_at || transfer.stage !== "IN_TRANSFER") {
    return fail("form", "Record the receipt while the transfer is in transfer.");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_RECEIPT_LINES) {
    return fail("lines", "Apply a receipt comparison before saving the review.");
  }
  const lines: ValidLine[] = [];
  for (const line of input.lines) {
    const valid = validLine(line);
    if (!valid) return fail("lines", "Each receipt line needs a classification, a status and notes within 2,000 characters.");
    lines.push(valid);
  }
  const errors: ReceiptFieldError[] = [];
  const nextAction = input.nextAction.trim();
  const followUpOwner = input.followUpOwner.trim();
  const nextCheckOn = input.partial ? parseIsoDay(input.nextCheckOn.trim()) : null;
  if (input.partial) {
    if (nextAction === "" || nextAction.length > 200) {
      errors.push({ field: "nextAction", message: "Enter the next action, within 200 characters." });
    }
    if (followUpOwner === "" || followUpOwner.length > 120) {
      errors.push({ field: "followUpOwner", message: "Enter the follow-up owner, within 120 characters." });
    }
    if (!nextCheckOn) errors.push({ field: "nextCheckOn", message: "Enter the next check date." });
  } else if (lines.some((line) => !lineResolved(line))) {
    errors.push({ field: "lines", message: UNRESOLVED_RECEIPT });
  }
  if (errors.length) return { ok: false, errors };
  const submission = await tx.transferSubmission.findFirst({
    where: { transfer_id: transfer.id },
    select: { id: true },
  });
  if (!submission) return fail("form", "Log the submission before recording the receipt.");
  const latest = await tx.transferReceipt.findFirst({
    where: { transfer_id: transfer.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;
  const row = await tx.transferReceipt.create({
    data: {
      transfer_id: transfer.id,
      version,
      partial: input.partial,
      next_action: input.partial ? nextAction : null,
      follow_up_owner: input.partial ? followUpOwner : null,
      next_check_on: nextCheckOn,
      lines: {
        create: lines.map((line, index) => ({
          line_number: index + 1,
          classification: line.classification,
          quantity: line.quantity,
          line_status: line.lineStatus,
          variance_percentage: line.variancePercentage,
          review_note: line.reviewNote || null,
          explanation: line.explanation || null,
        })),
      },
    },
    select: { id: true },
  });
  await writeAudit(tx, identity, {
    action: TRANSFER_RECEIPT_RECORD,
    entityType: "transfer",
    entityId: transfer.id,
    detail: { receiptId: row.id, version, partial: input.partial, lineCount: lines.length },
  });
  return { ok: true, id: row.id, version, funded: !input.partial };
}

export type ReceiptVersion = {
  version: number;
  partial: boolean;
  nextAction: string | null;
  followUpOwner: string | null;
  nextCheckOn: string | null;
  recordedAt: string;
  lines: SavedReceiptLine[];
};

export type ReceiptRecords = {
  latestSubmission: { controlNumber: string; submittedOn: string; recordedAt: string } | null;
  latestTracking: { trackingStage: string; expectedCompletionOn: string | null; recordedAt: string } | null;
  receipts: ReceiptVersion[];
};

const LATEST = [{ created_at: "desc" as const }, { id: "desc" as const }];

export async function readReceiptRecords(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<ReceiptRecords> {
  const submission = await tx.transferSubmission.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { control_number: true, submitted_on: true, created_at: true },
  });
  const tracking = await tx.transferTrackingUpdate.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { tracking_stage: true, expected_completion_on: true, created_at: true },
  });
  const receipts = await tx.transferReceipt.findMany({
    where: { transfer_id: transferId },
    orderBy: { version: "desc" },
    select: {
      version: true,
      partial: true,
      next_action: true,
      follow_up_owner: true,
      next_check_on: true,
      created_at: true,
      lines: {
        orderBy: { line_number: "asc" },
        select: {
          line_number: true,
          classification: true,
          quantity: true,
          line_status: true,
          variance_percentage: true,
          review_note: true,
          explanation: true,
        },
      },
    },
  });
  return {
    latestSubmission: submission
      ? {
          controlNumber: submission.control_number,
          submittedOn: isoDay(submission.submitted_on) as string,
          recordedAt: submission.created_at.toISOString(),
        }
      : null,
    latestTracking: tracking
      ? {
          trackingStage: tracking.tracking_stage,
          expectedCompletionOn: isoDay(tracking.expected_completion_on),
          recordedAt: tracking.created_at.toISOString(),
        }
      : null,
    receipts: receipts.map((receipt) => ({
      version: receipt.version,
      partial: receipt.partial,
      nextAction: receipt.next_action,
      followUpOwner: receipt.follow_up_owner,
      nextCheckOn: isoDay(receipt.next_check_on),
      recordedAt: receipt.created_at.toISOString(),
      lines: receipt.lines.map((line) => ({
        lineNumber: line.line_number,
        classification: isReceiptClassification(line.classification) ? line.classification : "unexpected",
        quantity: line.quantity == null ? null : Number(line.quantity),
        lineStatus: isReceiptLineStatus(line.line_status) ? line.line_status : "outstanding",
        variancePercentage: line.variance_percentage == null ? null : Number(line.variance_percentage),
        reviewNote: line.review_note,
        explanation: line.explanation,
      })),
    })),
  };
}

export async function getReceiptRecords(identity: Identity, transferId: string): Promise<ReceiptRecords> {
  return withUserScope(identity, (tx) => readReceiptRecords(tx, transferId));
}
