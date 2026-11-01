/**
 * Follow-up nudges — node only (`FollowUpNudge`, schema §1.3).
 *
 * `Ticket.followUpAt` is a date somebody wrote down meaning "come back to this". Nothing read it on a
 * clock before now: it coloured a badge on a board, which only helps the person who happens to open
 * that board. This job reads it once a day and turns each due date into ONE `FOLLOW_UP_DUE`
 * notification for the people who are on the ticket.
 *
 * ONCE PER DUE DATE, AND THE UNIQUE CONSTRAINT IS THE DEDUPE. `FollowUpNudge @@unique([ticketId,
 * dueOn])` is append-only at the database (trigger + REVOKE), exactly like `SlaAlert`: the row IS the
 * record that this date was nudged, so a job that runs twice in a day, is re-run after a failure, or
 * overlaps with itself cannot nudge the same person twice. The insert is `ON CONFLICT DO NOTHING`
 * (`skipDuplicates`) and a count of zero ends that ticket's turn before any notification is written —
 * so the loser of a race sends nothing rather than rolling the winner back.
 *
 * `dueOn` IS A DATE, NOT AN INSTANT, and it is the FIRM's date (`src/lib/firm-time.ts`,
 * America/New_York, Decision #104). "Today" is a property of the desk's clock, not of the container's:
 * a job running at 02:00 UTC is still on the previous New York day, and keying the dedupe on a UTC
 * date would nudge twice for one commitment every evening. Moving a follow-up to a different date is
 * a new commitment and legitimately nudges again; leaving it where it is never does.
 *
 * WHO IS TOLD. `notifyFromEvent` with no explicit recipients, which resolves to the ticket's
 * followers plus its assignee. Nobody else: a follow-up is a private undertaking between the
 * desk and the ticket, not an announcement, and the requester is never told that an internal reminder
 * came due.
 *
 * WHAT IT TRANSMITS: nothing. The in-app row is the notification; whether it also becomes a Slack DM
 * is B1's dispatcher and `SLACK_USER_MAP`, which is unset. {@link followUpDigestLines} builds the
 * PII-light lines for B1's daily digest to include — the digest is B1's surface, so this module
 * offers the text and posts nothing itself. The literal shapes are in
 * the build record, marked DRAFT for approval.
 */
import type { AuditEntry, QueueKey, TicketPriority } from "@/types/domain";
import { OPEN_STATUSES } from "@/types/domain";
import { writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { firmWallClock } from "@/lib/firm-time";
import { notifyFromEvent } from "@/server/notifications";
import type { JobContext, JobOutcome } from "@/jobs/types";
import { errorLabel } from "@/jobs/logger";
import type { SlackLine } from "@/jobs/slack";
import { ticketLinkMarkup } from "@/jobs/slack";

/** Hard bound on one run, so a first run over a neglected board cannot nudge a thousand times. */
export const FOLLOW_UP_MAX_PER_RUN = 300;

/** Statuses whose follow-up commitment is still live. CLOSED and VOIDED have no future to come back to. */
export const FOLLOW_UP_STATUSES = [...OPEN_STATUSES, "RESOLVED"] as const;

export type FollowUpCandidate = {
  id: string;
  number: number;
  queueKey: QueueKey;
  priority: TicketPriority;
  followUpAt: Date;
  /** The firm-local calendar date the commitment was for, `YYYY-MM-DD`. The dedupe key. */
  dueOn: string;
  /** 0 on the day, positive once the date has passed — the number that makes the line worth reading. */
  daysOverdue: number;
};

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * `YYYY-MM-DD` on the firm clock. Returns null for an unreadable instant rather than throwing: a job
 * must not die on one malformed column, and a ticket with no readable date is simply not nudged.
 */
export function firmDateKey(at: Date): string | null {
  const wc = firmWallClock(at);
  if (wc === null) return null;
  return `${pad(wc.year, 4)}-${pad(wc.month)}-${pad(wc.day)}`;
}

/** Whole firm-local days between two dates, by calendar date rather than by elapsed hours. */
export function firmDaysBetween(from: Date, to: Date): number {
  const a = firmWallClock(from);
  const b = firmWallClock(to);
  if (a === null || b === null) return 0;
  const days = (wc: { year: number; month: number; day: number }): number =>
    Math.floor(Date.UTC(wc.year, wc.month - 1, wc.day) / 86_400_000);
  return days(b) - days(a);
}

/** Tickets whose follow-up date has arrived or passed, oldest commitment first. */
export async function findDueFollowUps(now: Date): Promise<FollowUpCandidate[]> {
  const rows = await prisma.ticket.findMany({
    where: {
      followUpAt: { not: null, lte: now },
      status: { in: [...FOLLOW_UP_STATUSES] },
    },
    select: {
      id: true,
      number: true,
      priority: true,
      followUpAt: true,
      queue: { select: { key: true } },
    },
    orderBy: [{ followUpAt: "asc" }, { number: "asc" }],
    take: FOLLOW_UP_MAX_PER_RUN,
  });

  const out: FollowUpCandidate[] = [];
  for (const r of rows) {
    if (r.followUpAt === null) continue;
    const dueOn = firmDateKey(r.followUpAt);
    if (dueOn === null) continue;
    out.push({
      id: r.id,
      number: r.number,
      queueKey: r.queue.key,
      priority: r.priority,
      followUpAt: r.followUpAt,
      dueOn,
      daysOverdue: Math.max(0, firmDaysBetween(r.followUpAt, now)),
    });
  }
  return out;
}

/**
 * Records ONE nudge: the `FollowUpNudge` row and the notifications it produced, in one transaction.
 * Returns false when this (ticket, date) was already nudged — by an earlier run or by a concurrent
 * one — which is the constraint doing its job, not a failure.
 */
export async function recordNudge(job: JobContext, candidate: FollowUpCandidate): Promise<boolean> {
  return withTx(async (tx) => {
    const inserted = await tx.followUpNudge.createMany({
      data: [{ ticketId: candidate.id, dueOn: candidate.dueOn }],
      skipDuplicates: true,
    });
    if (inserted.count !== 1) return false;

    const overdue =
      candidate.daysOverdue === 0
        ? "today"
        : `${candidate.daysOverdue} ${candidate.daysOverdue === 1 ? "day" : "days"} ago`;
    const notified = await notifyFromEvent(tx, {
      kind: "FOLLOW_UP_DUE",
      ticketId: candidate.id,
      preview: `Follow-up due ${overdue}: HD-${candidate.number}`,
      actorId: null,
      dedupeKey: `follow-up:${candidate.id}:${candidate.dueOn}`,
    });

    // The nudge itself is not audited (CONTRACT §3 rule 3 — a notification is derived from a fact
    // already on the ledger, and the `JOB_RUN` row records the run). What IS audited is anything the
    // notification core did on its own account, which today is an auto-follow.
    const entries: AuditEntry[] = [...notified.auditEntries];
    if (entries.length > 0) await writeAuditMany(tx, job.actor, job.ctx, entries);
    return true;
  });
}

/** ONE digest line. PII-light: number, queue, priority, how overdue, and the deep link. Nothing else. */
export function followUpNudgeLine(candidate: FollowUpCandidate, base: string | undefined): SlackLine {
  const when = candidate.daysOverdue === 0 ? "due today" : `${candidate.daysOverdue}d overdue`;
  return {
    text: [
      ":calendar: FOLLOW-UP",
      ticketLinkMarkup(candidate.number, base),
      candidate.queueKey,
      candidate.priority,
      when,
    ].join(" | "),
  };
}

/** Header + one line per nudge, for B1's daily digest. Counts only in the header. */
export function followUpDigestLines(
  candidates: readonly FollowUpCandidate[],
  base: string | undefined,
): SlackLine[] {
  if (candidates.length === 0) return [];
  const overdue = candidates.filter((c) => c.daysOverdue > 0).length;
  const noun = candidates.length === 1 ? "follow-up" : "follow-ups";
  return [
    {
      text: `*WM help desk — follow-ups:* ${candidates.length} ${noun} due (${overdue} overdue)`,
    },
    ...candidates.map((c) => followUpNudgeLine(c, base)),
  ];
}

/** The job. Finds due commitments, records one nudge each, and transmits nothing. */
export async function runFollowUpNudges(job: JobContext): Promise<JobOutcome> {
  const candidates = await findDueFollowUps(job.now);
  job.log.info("candidates", {
    found: candidates.length,
    overdue: candidates.filter((c) => c.daysOverdue > 0).length,
    capped: candidates.length === FOLLOW_UP_MAX_PER_RUN,
  });

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      if (await recordNudge(job, candidate)) processed += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      job.log.error("nudge-failed", { ticketNumber: candidate.number, error: errorLabel(e) });
    }
  }

  return {
    processed,
    skipped: skipped + failed,
    posted: 0,
    ok: failed === 0,
    metadata: {
      found: candidates.length,
      alreadyNudged: skipped,
      failed,
      overdue: candidates.filter((c) => c.daysOverdue > 0).length,
      capped: candidates.length === FOLLOW_UP_MAX_PER_RUN,
    },
  };
}
