/**
 * Auto-close — node only (the build record B4 and §4 `AUTO_CLOSE_DAYS`).
 *
 * A RESOLVED ticket is an answer the desk has given and nobody has objected to. It is not CLOSED,
 * because the requester may still reply — `addRequesterMessageCore` moves RESOLVED → OPEN and clears
 * `resolvedAt`, and that reopen is the whole reason the two statuses are different. After
 * `AUTO_CLOSE_DAYS` of silence the desk stops holding the file open: RESOLVED → CLOSED, by SYSTEM,
 * with an audit row and a notification to whoever was following it.
 *
 * DISABLED UNLESS THE KEY IS SET. `AUTO_CLOSE_DAYS` unset means the job logs "disabled" and exits 0
 *. That is the state this branch ships in: nothing closes itself until somebody chooses
 * a number of days. A wrong number here silently ends correspondence, so it is not given a default.
 *
 * WHAT IT REFUSES TO CLOSE, and each refusal is a promise the desk made that CLOSED would quietly
 * break:
 *  - **A ticket with an outstanding follow-up** (`followUpAt` in the future). Somebody wrote down a
 *    date they intend to come back to this; closing it before that date deletes the commitment from
 *    every board it appears on. A follow-up date already in the PAST does not protect the ticket —
 *    the nudge for it has already fired and the ticket has since sat untouched for the whole window.
 *  - **Anything not RESOLVED.** PENDING_CLIENT is the desk waiting on a person, not an answer given,
 *    and auto-closing it is how a client who was asked a question gets ignored. VOIDED is excluded
 *    twice over (it is not RESOLVED, and it is in `METRICS_EXCLUDED_STATUSES`).
 *  - **A ticket whose `resolvedAt` is null.** The clock has to be readable; without it "older than N
 *    days" has no meaning, and guessing from `updatedAt` would close tickets on an edit timestamp.
 *
 * `RESOLVED → CLOSED` is a legal transition (`ALLOWED_STATUS_TRANSITIONS`), and it is the only one
 * this job makes. It stamps `closedAt` exactly as `changeTicketStatus` does, so a ticket closed by the
 * desk and one closed by the clock are indistinguishable afterwards except in the ledger, where the
 * actor and `metadata.reason` say which.
 *
 * Each close is its own transaction, guarded on the status it read, so a ticket the requester reopens
 * mid-run is skipped rather than closed out from under them.
 */
import type { AuditEntry, QueueKey } from "@/types/domain";
import { AUDIT_VIA, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { env } from "@/lib/env";
import { notifyFromEvent } from "@/server/notifications";
import type { JobContext, JobOutcome } from "@/jobs/types";
import { errorLabel } from "@/jobs/logger";
import { firmDateKey } from "@/jobs/follow-up-nudges";

/** Hard bound on one run: a first run against a long backlog closes 500, then 500 an hour later. */
export const AUTO_CLOSE_MAX_PER_RUN = 500;

const MS_PER_DAY = 24 * 60 * 60_000;

export type AutoCloseCandidate = {
  id: string;
  number: number;
  queueKey: QueueKey;
  resolvedAt: Date;
  /** Whole days the ticket has sat RESOLVED, for the log and the audit row. */
  daysResolved: number;
};

/** The cut-off: a ticket resolved at or before this has been silent for the whole window. */
export function cutoffFor(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * RESOLVED tickets past the cut-off with no outstanding follow-up, oldest first — so a capped run
 * always closes the ones that have waited longest, and a re-run continues where it stopped.
 */
export async function findAutoCloseCandidates(now: Date, days: number): Promise<AutoCloseCandidate[]> {
  const cutoff = cutoffFor(now, days);
  const rows = await prisma.ticket.findMany({
    where: {
      status: "RESOLVED",
      resolvedAt: { not: null, lte: cutoff },
      OR: [{ followUpAt: null }, { followUpAt: { lte: now } }],
    },
    select: { id: true, number: true, resolvedAt: true, queue: { select: { key: true } } },
    orderBy: [{ resolvedAt: "asc" }, { number: "asc" }],
    take: AUTO_CLOSE_MAX_PER_RUN,
  });

  const out: AutoCloseCandidate[] = [];
  for (const r of rows) {
    if (r.resolvedAt === null) continue;
    out.push({
      id: r.id,
      number: r.number,
      queueKey: r.queue.key,
      resolvedAt: r.resolvedAt,
      daysResolved: Math.floor((now.getTime() - r.resolvedAt.getTime()) / MS_PER_DAY),
    });
  }
  return out;
}

/**
 * The notification dedupe key for ONE auto-close, keyed on the OCCURRENCE rather than on the ticket.
 *
 * `Notification @@unique([userId, dedupeKey])` carries no time dimension, the rows are never
 * hard-deleted (schema §1.3, trigger `notification_no_delete`) and nothing prunes them — so a
 * key is permanent for the life of the database. `auto-close:<ticketId>` would therefore be spent
 * the first time: a ticket auto-closed, reopened by the requester (RESOLVED → OPEN is an allowed
 * transition and the whole reason the two statuses differ), worked, resolved and auto-closed again
 * would tell its followers nothing the second time — silently, because `notifyFromEvent` inserts
 * with `skipDuplicates` and reports `created: 0` rather than an error, and a notification that was
 * not written leaves no audit row saying so.
 *
 * Adding the firm-local date of the close is the pattern `follow-up-nudges.ts` already uses for
 * `dueOn` and for the same reason: a second close of the same ticket is a second event and is
 * legitimately worth a second row, while a re-run or a retry on the same day is not. The date is the
 * FIRM's (America/New_York), not the container's — a job running at 02:00 UTC is
 * still on the previous New York day.
 *
 * Returns null — meaning "do not collapse this one" — when the instant is unreadable. Telling a
 * follower twice is a smaller harm than a close nobody is told about, and this job already refuses
 * to guess at an unreadable clock elsewhere.
 */
export function autoCloseDedupeKey(ticketId: string, closedAt: Date): string | null {
  const day = firmDateKey(closedAt);
  return day === null ? null : `auto-close:${ticketId}:${day}`;
}

/**
 * Closes ONE ticket. Returns false when it is no longer RESOLVED — a requester replied, or a staff
 * member closed or reopened it between the read and the write. Losing that race is the correct
 * outcome, not an error.
 */
export async function closeOne(job: JobContext, candidate: AutoCloseCandidate, days: number): Promise<boolean> {
  return withTx(async (tx) => {
    const closedAt = job.now;
    const changed = await tx.ticket.updateMany({
      where: { id: candidate.id, status: "RESOLVED" },
      data: { status: "CLOSED", closedAt, version: { increment: 1 } },
    });
    if (changed.count !== 1) return false;

    const entries: AuditEntry[] = [
      {
        action: "TICKET_STATUS_CHANGED",
        entityType: "TICKET",
        entityId: candidate.id,
        ticketId: candidate.id,
        fieldChanged: "status",
        oldValue: "RESOLVED",
        newValue: "CLOSED",
        metadata: {
          reason: "auto-close",
          autoCloseDays: days,
          daysResolved: candidate.daysResolved,
          queueKey: candidate.queueKey,
          via: AUDIT_VIA.job,
          jobName: job.name,
        },
      },
      {
        action: "TICKET_FIELD_CHANGED",
        entityType: "TICKET",
        entityId: candidate.id,
        ticketId: candidate.id,
        fieldChanged: "closedAt",
        oldValue: null,
        newValue: closedAt.toISOString(),
        metadata: { reason: "auto-close", via: AUDIT_VIA.job, jobName: job.name },
      },
    ];

    // Followers only. There is no client-facing message here: closing a ticket nobody has touched for
    // a fortnight is desk housekeeping, and mailing a client to tell them so would be the desk making
    // contact for its own benefit. `RESOLVED_NOTICE_ENABLED` covers the message that matters, and it
    // fires when the answer is given.
    const notified = await notifyFromEvent(tx, {
      kind: "FOLLOWED_UPDATE",
      ticketId: candidate.id,
      preview: `Closed automatically after ${days} ${days === 1 ? "day" : "days"}: HD-${candidate.number}`,
      actorId: null,
      dedupeKey: autoCloseDedupeKey(candidate.id, closedAt),
    });
    entries.push(...notified.auditEntries);

    await writeAuditMany(tx, job.actor, job.ctx, entries);
    return true;
  });
}

/** The job. Exits 0 with `disabled: true` when `AUTO_CLOSE_DAYS` is unset — that is not a failure. */
export async function runAutoClose(job: JobContext): Promise<JobOutcome> {
  const days = env.AUTO_CLOSE_DAYS;
  if (days === undefined) {
    job.log.info("disabled", { reason: "AUTO_CLOSE_DAYS is not set" });
    return { processed: 0, skipped: 0, posted: 0, metadata: { disabled: true } };
  }

  const candidates = await findAutoCloseCandidates(job.now, days);
  job.log.info("candidates", {
    autoCloseDays: days,
    found: candidates.length,
    capped: candidates.length === AUTO_CLOSE_MAX_PER_RUN,
  });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      if (await closeOne(job, candidate, days)) processed += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      job.log.error("close-failed", { ticketNumber: candidate.number, error: errorLabel(e) });
    }
  }

  return {
    processed,
    skipped: skipped + failed,
    posted: 0,
    ok: failed === 0,
    metadata: {
      autoCloseDays: days,
      found: candidates.length,
      raced: skipped,
      failed,
      capped: candidates.length === AUTO_CLOSE_MAX_PER_RUN,
    },
  };
}
