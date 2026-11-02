import type { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";
import {
  writeAudit,
  TRANSFER_ACCOUNT_MATCH_RECORD,
  TRANSFER_STATEMENT_RECORD,
} from "@/lib/audit";

// ATW-02 intake gates: statement acceptance (AC-20, AC-21), the delivering and
// receiving account-type match (AC-23, AC-24), and the still-opening receiving
// account refusal (AC-19). Gates are pure; the two writes run inside the
// caller's user-scoped transaction.

export const HARD_MATCH_ROUTES = [
  "Full ACAT · app authorization · Apex API",
  "Full ACAT · signed paperwork · Apex API",
  "Partial ACAT · signed paperwork · Ascend entry",
] as const;

export const MANUAL_ROUTE = "Manual · custodian-library process";

export const NO_MATCH_ROUTES = [
  "DRS · Apex service request",
  "Rollover · physical check",
  "ACH · client self-service",
  "Wire · client instructions",
] as const;

export const STILL_OPENING_MESSAGE =
  "Choose this client’s opened receiving account in the selected household.";

export type LatestStatement = { accepted: boolean } | null;

export type AccountMatchGate = "clear" | "hard_block" | "titles_required";

export type DestinationChoice =
  | { ok: true; accountId: string }
  | { ok: false; accountId: string; message: string };

/** AC-20: no statement, or the latest statement is not accepted. */
export function statementBlocks(enabled: boolean, latest: LatestStatement): boolean {
  if (!enabled) return false;
  return latest == null || !latest.accepted;
}

function normalizedType(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Both types are saved and name the same account type. */
export function accountTypesAgree(
  delivering: string | null | undefined,
  receiving: string | null | undefined,
): boolean {
  const a = normalizedType(delivering);
  return a !== "" && a === normalizedType(receiving);
}

/**
 * AC-23 by route. The three ACAT routes hard-block a mismatch; Manual waits on
 * the titles section; every other route, including "" (no label yet), is clear.
 */
export function accountMatchGate(
  enabled: boolean,
  route: string,
  delivering: string | null | undefined,
  receiving: string | null | undefined,
  titlesComplete: boolean,
): AccountMatchGate {
  if (!enabled || accountTypesAgree(delivering, receiving)) return "clear";
  if ((HARD_MATCH_ROUTES as readonly string[]).includes(route)) return "hard_block";
  if (route === MANUAL_ROUTE) return titlesComplete ? "clear" : "titles_required";
  return "clear";
}

/** True when dependent preparation and submission are refused. */
export function accountMatchBlocks(
  enabled: boolean,
  route: string,
  delivering: string | null | undefined,
  receiving: string | null | undefined,
  titlesComplete: boolean,
): boolean {
  return accountMatchGate(enabled, route, delivering, receiving, titlesComplete) !== "clear";
}

/** AC-19: a receiving account is still being opened. */
export function receivingStillOpening(accounts: readonly { status: string }[]): boolean {
  return accounts.some((account) => account.status === "TO_OPEN");
}

/**
 * AC-19 refusal. Never writes `app.transfer_account`; opening is recorded
 * through `setAccountStatus`. Not a React hook despite the blueprint's name.
 */
export function useReceivingAccountAsDestination(
  accountId: string,
  status: "TO_OPEN" | "OPEN",
): DestinationChoice {
  switch (status) {
    case "TO_OPEN":
      return { ok: false, accountId, message: STILL_OPENING_MESSAGE };
    case "OPEN":
      return { ok: true, accountId };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

async function clearApprovalPointer(
  tx: Prisma.TransactionClient,
  transferId: string,
  identity: Identity,
): Promise<boolean> {
  const cleared = await tx.transfer.updateMany({
    where: { id: transferId, funding_plan_approved_at: { not: null } },
    data: {
      funding_plan_approved_at: null,
      funding_plan_approved_by: null,
      updated_by: identity.email ?? null,
    },
  });
  return cleared.count > 0;
}

/** The stored file a statement review points at (ticket statement upload). */
export type StatementDocumentReview = {
  documentId: string;
  statementDate: Date;
  reviewStatus: "pending" | "accepted" | "replacement_needed";
};

/**
 * Records a statement decision (AC-21, AC-22). Replacing an earlier statement
 * clears the current approval pointer (AC-25, AC-26); the approval history row
 * stays. Never changes the funding stage.
 */
export async function acceptStatement(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  accepted: boolean,
  enabled: boolean,
  document?: StatementDocumentReview,
): Promise<boolean> {
  if (!enabled) return false;
  const previous = await tx.transferStatement.findFirst({
    where: { transfer_id: transferId },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  const row = await tx.transferStatement.create({
    data: {
      transfer_id: transferId,
      accepted,
      ...(document
        ? {
            document_id: document.documentId,
            statement_date: document.statementDate,
            review_status: document.reviewStatus,
          }
        : {}),
    },
    select: { id: true },
  });
  const approvalCleared = previous ? await clearApprovalPointer(tx, transferId, identity) : false;
  await writeAudit(tx, identity, {
    action: TRANSFER_STATEMENT_RECORD,
    entityType: "transfer",
    entityId: transferId,
    detail: document
      ? { statementId: row.id, accepted, approvalCleared, documentId: document.documentId, reviewStatus: document.reviewStatus }
      : { statementId: row.id, accepted, approvalCleared },
  });
  return true;
}

/**
 * Records the delivering and receiving account types (AC-23, AC-24). An
 * unchanged pair writes nothing. A changed pair clears the current approval
 * pointer (AC-25, AC-26); the approval history row stays.
 */
export async function saveAccountMatch(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  delivering: string,
  receiving: string,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) return false;
  const deliveringType = delivering.trim();
  const receivingType = receiving.trim();
  if (deliveringType === "" || receivingType === "") return false;
  const previous = await tx.transferAccountMatch.findFirst({
    where: { transfer_id: transferId },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    select: { delivering_account_type: true, receiving_account_type: true },
  });
  if (
    previous &&
    previous.delivering_account_type === deliveringType &&
    previous.receiving_account_type === receivingType
  ) {
    return false;
  }
  const row = await tx.transferAccountMatch.create({
    data: {
      transfer_id: transferId,
      delivering_account_type: deliveringType,
      receiving_account_type: receivingType,
    },
    select: { id: true },
  });
  const approvalCleared = previous ? await clearApprovalPointer(tx, transferId, identity) : false;
  await writeAudit(tx, identity, {
    action: TRANSFER_ACCOUNT_MATCH_RECORD,
    entityType: "transfer",
    entityId: transferId,
    detail: {
      accountMatchId: row.id,
      match: accountTypesAgree(deliveringType, receivingType),
      approvalCleared,
    },
  });
  return true;
}
