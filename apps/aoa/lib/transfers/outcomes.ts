import type { Prisma, TransferStage } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit, TRANSFER_OUTCOME_RECORD } from "@/lib/audit";
import { assetTransferWorkspaceEnabled, paperworkRecordsEnabled } from "@/lib/flags";
import { TRANSFER_OUTCOMES, type TransferOutcomeValue } from "./outcome-values";
import { easternToday, parseIsoDay } from "./eastern-day";

// ATW-10 movement outcomes, correction history and unbound stage-change
// history (AC-71..AC-76, AC-78, AC-92..AC-94, AC-102..AC-105). Recording an
// outcome deletes nothing; the latest unresumed outcome pauses preparation and
// movement actions.

export function outcomeRecordsEnabled(): boolean {
  return assetTransferWorkspaceEnabled() && paperworkRecordsEnabled();
}

export { TRANSFER_OUTCOMES, type TransferOutcomeValue };

export const PREPARATION_PAUSED = "Preparation is paused.";
export const DECLINE_AFTER_INITIATION =
  "This movement was already submitted or received, so it cannot be declined. Record Canceled instead.";

export type OutcomeFieldError = { field: string; message: string };

export type OutcomeWriteResult =
  | { ok: true; id: string }
  | { ok: false; errors: OutcomeFieldError[] };

export type OutcomeTransfer = { id: string; archived_at: Date | null };

export type LatestOutcome = {
  id: string;
  outcome: string;
  resumed: boolean;
} | null;

const OFF: OutcomeFieldError = { field: "form", message: "Outcome records are not available." };

function fail(field: string, message: string): { ok: false; errors: OutcomeFieldError[] } {
  return { ok: false, errors: [{ field, message }] };
}

export function isTransferOutcome(value: unknown): value is TransferOutcomeValue {
  return typeof value === "string" && (TRANSFER_OUTCOMES as readonly string[]).includes(value);
}

/** AC-76, AC-105: true while the latest outcome pauses the movement. */
export function preparationPaused(enabled: boolean, latest: LatestOutcome): boolean {
  return enabled && latest != null && isTransferOutcome(latest.outcome) && !latest.resumed;
}

const LATEST = [{ created_at: "desc" as const }, { id: "desc" as const }];

export async function readLatestOutcome(tx: Prisma.TransactionClient, transferId: string): Promise<LatestOutcome> {
  const row = await tx.transferOutcome.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { id: true, outcome: true, resumed: true },
  });
  return row ?? null;
}

export async function preparationPausedFor(
  tx: Prisma.TransactionClient,
  transferId: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  return preparationPaused(enabled, await readLatestOutcome(tx, transferId));
}

async function audit(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  detail: Record<string, string | boolean>,
): Promise<void> {
  await writeAudit(tx, identity, {
    action: TRANSFER_OUTCOME_RECORD,
    entityType: "transfer",
    entityId: transferId,
    detail,
  });
}

export type OutcomeInput = { outcome: string; reason: string; followUpOn: string; outcomeOn: string };

/**
 * AC-71..AC-73, AC-75, AC-102, AC-103: records an outcome. A decline after a
 * submission or receipt is refused; Canceled stays the outcome for an
 * initiated movement. Nothing is deleted.
 */
export async function recordOutcome(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: OutcomeTransfer,
  input: OutcomeInput,
  enabled: boolean,
  today: string = easternToday(),
): Promise<OutcomeWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at) return fail("form", "This transfer is archived.");
  if (!isTransferOutcome(input.outcome)) return fail("outcome", "Choose Client declined, Deferred, Canceled or Purged.");
  const outcome = input.outcome;
  const reason = input.reason.trim();
  const followUpText = input.followUpOn.trim();
  const outcomeText = input.outcomeOn.trim();
  const errors: OutcomeFieldError[] = [];
  if (reason.length > 2000) errors.push({ field: "reason", message: "Keep the reason within 2,000 characters." });
  const outcomeOn = parseIsoDay(outcomeText);
  if (!outcomeOn) errors.push({ field: "outcomeOn", message: "Enter the outcome date." });
  else if (outcomeText > today) errors.push({ field: "outcomeOn", message: "The outcome date cannot be in the future." });
  let followUpOn: Date | null = null;
  switch (outcome) {
    case "Client declined":
      if (reason === "") errors.push({ field: "reason", message: "Enter the reason the client declined." });
      break;
    case "Deferred":
      if (reason === "") errors.push({ field: "reason", message: "Enter the reason for deferring." });
      followUpOn = parseIsoDay(followUpText);
      if (!followUpOn) errors.push({ field: "followUpOn", message: "Enter the follow-up date." });
      break;
    case "Canceled":
    case "Purged":
      break;
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
  if (errors.length) return { ok: false, errors };
  if (outcome === "Client declined") {
    const submission = await tx.transferSubmission.findFirst({ where: { transfer_id: transfer.id }, select: { id: true } });
    const receipt = await tx.transferReceipt.findFirst({ where: { transfer_id: transfer.id }, select: { id: true } });
    if (submission || receipt) return fail("outcome", DECLINE_AFTER_INITIATION);
  }
  const row = await tx.transferOutcome.create({
    data: { transfer_id: transfer.id, outcome, reason: reason || null, follow_up_on: followUpOn, outcome_on: outcomeOn },
    select: { id: true },
  });
  await audit(tx, identity, transfer.id, { recordId: row.id, kind: "outcome", outcome });
  return { ok: true, id: row.id };
}

/** AC-73: Resume transfer ends a deferral. */
export async function resumeTransfer(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: OutcomeTransfer,
  enabled: boolean,
): Promise<OutcomeWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  if (transfer.archived_at) return fail("form", "This transfer is archived.");
  const latest = await readLatestOutcome(tx, transfer.id);
  if (!latest || latest.outcome !== "Deferred" || latest.resumed) {
    return fail("form", "Only a deferred movement can be resumed.");
  }
  await tx.transferOutcome.update({ where: { id: latest.id }, data: { resumed: true } });
  await audit(tx, identity, transfer.id, { recordId: latest.id, kind: "resume" });
  return { ok: true, id: latest.id };
}

/** AC-74: clearing the assignee on a deferred movement keeps the prior assignment. */
export async function keepPriorAssignment(
  tx: Prisma.TransactionClient,
  transferId: string,
  priorAssignment: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled || priorAssignment.trim() === "") return false;
  const latest = await readLatestOutcome(tx, transferId);
  if (!latest || latest.outcome !== "Deferred" || latest.resumed) return false;
  await tx.transferOutcome.update({
    where: { id: latest.id },
    data: { prior_assignment: priorAssignment.trim().slice(0, 200) },
  });
  return true;
}

/** AC-78: a correction is appended to the movement's history. */
export async function recordCorrection(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transfer: OutcomeTransfer,
  input: { correction: string },
  enabled: boolean,
): Promise<OutcomeWriteResult> {
  if (!enabled) return { ok: false, errors: [OFF] };
  const correction = input.correction.trim();
  if (correction === "" || correction.length > 2000) {
    return fail("correction", "Enter the correction, within 2,000 characters.");
  }
  const row = await tx.transferCorrection.create({
    data: { transfer_id: transfer.id, correction },
    select: { id: true },
  });
  await audit(tx, identity, transfer.id, { recordId: row.id, kind: "correction" });
  return { ok: true, id: row.id };
}

/** AC-94: the saved unbound stage change records both stages. */
export async function recordStageChange(
  tx: Prisma.TransactionClient,
  transferId: string,
  from: TransferStage,
  to: TransferStage,
): Promise<void> {
  await tx.transferStageChange.create({
    data: { transfer_id: transferId, previous_stage: from, new_stage: to },
    select: { id: true },
  });
}

export type OutcomeRecords = {
  outcomes: {
    recordedAt: string;
    outcome: string;
    reason: string | null;
    followUpOn: string | null;
    outcomeOn: string | null;
    resumed: boolean;
    priorAssignment: string | null;
  }[];
  corrections: { recordedAt: string; correction: string }[];
  stageChanges: { recordedAt: string; previousStage: string; newStage: string }[];
  paused: boolean;
};

export async function readOutcomeRecords(tx: Prisma.TransactionClient, transferId: string): Promise<OutcomeRecords> {
  const where = { transfer_id: transferId };
  const outcomes = await tx.transferOutcome.findMany({
    where,
    orderBy: LATEST,
    select: {
      id: true, outcome: true, reason: true, follow_up_on: true, outcome_on: true, resumed: true,
      prior_assignment: true, created_at: true,
    },
  });
  const corrections = await tx.transferCorrection.findMany({
    where,
    orderBy: LATEST,
    select: { correction: true, created_at: true },
  });
  const stageChanges = await tx.transferStageChange.findMany({
    where,
    orderBy: LATEST,
    select: { previous_stage: true, new_stage: true, created_at: true },
  });
  return {
    outcomes: outcomes.map((row) => ({
      recordedAt: row.created_at.toISOString(),
      outcome: row.outcome,
      reason: row.reason,
      followUpOn: row.follow_up_on ? row.follow_up_on.toISOString().slice(0, 10) : null,
      outcomeOn: row.outcome_on ? row.outcome_on.toISOString().slice(0, 10) : null,
      resumed: row.resumed,
      priorAssignment: row.prior_assignment,
    })),
    corrections: corrections.map((row) => ({ recordedAt: row.created_at.toISOString(), correction: row.correction })),
    stageChanges: stageChanges.map((row) => ({
      recordedAt: row.created_at.toISOString(),
      previousStage: row.previous_stage,
      newStage: row.new_stage,
    })),
    paused: preparationPaused(true, outcomes[0] ?? null),
  };
}

export async function getOutcomeRecords(identity: Identity, transferId: string): Promise<OutcomeRecords> {
  return withUserScope(identity, (tx) => readOutcomeRecords(tx, transferId));
}
