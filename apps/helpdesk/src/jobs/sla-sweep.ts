/**
 * SLA sweep — node only, runs on the 5-minute schedule.
 *
 * Nothing in the app ran on a clock before this. The sweep finds tickets whose live SLA clock has just
 * entered WARNING or BREACHED, records ONE durable alert per (ticket, LIFECYCLE, phase, kind), and posts a
 * single PII-light digest per run.
 *
 * WHY THE PREDICATES ARE REUSED, NOT REWRITTEN: `src/server/sla-where.ts` already classifies a ticket in
 * SQL exactly as the pure `computeSlaStatus` does, and the dashboard badges and queue counters read the
 * same predicates. A second, job-local definition of "breached" would drift from the number on the
 * dashboard, and the first anyone would notice is a page that disagrees with the screen.
 *
 * DEDUPE IS PER LIFECYCLE, NOT PER TICKET — and this is the part that is easy to get wrong.
 *
 *   A ticket is not a straight line. `addRequesterMessageCore` moves RESOLVED → OPEN and clears
 *   `resolvedAt` (`src/server/ingest.ts`, `TICKET_REOPENED_BY_REQUESTER`), and `changeTicketStatus` does
 *   the same for a staff reopen (`TICKET_STATUS_CHANGED`, RESOLVED → OPEN). A ticket that breached
 *   RESOLUTION, was resolved, and is then reopened by a client reply is a LIVE breach again —
 *   `findSlaCandidates` finds it — but the alert for `(ticket, RESOLUTION, BREACHED)` is already on the
 *   ledger. Keyed on the ticket alone, that first breach silences every later one for the life of the
 *   record and nobody is ever paged again.
 *
 *   So the question this file asks is not "has this ticket ever alerted?" but "has this ticket alerted
 *   SINCE its current lifecycle began?". The lifecycle boundary is the most recent reopen event in the
 *   audit ledger (`findCycleStarts`); before the first reopen there is no boundary and the answer is the
 *   old one, unchanged.
 *
 * WHERE THE PER-CYCLE RECORD LIVES: `SlaAlert @@unique([ticketId, phase, kind])` is the ticket's FIRST
 * alert of each kind, append-only at the DB (trigger + REVOKE), so that row can be neither extended nor
 * rewritten for a second cycle. The per-cycle record is therefore the `SLA_ALERT` AUDIT row — which the
 * sweep already wrote for every alert, which is itself append-only, hash-chained and timestamped, and
 * which carries `<PHASE>:<KIND>` in `newValue`. `lastAlertAtByKey` reads both surfaces and takes the
 * later of the two. A cleaner shape is a `slaCycle` column on `Ticket` in the unique constraint; that is
 * a shared-schema change this slice may not make, and the exact migration is written out in
 * the build record
 *
 * CONCURRENCY: two overlapping executions must not both page for the same cycle. The first cycle is
 * protected by the unique constraint. Every cycle, first or later, is protected by a per-ticket
 * transaction-scoped advisory lock taken as the first statement of `recordSlaAlert`, so the second
 * transaction blocks, then re-reads under a fresh snapshot and sees the winner's committed audit row.
 * Lock order is always (SlaAlert.cycle → AuditLog.chain) and nothing takes them the other way round, so
 * the pair cannot deadlock.
 *
 * Each alert is its own transaction: the `SlaAlert` insert and its `SLA_ALERT` audit row commit together
 * or not at all (§3: the audit row is the last statement of the transaction that made the change).
 */
import type { Prisma } from "@prisma/client";
import type { QueueKey, SlaAlertKind, SlaAlertPhase, TicketPriority } from "@/types/domain";
import { SLA_ALERT_KINDS, SLA_ALERT_PHASES } from "@/types/domain";
import { AUDIT_VIA, writeAudit } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import type { DbTx } from "@/lib/db";
import { env } from "@/lib/env";
import {
  breachedOpenWhere,
  loadWarningMinutes,
  warningMinutesFor,
  warningOpenWhere,
} from "@/server/sla-where";
import type { WarningMinutesByPriority } from "@/server/sla-where";
import type { JobContext, JobOutcome } from "@/jobs/types";
import { appBaseUrl, postSlack, ticketLinkMarkup } from "@/jobs/slack";
import type { SlackLine, SlackPostResult } from "@/jobs/slack";

/** Hard bound on one run, so a first sweep over a neglected backlog cannot page 4 000 times. */
export const SLA_SWEEP_MAX_ALERTS_PER_RUN = 200;

/** The ticket fields the sweep needs. No subject, no requester — it never reads client material. */
export const SLA_SWEEP_SELECT = {
  id: true,
  number: true,
  priority: true,
  firstRespondedAt: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  queue: { select: { key: true } },
} as const satisfies Prisma.TicketSelect;

export type SlaCandidate = {
  id: string;
  number: number;
  priority: TicketPriority;
  queueKey: QueueKey;
  firstRespondedAt: Date | null;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  /**
   * When the ticket's CURRENT SLA lifecycle began: the moment of the most recent reopen, or `null` for a
   * ticket that has never been reopened. An alert that fired before this instant belongs to a finished
   * lifecycle and must not silence the live one.
   */
  cycleStartedAt: Date | null;
};

export type SlaAlertDecision = {
  phase: SlaAlertPhase;
  kind: SlaAlertKind;
  /** Whole minutes past due. 0 for WARNING, which is by definition not yet over. */
  minutesOver: number;
  /** Whole minutes until due. 0 for BREACHED. Display only — never persisted. */
  minutesToDue: number;
};

export type SlaAlertCandidate = SlaCandidate & SlaAlertDecision;

/**
 * Which clock a ticket is on, and where that clock stands — the same split `sla-where.ts` makes:
 * no first response yet means the FIRST_RESPONSE clock; otherwise the RESOLUTION clock.
 *
 * Boundaries match the predicates exactly: due < now is BREACHED; due in [now, now + W) is WARNING;
 * anything further out is not an alert. `due === now` is WARNING, not BREACHED, exactly as
 * `firstResponseDueAt: { gte: now, lt: W }` has it.
 *
 * WAVE B: W is the PRIORITY'S band, read live from `SLA.warningMinutes`, not the fixed
 * 30 minutes this function used to hard-code. `warnings` is optional and an omitted or unreadable band
 * resolves to 30, so every existing caller and every test that does not care still gets the historical
 * behaviour — and, more importantly, this function and `findSlaCandidates`'s SQL cannot disagree about
 * where the band is, because both take the same map from the same loader.
 *
 * `warningMinutes: 0` is a real choice rather than a missing value: the WARNING window becomes empty
 * and that priority goes from no alert straight to BREACHED.
 */
export function classifySlaAlert(
  ticket: SlaCandidate,
  now: Date,
  warnings?: WarningMinutesByPriority,
): SlaAlertDecision | null {
  const phase: SlaAlertPhase = ticket.firstRespondedAt === null ? "FIRST_RESPONSE" : "RESOLUTION";
  const dueAt = phase === "FIRST_RESPONSE" ? ticket.firstResponseDueAt : ticket.resolutionDueAt;
  const remainingMs = dueAt.getTime() - now.getTime();
  if (remainingMs < 0) {
    return { phase, kind: "BREACHED", minutesOver: Math.floor(-remainingMs / 60_000), minutesToDue: 0 };
  }
  const warningMs = warningMinutesFor(ticket.priority, warnings) * 60_000;
  if (remainingMs < warningMs) {
    return { phase, kind: "WARNING", minutesOver: 0, minutesToDue: Math.floor(remainingMs / 60_000) };
  }
  return null;
}

export const SLA_PHASE_LABELS: Readonly<Record<SlaAlertPhase, string>> = {
  FIRST_RESPONSE: "first response",
  RESOLUTION: "resolution",
};

/** `(ticketId, phase, kind)` as one comparable string — the shape of the unique constraint. */
export function alertKey(ticketId: string, phase: SlaAlertPhase, kind: SlaAlertKind): string {
  return `${ticketId}|${phase}|${kind}`;
}

/** The `newValue` an `SLA_ALERT` audit row carries. The audit ledger is the per-cycle alert record. */
export function alertVerdict(phase: SlaAlertPhase, kind: SlaAlertKind): string {
  return `${phase}:${kind}`;
}

/**
 * The inverse of `alertVerdict`, for reading the ledger back. Returns null for anything that is not a
 * verdict this code would have written — a future enum value, a truncated row, a null.
 */
export function parseAlertVerdict(
  newValue: string | null,
): { phase: SlaAlertPhase; kind: SlaAlertKind } | null {
  if (newValue === null) return null;
  const [phase, kind, ...rest] = newValue.split(":");
  if (rest.length > 0 || phase === undefined || kind === undefined) return null;
  if (!(SLA_ALERT_PHASES as readonly string[]).includes(phase)) return null;
  if (!(SLA_ALERT_KINDS as readonly string[]).includes(kind)) return null;
  return { phase: phase as SlaAlertPhase, kind: kind as SlaAlertKind };
}

/**
 * Has this ticket already been paged for this (phase, kind) WITHIN ITS CURRENT LIFECYCLE?
 *
 * - never alerted at all → no;
 * - alerted, and the ticket has never been reopened → yes (the pre-reopen behaviour, unchanged);
 * - alerted, and the ticket HAS been reopened → only if the alert fired at or after the reopen.
 *
 * `>=` rather than `>` is deliberate: an alert stamped in the same millisecond as the reopen was written
 * by a sweep that had already seen the reopened row, so it belongs to the new cycle.
 */
export function alertAlreadyFiredThisCycle(
  lastAlertAt: Date | undefined,
  cycleStartedAt: Date | null,
): boolean {
  if (lastAlertAt === undefined) return false;
  if (cycleStartedAt === null) return true;
  return lastAlertAt.getTime() >= cycleStartedAt.getTime();
}

/**
 * ONE alert line. PII-light by construction: number, queue, priority, phase, how far over, deep link, and
 * — for a ticket on its second or later lifecycle — the word `reopened`, so a repeat page for a number
 * somebody remembers closing reads as deliberate rather than as a duplicate.
 * The literal shape is the build record section 1.
 */
export function slaAlertLine(alert: SlaAlertCandidate, base: string | undefined): SlackLine {
  const marker = alert.kind === "BREACHED" ? ":red_circle: BREACHED" : ":large_yellow_circle: WARNING";
  const clock =
    alert.kind === "BREACHED"
      ? `${formatMinutes(alert.minutesOver)} over`
      : `due in ${formatMinutes(alert.minutesToDue)}`;
  const parts = [
    marker,
    ticketLinkMarkup(alert.number, base),
    alert.queueKey,
    alert.priority,
    SLA_PHASE_LABELS[alert.phase],
    clock,
  ];
  if (alert.cycleStartedAt !== null) parts.push("reopened");
  return { text: parts.join(" | ") };
}

/** `0m`, `45m`, `3h 05m`, `2d 04h` — compact enough for a Slack line, exact enough to act on. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  if (hours < 24) return `${hours}h ${String(total % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}

/** The digest header: counts only, no ticket detail. the build record section 1. */
export function slaDigestHeader(alerts: readonly SlaAlertCandidate[]): SlackLine {
  const breached = alerts.filter((a) => a.kind === "BREACHED").length;
  const warning = alerts.length - breached;
  const noun = alerts.length === 1 ? "alert" : "alerts";
  return { text: `*WM help desk — SLA sweep:* ${alerts.length} new ${noun} (${breached} breached, ${warning} warning)` };
}

/** Header + one line per alert, in the order the callers fire them. */
export function slaDigestLines(alerts: readonly SlaAlertCandidate[], base: string | undefined): SlackLine[] {
  return [slaDigestHeader(alerts), ...alerts.map((a) => slaAlertLine(a, base))];
}

/**
 * BREACHED before WARNING, then the most overdue first, then by ticket number so a run is deterministic
 * and the `SLA_SWEEP_MAX_ALERTS_PER_RUN` cut always keeps the worst.
 */
export function orderAlerts(alerts: readonly SlaAlertCandidate[]): SlaAlertCandidate[] {
  const rank = (a: SlaAlertCandidate): number => (a.kind === "BREACHED" ? 0 : 1);
  return [...alerts].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.minutesOver !== b.minutesOver) return b.minutesOver - a.minutesOver;
    if (a.minutesToDue !== b.minutesToDue) return a.minutesToDue - b.minutesToDue;
    return a.number - b.number;
  });
}

/** Prisma's unique-constraint violation, recognised without importing the runtime error class. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

/**
 * The audit rows that end one SLA lifecycle and start the next. Both paths that clear `resolvedAt` are
 * covered, and only those: a PENDING_CLIENT → OPEN unblock is not a reopen (the ticket was never
 * resolved, so its clock never stopped) and a RESOLVED → CLOSED transition ends the record entirely.
 */
export function cycleResetWhere(ticketIds: readonly string[]): Prisma.AuditLogWhereInput {
  return {
    ticketId: { in: [...ticketIds] },
    OR: [
      { action: "TICKET_REOPENED_BY_REQUESTER" },
      { action: "TICKET_STATUS_CHANGED", oldValue: "RESOLVED", newValue: "OPEN" },
    ],
  };
}

/**
 * When each ticket's current SLA lifecycle began — the most recent reopen. Tickets that have never been
 * reopened are absent from the map, which is the same thing as "one lifecycle, the original one".
 */
export async function findCycleStarts(ticketIds: readonly string[]): Promise<Map<string, Date>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await prisma.auditLog.findMany({
    where: cycleResetWhere(ticketIds),
    select: { ticketId: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });
  const out = new Map<string, Date>();
  // Ascending, so the last write for a ticket is its latest reopen.
  for (const row of rows) {
    if (row.ticketId !== null) out.set(row.ticketId, row.occurredAt);
  }
  return out;
}

/**
 * Candidates: unresolved tickets whose live clock is in WARNING or BREACHED, by the shared predicates.
 *
 * `warnings` is threaded into both predicates so the SQL that SELECTS a candidate and the arithmetic
 * that CLASSIFIES it use one definition of the band. Passing it in rather than loading
 * it here keeps one read per run and keeps the function testable with an explicit map.
 */
export async function findSlaCandidates(
  now: Date,
  warnings?: WarningMinutesByPriority,
): Promise<SlaCandidate[]> {
  const rows = await prisma.ticket.findMany({
    where: {
      AND: [{ resolvedAt: null }, { OR: [warningOpenWhere(now, warnings), breachedOpenWhere(now, warnings)] }],
    },
    select: SLA_SWEEP_SELECT,
    orderBy: { number: "asc" },
  });
  const cycleStarts = await findCycleStarts(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    priority: r.priority,
    queueKey: r.queue.key,
    firstRespondedAt: r.firstRespondedAt,
    firstResponseDueAt: r.firstResponseDueAt,
    resolutionDueAt: r.resolutionDueAt,
    cycleStartedAt: cycleStarts.get(r.id) ?? null,
  }));
}

/**
 * When each `(ticketId, phase, kind)` last fired, across BOTH records of an alert: the `SlaAlert` ledger
 * (the ticket's first alert of that kind, `firedAt`) and the `SLA_ALERT` audit rows (every alert of that
 * kind, `occurredAt`). The later of the two wins, so a ticket whose second-cycle alert exists only in the
 * ledger's audit half is still correctly seen as alerted.
 */
export async function lastAlertAtByKey(ticketIds: readonly string[]): Promise<Map<string, Date>> {
  if (ticketIds.length === 0) return new Map();
  const ids = [...ticketIds];
  const [ledger, audited] = await Promise.all([
    prisma.slaAlert.findMany({
      where: { ticketId: { in: ids } },
      select: { ticketId: true, phase: true, kind: true, firedAt: true },
    }),
    prisma.auditLog.findMany({
      where: { ticketId: { in: ids }, action: "SLA_ALERT" },
      select: { ticketId: true, newValue: true, occurredAt: true },
    }),
  ]);

  const out = new Map<string, Date>();
  const bump = (key: string, at: Date): void => {
    const prev = out.get(key);
    if (prev === undefined || at.getTime() > prev.getTime()) out.set(key, at);
  };
  for (const row of ledger) bump(alertKey(row.ticketId, row.phase, row.kind), row.firedAt);
  for (const row of audited) {
    if (row.ticketId === null) continue;
    const verdict = parseAlertVerdict(row.newValue);
    if (verdict === null) continue;
    bump(alertKey(row.ticketId, verdict.phase, verdict.kind), row.occurredAt);
  }
  return out;
}

/**
 * Serialises every sweep transaction that touches one ticket, so the check-then-write below is atomic
 * against a concurrent execution. Transaction-scoped: released on COMMIT or ROLLBACK, never leaked.
 *
 * The two-argument form of `pg_advisory_xact_lock` occupies a lock space distinct from the one-argument
 * form `20260916000100_audit_immutability` uses for the hash chain, so the two can never collide.
 */
async function lockTicketCycle(tx: DbTx, ticketId: string): Promise<void> {
  // `pg_advisory_xact_lock` returns `void`, which Prisma's `$queryRaw` cannot deserialize and `void`
  // cannot be cast out of — so the call goes in the FROM list and the projection is a constant.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('SlaAlert.cycle'), hashtext(${ticketId}))`;
}

/**
 * Writes one alert: the `SLA_ALERT` audit row, and the `SlaAlert` ledger row when this is the ticket's
 * first alert of this kind, in ONE transaction, audit last.
 *
 * The ledger insert is `ON CONFLICT DO NOTHING` (`skipDuplicates`) rather than a plain insert, because on
 * a second lifecycle the row is legitimately already there and a P2002 would abort a transaction that
 * still has an audit row to write. `ledgerRowCreated` in the audit metadata says which of the two
 * happened, so a reader can tell the ledger's `minutesOver` (the FIRST cycle's, frozen by the append-only
 * trigger) from this alert's, which is always in the audit row.
 *
 * Returns false when the alert had already fired for this lifecycle — a concurrent run won the race.
 */
export async function recordSlaAlert(job: JobContext, alert: SlaAlertCandidate): Promise<boolean> {
  const verdict = alertVerdict(alert.phase, alert.kind);
  try {
    return await withTx(async (tx) => {
      await lockTicketCycle(tx, alert.id);

      const inserted = await tx.slaAlert.createMany({
        data: [{ ticketId: alert.id, phase: alert.phase, kind: alert.kind, minutesOver: alert.minutesOver }],
        skipDuplicates: true,
      });
      const ledgerRowCreated = inserted.count === 1;

      if (!ledgerRowCreated) {
        // The ledger already holds this ticket's first alert of this kind. That silences us only if the
        // alert belongs to the lifecycle the ticket is on NOW.
        if (alert.cycleStartedAt === null) return false;
        const firedThisCycle = await tx.auditLog.count({
          where: {
            ticketId: alert.id,
            action: "SLA_ALERT",
            newValue: verdict,
            occurredAt: { gte: alert.cycleStartedAt },
          },
        });
        if (firedThisCycle > 0) return false;
      }

      await writeAudit(tx, job.actor, job.ctx, {
        action: "SLA_ALERT",
        entityType: "TICKET",
        entityId: alert.id,
        ticketId: alert.id,
        fieldChanged: "slaStatus",
        newValue: verdict,
        metadata: {
          minutesOver: alert.minutesOver,
          queueKey: alert.queueKey,
          priority: alert.priority,
          cycleStartedAt: alert.cycleStartedAt === null ? null : alert.cycleStartedAt.toISOString(),
          reopened: alert.cycleStartedAt !== null,
          ledgerRowCreated,
          via: AUDIT_VIA.job,
          jobName: job.name,
        },
      });
      return true;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/**
 * The job. Sweeps, records, then posts ONE digest.
 *
 * A Slack failure fails the run (`ok: false`, non-zero exit) even though every alert is durably on the
 * ledger: an alerting channel that silently stops delivering is the failure mode this job exists to
 * prevent, and the Cloud Run execution status is where an operator sees it. A run with the webhook unset
 * is NOT a failure — that is the disabled state Wave A ships in.
 */
export async function runSlaSweep(job: JobContext): Promise<JobOutcome> {
  // One read of the four-row policy table per run, threaded into the query AND the classifier so they
  // cannot disagree about where the warning band is.
  const warnings = await loadWarningMinutes();
  const candidates = await findSlaCandidates(job.now, warnings);
  const decided: SlaAlertCandidate[] = [];
  for (const candidate of candidates) {
    const decision = classifySlaAlert(candidate, job.now, warnings);
    if (decision !== null) decided.push({ ...candidate, ...decision });
  }

  const lastAlertAt = await lastAlertAtByKey(decided.map((d) => d.id));
  const fresh = orderAlerts(
    decided.filter(
      (d) => !alertAlreadyFiredThisCycle(lastAlertAt.get(alertKey(d.id, d.phase, d.kind)), d.cycleStartedAt),
    ),
  );
  const capped = fresh.slice(0, SLA_SWEEP_MAX_ALERTS_PER_RUN);
  const deferred = fresh.length - capped.length;

  job.log.info("candidates", {
    scanned: candidates.length,
    alertable: decided.length,
    alreadyAlerted: decided.length - fresh.length,
    fresh: fresh.length,
    reopened: fresh.filter((d) => d.cycleStartedAt !== null).length,
    deferred,
  });

  const recorded: SlaAlertCandidate[] = [];
  let raced = 0;
  for (const alert of capped) {
    if (await recordSlaAlert(job, alert)) {
      recorded.push(alert);
    } else {
      raced += 1;
    }
  }

  let slack: SlackPostResult = "disabled";
  if (recorded.length > 0) {
    slack = await postSlack(env.SLA_ALERT_SLACK_WEBHOOK_URL, slaDigestLines(recorded, appBaseUrl()));
    job.log.info("digest", { alerts: recorded.length, slack });
  }
  if (slack === "failed") job.log.error("slack-post-failed", { alerts: recorded.length });

  return {
    processed: recorded.length,
    skipped: decided.length - recorded.length,
    posted: slack === "posted" ? 1 : 0,
    ok: slack !== "failed",
    metadata: {
      scanned: candidates.length,
      alertable: decided.length,
      raced,
      deferred,
      breached: recorded.filter((a) => a.kind === "BREACHED").length,
      warning: recorded.filter((a) => a.kind === "WARNING").length,
      reopened: recorded.filter((a) => a.cycleStartedAt !== null).length,
      slack,
    },
  };
}
