/**
 * Auto-assignment — node, layer L4.
 *
 * Owned by slice **B4**. This file replaces the foundation's null-returning stub; the one call site
 * (`createTicketCore` in `src/server/ingest.ts`) is unchanged and stays unchanged. It calls this
 * INSIDE its transaction, applies the returned id itself, and writes the `TICKET_ASSIGNED` row with
 * `metadata.reason = "auto"` under the ingesting actor — so "who assigned this" answers "the desk
 * did, by rule" rather than naming an innocent person.
 *
 * TURNING IT ON IS TWO DELIBERATE ACTS. This module is live from this commit, and every queue's
 * `autoAssign` is still false (schema default, never set by a migration). Nothing changes until an
 * administrator flips a queue at `/admin/sla`. That is the whole safety story: a desk that has never
 * thought about a rota keeps landing tickets unassigned, which is a visible state somebody triages,
 * rather than silently handing client work to whoever happened to sign in first.
 *
 * WHO IS A CANDIDATE, and why each exclusion is there:
 *
 *  - **Holds WRITE on the queue** — read-only access is not the ability to work a ticket, and an
 *    advisor who can see an Operations ticket must never find one in their name. Derived from
 *    `QUEUE_ACCESS` rather than restated, so a policy change moves the rota with it.
 *  - **`isActive`** — a deactivated account cannot sign in; assigning to one is a
 *    ticket nobody is working that looks worked.
 *  - **Not out of office** — `outOfOfficeUntil` in the future. Assigning to someone who is away is
 *    the exact failure the out-of-office job exists to undo, and doing both would be a rota that
 *    hands work out on Monday and takes it back on Tuesday.
 *  - **Not a machine identity** — `svc_jobs` / `svc_integration` hold no groups today, but they are
 *    excluded by email as well, because a future group grant must not put the jobs runner on a rota.
 *  - **Not the requester's own account** — a staff member emailing the desk gets a ticket ABOUT
 *    themselves; assigning it to them is self-service dressed up as triage.
 *
 * ORDER, in full, and it is deterministic at every step (a rota that depends on row order is a rota
 * nobody can reason about or test):
 *   1. fewest OPEN tickets assigned — the load the person is actually carrying;
 *   2. then least recently assigned — the round-robin, read from the `TICKET_ASSIGNED` ledger rather
 *      than from a counter column, so it survives a restart and cannot drift from what happened;
 *   3. then the oldest `User.updatedAt` — the tie-break the foundation stub specified;
 *   4. then user id — so two rows that are equal on all three still order the same way twice.
 */
import type { OktaGroup, QueueKey } from "@/types/domain";
import { OPEN_STATUSES, QUEUE_KEYS } from "@/types/domain";
import type { DbTx } from "@/lib/db";
import { prisma } from "@/lib/db";
import { QUEUE_ACCESS } from "@/lib/rbac";
import { MACHINE_ACTOR_EMAILS } from "@/server/users";

export type AutoAssignContext = { queueKey: QueueKey; queueId: string; ticketId: string };

/**
 * How far back the rota reads the assignment ledger. Bounded so the query rides the
 * `@@index([action, occurredAt])` instead of scanning every `TICKET_ASSIGNED` row ever written; a
 * person who has not been handed a ticket in three months sorts as "never", which is exactly how the
 * round-robin should treat them.
 */
export const AUTO_ASSIGN_ROTA_LOOKBACK_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60_000;

export type AutoAssignCandidate = {
  id: string;
  email: string;
  /** OPEN_STATUSES tickets currently assigned to them. */
  openAssignments: number;
  /** The last time the desk handed them a ticket, within the lookback. Null for "not recently". */
  lastAssignedAt: Date | null;
  updatedAt: Date;
};

/** The groups that hold WRITE on this queue, straight out of the RBAC table. */
export function writingGroupsFor(queueKey: QueueKey): OktaGroup[] {
  return (Object.keys(QUEUE_ACCESS) as OktaGroup[]).filter((g) => QUEUE_ACCESS[g][queueKey] === "WRITE");
}

/**
 * The full ordering, as a pure function so it can be tested without a database. Returns a new array;
 * the input is not mutated.
 */
export function rankCandidates(candidates: readonly AutoAssignCandidate[]): AutoAssignCandidate[] {
  const rotaKey = (c: AutoAssignCandidate): number =>
    c.lastAssignedAt === null ? Number.NEGATIVE_INFINITY : c.lastAssignedAt.getTime();
  return [...candidates].sort((a, b) => {
    if (a.openAssignments !== b.openAssignments) return a.openAssignments - b.openAssignments;
    if (rotaKey(a) !== rotaKey(b)) return rotaKey(a) - rotaKey(b);
    if (a.updatedAt.getTime() !== b.updatedAt.getTime()) return a.updatedAt.getTime() - b.updatedAt.getTime();
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The winner of {@link rankCandidates}, or null for an empty rota. */
export function pickFrom(candidates: readonly AutoAssignCandidate[]): string | null {
  const ranked = rankCandidates(candidates);
  return ranked.length === 0 ? null : ranked[0].id;
}

/** Active, in-office, non-machine staff holding WRITE on `queueKey`, excluding `excludeEmail`. */
export async function eligibleAssignees(
  tx: DbTx,
  queueKey: QueueKey,
  now: Date,
  excludeEmail?: string | null,
): Promise<AutoAssignCandidate[]> {
  const writers = writingGroupsFor(queueKey);
  if (writers.length === 0) return [];

  const excluded = [...MACHINE_ACTOR_EMAILS];
  const requester = excludeEmail?.trim().toLowerCase();
  if (requester !== undefined && requester.length > 0) excluded.push(requester);

  const users = await tx.user.findMany({
    where: {
      isActive: true,
      groups: { hasSome: writers },
      email: { notIn: excluded, mode: "insensitive" },
      OR: [{ outOfOfficeUntil: null }, { outOfOfficeUntil: { lte: now } }],
    },
    select: { id: true, email: true, updatedAt: true },
  });
  if (users.length === 0) return [];

  const ids = users.map((u) => u.id);
  const [load, rota] = await Promise.all([
    tx.ticket.groupBy({
      by: ["assigneeId"],
      where: { assigneeId: { in: ids }, status: { in: [...OPEN_STATUSES] } },
      _count: { _all: true },
    }),
    tx.auditLog.groupBy({
      by: ["newValue"],
      where: {
        action: "TICKET_ASSIGNED",
        occurredAt: { gte: new Date(now.getTime() - AUTO_ASSIGN_ROTA_LOOKBACK_DAYS * MS_PER_DAY) },
        newValue: { in: ids },
      },
      _max: { occurredAt: true },
    }),
  ]);

  const openByUser = new Map(load.map((r) => [r.assigneeId, r._count._all] as const));
  const lastByUser = new Map(rota.map((r) => [r.newValue, r._max.occurredAt] as const));

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    openAssignments: openByUser.get(u.id) ?? 0,
    lastAssignedAt: lastByUser.get(u.id) ?? null,
    updatedAt: u.updatedAt,
  }));
}

/**
 * How many people each queue's rota would draw from right now. Read-only, for `/admin/sla`: a switch
 * with a rota of zero will never assign anything, and that should be visible before it is flipped.
 */
export async function eligibleAssigneeCounts(now: Date): Promise<Partial<Record<QueueKey, number>>> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      email: { notIn: [...MACHINE_ACTOR_EMAILS], mode: "insensitive" },
      OR: [{ outOfOfficeUntil: null }, { outOfOfficeUntil: { lte: now } }],
    },
    select: { groups: true },
  });

  const counts: Partial<Record<QueueKey, number>> = {};
  for (const q of QUEUE_KEYS) {
    const writers = writingGroupsFor(q);
    counts[q] = users.filter((u) => u.groups.some((g) => writers.includes(g))).length;
  }
  return counts;
}

/**
 * The user id to assign, or null for "leave it unassigned".
 *
 * Null is returned — deliberately, and with no audit row of its own — when the queue has auto-assign
 * off, when the ticket already has an assignee, or when the rota is empty. None of those is an error
 * or an exception: they are the three ordinary ways a desk ends up with an unassigned ticket, and an
 * unassigned ticket is a visible state somebody triages. Throwing here would fail an INGEST over a
 * convenience.
 *
 * "Never overriding an explicit assignee" is enforced by re-reading the row inside the caller's
 * transaction rather than by trusting that the caller only calls this for new tickets: this function
 * is the thing other code will reach for later (a release from held mail, an import), and the rule
 * has to hold there too.
 */
export async function pickAutoAssignee(tx: DbTx, ctx: AutoAssignContext): Promise<string | null> {
  const queue = await tx.queue.findUnique({ where: { id: ctx.queueId }, select: { autoAssign: true } });
  if (queue === null || !queue.autoAssign) return null;

  const ticket = await tx.ticket.findUnique({
    where: { id: ctx.ticketId },
    select: { assigneeId: true, requesterEmail: true, status: true },
  });
  if (ticket === null) return null;
  if (ticket.assigneeId !== null) return null;
  if (!(OPEN_STATUSES as readonly string[]).includes(ticket.status)) return null;

  const candidates = await eligibleAssignees(tx, ctx.queueKey, new Date(), ticket.requesterEmail);
  return pickFrom(candidates);
}
