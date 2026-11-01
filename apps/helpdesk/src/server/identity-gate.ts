/**
 * The money-movement identity gate — node, layer L4.
 *
 * Owned by slice B6 (compliance). The foundation created this file with a permit-everything default
 * and wired `assertIdentityGate` into `changeTicketStatus` ahead of the RESOLVED write; this is the
 * real gate that replaces it. The SIGNATURES are the contract — `changeTicketStatus` is not edited.
 *
 * This is a plain read module rather than part of `identity-verification.actions.ts` because a
 * `"use server"` file may export only `runAction`-wrapped actions, and `assertIdentityGate` is
 * called from inside another action's transaction.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHAT THE CONTROL IS, AND WHAT IT IS NOT
 *
 * It gates **five categories** (`MONEY_MOVEMENT_CATEGORIES`) and **one transition** (into `RESOLVED`).
 * A wire ticket can be opened, worked, replied to, reassigned, moved and put on `PENDING_CLIENT`
 * without a verification on file. It cannot be called finished. That line is where the control costs
 * the desk nothing until the moment the record would otherwise close with the question unanswered.
 *
 * It is **not** an authorization control for the money movement itself — the custodian's own controls
 * are that, and this system never moves money. It is the books-and-records control: Advisers Act
 * 204-2(a)(7) requires the firm to keep the written communications it received and sent about a
 * transaction, and "who did we establish this caller was, and how" is the fact that a year later
 * nobody can reconstruct from a free-text note that says "spoke to client, all good".
 *
 * `FAILED` does not satisfy the gate. A recorded failure is evidence that the desk did the check and
 * the check did not pass, which is exactly the row a reviewer wants to find — and exactly the row that
 * must not let the ticket close as though the answer had been yes.
 *
 * `OVERRIDDEN` DOES satisfy it, for that ticket and no other. An override is a decision somebody made
 * with their name on it: it writes `IDENTITY_GATE_OVERRIDDEN` **and** an `IdentityVerification` row
 * with result `OVERRIDDEN`, so "resolved without a verification" is a fact a reviewer can filter on
 * rather than an absence they have to notice. A gate with no override is a gate the desk routes
 * around — by resolving the ticket under a different category, which destroys the evidence entirely.
 * ---------------------------------------------------------------------------------------------------
 */
import type {
  IdentityGateState,
  IdentityVerificationDTO,
  IdentityVerificationResult,
  TicketCategory,
} from "@/types/domain";
import { CATEGORY_LABELS, MONEY_MOVEMENT_CATEGORIES } from "@/types/domain";
import type { DbTx } from "@/lib/db";
import { prisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { toUserRef, USER_REF_SELECT } from "@/server/tickets";

export type IdentityGateInput = { ticketId: string; category: TicketCategory };

/** The five gated categories, as a set — one membership test, one source. */
export const GATED_CATEGORIES: ReadonlySet<TicketCategory> = new Set<TicketCategory>(MONEY_MOVEMENT_CATEGORIES);

/**
 * The two results that satisfy the gate. `FAILED` is deliberately absent: a recorded failure is
 * evidence the check happened and did not pass, not permission to close as though it had.
 */
export const SATISFYING_RESULTS: readonly IdentityVerificationResult[] = ["VERIFIED", "OVERRIDDEN"];

/** Category-driven, never per-ticket: two wire tickets are never gated differently. */
export function isIdentityGateRequired(category: TicketCategory): boolean {
  return GATED_CATEGORIES.has(category);
}

/**
 * Whether this ticket may be called finished. `true` for any category outside the five, so a caller
 * never has to ask "is it required" before asking "is it satisfied".
 *
 * Takes a `DbTx` so `assertIdentityGate` can read INSIDE the caller's transaction — the read and the
 * status write must see the same snapshot, or two tabs could each observe "no verification yet" and
 * one of them would still win the `guardedUpdate` and resolve.
 */
export async function isIdentityGateSatisfied(tx: DbTx, input: IdentityGateInput): Promise<boolean> {
  if (!isIdentityGateRequired(input.category)) return true;
  const row = await tx.identityVerification.findFirst({
    where: { ticketId: input.ticketId, result: { in: [...SATISFYING_RESULTS] } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Throws `ValidationError` when this ticket's category requires a verification and none is on file.
 *
 * The message names the control and the two ways past it, because the person reading it is mid-task
 * with a client on the phone: a refusal that says only "not allowed" produces a workaround, and the
 * workaround for this one is re-categorising the ticket.
 *
 * `fieldErrors.status` is set so the composer and the status control render it against the control the
 * person actually touched, the same shape `canTransition`'s refusal uses.
 */
export async function assertIdentityGate(tx: DbTx, input: IdentityGateInput): Promise<void> {
  if (await isIdentityGateSatisfied(tx, input)) return;
  const label = CATEGORY_LABELS[input.category];
  const message =
    `${label} tickets need an identity verification on file before they can be resolved. ` +
    `Record how you established who you were speaking to, or ask ops_team to override the gate with a reason.`;
  throw new ValidationError(message, { status: [message] });
}

const VERIFICATION_SELECT = {
  id: true,
  ticketId: true,
  method: true,
  result: true,
  note: true,
  createdAt: true,
  verifiedBy: { select: USER_REF_SELECT },
} as const;

type VerificationRow = {
  id: string;
  ticketId: string;
  method: IdentityVerificationDTO["method"];
  result: IdentityVerificationResult;
  note: string;
  createdAt: Date;
  verifiedBy: { id: string; name: string | null; email: string; image: string | null };
};

export function toIdentityVerificationDTO(row: VerificationRow): IdentityVerificationDTO {
  return {
    id: row.id,
    ticketId: row.ticketId,
    method: row.method,
    result: row.result,
    note: row.note,
    verifiedBy: toUserRef(row.verifiedBy),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every verification recorded on one ticket, newest first.
 *
 * Deliberately NOT a view under §e and therefore unaudited: a verification record carries no ticket
 * description, no comment body and no client contact detail — it carries a method, a result, a
 * reviewer and a sanitized sentence about how the check was made. The ticket page's own
 * `TICKET_VIEWED` row already records that this person opened this ticket, and auditing the panel
 * again would double-count one navigation, the same argument the attachments and links panels make.
 */
export async function listIdentityVerifications(ticketId: string): Promise<IdentityVerificationDTO[]> {
  const rows = await prisma.identityVerification.findMany({
    where: { ticketId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: VERIFICATION_SELECT,
  });
  return rows.map(toIdentityVerificationDTO);
}

/**
 * What the ticket page's panel renders: whether the gate applies, whether it is satisfied, and the
 * most recent record. `latest` is the newest row of ANY result — a `FAILED` check is the one a
 * reader most needs to see, so hiding it behind "not satisfied" would defeat the panel.
 */
export async function identityGateState(input: IdentityGateInput): Promise<IdentityGateState> {
  const required = isIdentityGateRequired(input.category);
  const rows = await prisma.identityVerification.findMany({
    where: { ticketId: input.ticketId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: VERIFICATION_SELECT,
    take: 1,
  });
  const latest = rows.length > 0 ? toIdentityVerificationDTO(rows[0]) : null;
  const satisfied =
    !required ||
    (await prisma.identityVerification
      .findFirst({
        where: { ticketId: input.ticketId, result: { in: [...SATISFYING_RESULTS] } },
        select: { id: true },
      })
      .then((r) => r !== null));
  return { required, satisfied, latest };
}
