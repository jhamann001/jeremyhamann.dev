/**
 * Out-of-office reassignment — node only.
 *
 * WHAT IT IS FOR. `User.outOfOfficeUntil` is set while somebody is away. Their OPEN tickets are still
 * in their name, still counting down against an SLA clock that does not pause (24x7 by design),
 * and nobody is looking at them. This job hands each one to that person's declared `backupUser`, or
 * returns it to the queue unassigned when there is none — and the unassigned case is not a failure:
 * an unowned ticket in a queue is a visible state somebody triages, whereas a ticket in an absent
 * person's name looks worked.
 *
 * WHO IT MOVES WORK FROM. Everyone whose `outOfOfficeUntil` is in the FUTURE — i.e. who is out right
 * now. Not "everyone past their return date": a person who came back yesterday should keep the
 * tickets they were handed, and re-assigning them on their return would take work off the colleague
 * who has been carrying it. The column's own docstring in `prisma/schema.prisma` says the same thing
 * ("Set while this person is away"), and the read is deliberately written to match it.
 *
 * WHAT IT WILL NOT DO:
 *  - It never touches a RESOLVED, CLOSED or VOIDED ticket. Those are the historical record of who
 *    worked the ticket; nobody is waiting on them, and rewriting them would cost an audit row each
 *    for no operational gain. Exactly the rule `deactivateUser` already applies.
 *  - It never chains. If the named backup is themselves away, deactivated or a machine identity, the
 *    ticket is UNASSIGNED rather than handed to the backup's backup: a two-hop hand-off is how work
 *    ends up somewhere nobody expected, and the queue is a destination everybody can see.
 *  - It never assigns to the person who is out, obviously, and never to the requester's own account.
 *
 * IDEMPOTENCE is structural rather than bookkept: once a ticket is off the absent person it no longer
 * matches the query, so a second run in the same hour moves nothing. There is no cursor and no
 * dedupe table because there is nothing to dedupe.
 *
 * EVERY MOVE IS ONE TRANSACTION — the ticket update, the version bump, the `TICKET_ASSIGNED` row and
 * the recipient's notification commit together or not at all. Per ticket, not per run: one ticket
 * that fails (a concurrent write, a vanished backup) must not roll back the twenty that succeeded.
 */
import type { AuditEntry, QueueKey } from "@/types/domain";
import { OPEN_STATUSES } from "@/types/domain";
import { AUDIT_VIA, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { MACHINE_ACTOR_EMAILS } from "@/server/users";
import { notifyFromEvent } from "@/server/notifications";
import type { JobContext, JobOutcome } from "@/jobs/types";
import { errorLabel } from "@/jobs/logger";
import { firmDateKey } from "@/jobs/follow-up-nudges";

/** Hard bound on one run, so a firm-wide holiday cannot rewrite the whole board in one execution. */
export const OUT_OF_OFFICE_MAX_MOVES_PER_RUN = 500;

/** Who a ticket goes to, and why it went there. `toUserId: null` means "back to the queue". */
export type OutOfOfficeMove = {
  ticketId: string;
  ticketNumber: number;
  queueKey: QueueKey;
  fromUserId: string;
  fromEmail: string;
  toUserId: string | null;
  reason: "backup" | "unassigned";
};

type AbsentUser = {
  id: string;
  email: string;
  backupUserId: string | null;
  outOfOfficeUntil: Date | null;
};

type BackupUser = { id: string; email: string; isActive: boolean; outOfOfficeUntil: Date | null };

/**
 * Whether a named backup may actually receive work right now. Everything this refuses would produce a
 * ticket that looks assigned and is not being worked, which is the single failure this job exists to
 * prevent — so refusing it here and unassigning is strictly better than a successful-looking hand-off.
 */
export function backupIsUsable(backup: BackupUser | undefined, absentUserId: string, now: Date): boolean {
  if (backup === undefined) return false;
  if (backup.id === absentUserId) return false;
  if (!backup.isActive) return false;
  if (backup.outOfOfficeUntil !== null && backup.outOfOfficeUntil.getTime() > now.getTime()) return false;
  if (MACHINE_ACTOR_EMAILS.some((e) => e.toLowerCase() === backup.email.toLowerCase())) return false;
  return true;
}

/** Everyone who is out of office at `now`, with the backup they named. */
export async function findAbsentUsers(now: Date): Promise<AbsentUser[]> {
  return prisma.user.findMany({
    where: { outOfOfficeUntil: { gt: now } },
    select: { id: true, email: true, backupUserId: true, outOfOfficeUntil: true },
    orderBy: { email: "asc" },
  });
}

/**
 * The moves this run would make, in a deterministic order (ticket number ascending), capped.
 *
 * Reading the whole plan before writing any of it is what lets the digest line and the `JOB_RUN`
 * metadata describe the run honestly, and it keeps the per-ticket transactions small.
 */
export async function planMoves(now: Date, absent: readonly AbsentUser[]): Promise<OutOfOfficeMove[]> {
  if (absent.length === 0) return [];

  const backupIds = [...new Set(absent.map((a) => a.backupUserId).filter((id): id is string => id !== null))];
  const backups = backupIds.length === 0
    ? []
    : await prisma.user.findMany({
        where: { id: { in: backupIds } },
        select: { id: true, email: true, isActive: true, outOfOfficeUntil: true },
      });
  const backupById = new Map(backups.map((b) => [b.id, b] as const));

  const tickets = await prisma.ticket.findMany({
    where: { assigneeId: { in: absent.map((a) => a.id) }, status: { in: [...OPEN_STATUSES] } },
    select: {
      id: true,
      number: true,
      assigneeId: true,
      requesterEmail: true,
      queue: { select: { key: true } },
    },
    orderBy: { number: "asc" },
    take: OUT_OF_OFFICE_MAX_MOVES_PER_RUN,
  });

  const absentById = new Map(absent.map((a) => [a.id, a] as const));
  const moves: OutOfOfficeMove[] = [];
  for (const t of tickets) {
    const owner = t.assigneeId === null ? undefined : absentById.get(t.assigneeId);
    if (owner === undefined) continue;

    const backup = owner.backupUserId === null ? undefined : backupById.get(owner.backupUserId);
    const usable = backupIsUsable(backup, owner.id, now);
    // A ticket the requester themselves would receive goes back to the queue instead: a staff member
    // who raised a ticket about their own account must not be handed it by a rota.
    const selfService =
      usable &&
      backup !== undefined &&
      t.requesterEmail !== null &&
      t.requesterEmail.toLowerCase() === backup.email.toLowerCase();

    const toUserId = usable && !selfService && backup !== undefined ? backup.id : null;
    moves.push({
      ticketId: t.id,
      ticketNumber: t.number,
      queueKey: t.queue.key,
      fromUserId: owner.id,
      fromEmail: owner.email,
      toUserId,
      reason: toUserId === null ? "unassigned" : "backup",
    });
  }
  return moves;
}

/**
 * Applies ONE move in its own transaction. Returns false when the ticket moved underneath us — the
 * guarded `updateMany` on `assigneeId` is the whole concurrency control, and losing the race is not
 * an error: somebody with a name reassigned it, which is a better outcome than this job's.
 */
export async function applyMove(job: JobContext, move: OutOfOfficeMove): Promise<boolean> {
  return withTx(async (tx) => {
    const changed = await tx.ticket.updateMany({
      where: { id: move.ticketId, assigneeId: move.fromUserId, status: { in: [...OPEN_STATUSES] } },
      // `version` moves too, so anyone holding this ticket open gets a CONFLICT on their next write
      // rather than silently overwriting the hand-off.
      data: { assigneeId: move.toUserId, version: { increment: 1 } },
    });
    if (changed.count !== 1) return false;

    const entries: AuditEntry[] = [
      {
        action: "TICKET_ASSIGNED",
        entityType: "TICKET",
        entityId: move.ticketId,
        ticketId: move.ticketId,
        fieldChanged: "assigneeId",
        oldValue: move.fromUserId,
        newValue: move.toUserId,
        metadata: {
          reason: "out-of-office",
          disposition: move.reason,
          oldEmail: move.fromEmail,
          newEmail: null,
          via: AUDIT_VIA.job,
          jobName: job.name,
        },
      },
    ];

    if (move.toUserId !== null) {
      // Keyed on the OCCURRENCE, not just on (ticket, recipient): `Notification` is unique on
      // `(userId, dedupeKey)` with no time dimension, its rows are never deleted and nothing prunes
      // them, so `ooo:<ticket>:<user>` would be spent for good the first time — the same person
      // covering the same ticket during a later absence would be handed it with no notification at
      // all, silently (`skipDuplicates`, `created: 0`, no audit row). The firm-local day of the move
      // is the same occurrence stamp `follow-up-nudges.ts` puts on `dueOn`. Null when the instant is
      // unreadable: better a repeat than a hand-off nobody is told about.
      const day = firmDateKey(job.now);
      const notified = await notifyFromEvent(tx, {
        kind: "ASSIGNED",
        ticketId: move.ticketId,
        preview: `Covering while a colleague is out: HD-${move.ticketNumber}`,
        actorId: null,
        recipientIds: [move.toUserId],
        dedupeKey: day === null ? null : `ooo:${move.ticketId}:${move.toUserId}:${day}`,
      });
      entries.push(...notified.auditEntries);
    }

    await writeAuditMany(tx, job.actor, job.ctx, entries);
    return true;
  });
}

/**
 * The job. Plans, then applies one ticket at a time.
 *
 * It transmits nothing itself: the recipient learns through the in-app inbox row, and whether that
 * becomes a Slack DM is B1's dispatcher and `SLACK_USER_MAP`, which is unset. With nobody out of
 * office — the state this desk is in today — the run is two queries and an exit 0.
 */
export async function runOutOfOffice(job: JobContext): Promise<JobOutcome> {
  const absent = await findAbsentUsers(job.now);
  if (absent.length === 0) {
    job.log.info("nobody-out");
    return { processed: 0, skipped: 0, posted: 0, metadata: { absent: 0, planned: 0 } };
  }

  const moves = await planMoves(job.now, absent);
  job.log.info("planned", {
    absent: absent.length,
    planned: moves.length,
    toBackup: moves.filter((m) => m.reason === "backup").length,
    toQueue: moves.filter((m) => m.reason === "unassigned").length,
    capped: moves.length === OUT_OF_OFFICE_MAX_MOVES_PER_RUN,
  });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const move of moves) {
    try {
      if (await applyMove(job, move)) processed += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      // The ticket number is the only identifier that reaches the log; the person is not named.
      job.log.error("move-failed", { ticketNumber: move.ticketNumber, error: errorLabel(e) });
    }
  }

  return {
    processed,
    skipped: skipped + failed,
    posted: 0,
    ok: failed === 0,
    metadata: {
      absent: absent.length,
      planned: moves.length,
      toBackup: moves.filter((m) => m.reason === "backup").length,
      toQueue: moves.filter((m) => m.reason === "unassigned").length,
      raced: skipped,
      failed,
    },
  };
}
