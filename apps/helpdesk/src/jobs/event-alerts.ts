/**
 * Event alerts — node only, runs on the same 5-minute schedule as the sweep (CONTRACT §10 "S5").
 *
 * The desk's own ledger is the event stream. This job reads `AuditLog` forward by `seq` from a durable
 * cursor and turns three kinds of row into a per-queue Slack line:
 *
 *   TICKET_ASSIGNED               someone picked a ticket up, or it was handed on / cleared
 *   TICKET_QUEUE_CHANGED          a queue hand-off (the CS -> Ops path Decision #67 opened)
 *   RESOLVED -> OPEN              a reopen: TICKET_REOPENED_BY_REQUESTER, or a staff
 *                                 TICKET_STATUS_CHANGED whose old/new are exactly RESOLVED/OPEN
 *
 * WHY A CURSOR AND NOT A TIME WINDOW: `seq` is gapless and assigned by the chain trigger, so "everything
 * since seq N" is exact. A `occurredAt > now - 5m` window silently drops a row written during a slow
 * transaction and silently repeats one when a run is late.
 *
 * DELIVERY IS AT-LEAST-ONCE, DELIBERATELY. The cursor advances only after every configured channel
 * accepted its message. A failed post therefore repeats a line on the next run; a dropped alert would be
 * invisible. Silence is not an all-clear, so the job prefers a duplicate to a gap.
 *
 * FIRST RUN DOES NOT BACKFILL. With no cursor row the job writes the cursor at the ledger's current head
 * and reports zero: switching the job on must not replay months of history into a channel.
 */
import type { Prisma } from "@prisma/client";
import type { AuditAction, QueueKey, TicketPriority } from "@/types/domain";
import { QUEUE_KEYS } from "@/types/domain";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import type { JobContext, JobOutcome } from "@/jobs/types";
import { appBaseUrl, isUsableWebhook, postSlack, ticketLinkMarkup } from "@/jobs/slack";
import type { SlackLine } from "@/jobs/slack";

/** `JobCursor.name` for this job. One row, updated in place; the JOB_RUN audit row is the evidence. */
export const EVENT_ALERTS_CURSOR = "event-alerts";

/** Ledger rows examined per run. At 5-minute cadence this is far above any realistic desk volume. */
export const EVENT_ALERTS_BATCH = 500;

/** The four actions that can produce a line. RESOLVED -> OPEN is filtered further in SQL. */
export const EVENT_ALERT_ACTIONS = [
  "TICKET_ASSIGNED",
  "TICKET_QUEUE_CHANGED",
  "TICKET_REOPENED_BY_REQUESTER",
  "TICKET_STATUS_CHANGED",
] as const satisfies readonly AuditAction[];

export type EventAlertKind = "assigned" | "unassigned" | "queue-changed" | "reopened";

export type LedgerEvent = {
  seq: bigint;
  action: AuditAction;
  oldValue: string | null;
  newValue: string | null;
  ticketNumber: number;
  priority: TicketPriority;
  /** The queue the ticket sits in now. */
  currentQueueKey: QueueKey;
};

export type QueueEvent = {
  seq: bigint;
  kind: EventAlertKind;
  ticketNumber: number;
  priority: TicketPriority;
  /** The queue whose channel is notified. */
  queueKey: QueueKey;
  /** Only for a hand-off: where it came from. */
  fromQueueKey: QueueKey | null;
};

/** `where` for one batch: the four actions, RESOLVED -> OPEN narrowed, ticket-linked rows only. */
export function eventAlertsWhere(afterSeq: bigint): Prisma.AuditLogWhereInput {
  return {
    seq: { gt: afterSeq },
    ticketId: { not: null },
    OR: [
      { action: "TICKET_ASSIGNED" },
      { action: "TICKET_QUEUE_CHANGED" },
      { action: "TICKET_REOPENED_BY_REQUESTER" },
      { action: "TICKET_STATUS_CHANGED", oldValue: "RESOLVED", newValue: "OPEN" },
    ],
  };
}

function isQueueKey(value: string | null | undefined): value is QueueKey {
  return value !== null && value !== undefined && (QUEUE_KEYS as readonly string[]).includes(value);
}

/**
 * One ledger row to one routable event.
 *
 * A queue hand-off is announced in the DESTINATION queue's channel (`newValue`), because the destination
 * is who now has to act on it; `fromQueueKey` names where it came from. Everything else is announced in
 * the ticket's current queue. A `TICKET_ASSIGNED` row whose `newValue` is null is an assignment CLEARED —
 * announced as "unassigned", since an unowned ticket in a queue is the thing that needs picking up.
 *
 * No identities. `TICKET_ASSIGNED` carries the assignee's user id in `newValue` and their address in
 * `metadata.newEmail`; neither reaches a Slack line. The line says a ticket changed hands and links to it.
 */
export function toQueueEvent(event: LedgerEvent): QueueEvent | null {
  switch (event.action) {
    case "TICKET_ASSIGNED":
      return {
        seq: event.seq,
        kind: event.newValue === null || event.newValue === "" ? "unassigned" : "assigned",
        ticketNumber: event.ticketNumber,
        priority: event.priority,
        queueKey: event.currentQueueKey,
        fromQueueKey: null,
      };
    case "TICKET_QUEUE_CHANGED": {
      const destination = isQueueKey(event.newValue) ? event.newValue : event.currentQueueKey;
      return {
        seq: event.seq,
        kind: "queue-changed",
        ticketNumber: event.ticketNumber,
        priority: event.priority,
        queueKey: destination,
        fromQueueKey: isQueueKey(event.oldValue) ? event.oldValue : null,
      };
    }
    case "TICKET_REOPENED_BY_REQUESTER":
      return {
        seq: event.seq,
        kind: "reopened",
        ticketNumber: event.ticketNumber,
        priority: event.priority,
        queueKey: event.currentQueueKey,
        fromQueueKey: null,
      };
    case "TICKET_STATUS_CHANGED":
      // Only the RESOLVED -> OPEN narrowing reaches here; anything else is a status change the desk
      // makes dozens of times a day and does not page on.
      if (event.oldValue !== "RESOLVED" || event.newValue !== "OPEN") return null;
      return {
        seq: event.seq,
        kind: "reopened",
        ticketNumber: event.ticketNumber,
        priority: event.priority,
        queueKey: event.currentQueueKey,
        fromQueueKey: null,
      };
    default:
      return null;
  }
}

export const EVENT_KIND_MARKERS: Readonly<Record<EventAlertKind, string>> = {
  assigned: ":inbox_tray: assigned",
  unassigned: ":outbox_tray: unassigned",
  "queue-changed": ":twisted_rightwards_arrows: handed off",
  reopened: ":arrows_counterclockwise: reopened",
};

/** One event line. PII-light: number, queue, priority, what happened, deep link. Never an identity. */
export function eventAlertLine(event: QueueEvent, base: string | undefined): SlackLine {
  const what =
    event.kind === "queue-changed" && event.fromQueueKey !== null
      ? `${EVENT_KIND_MARKERS[event.kind]} from ${event.fromQueueKey}`
      : EVENT_KIND_MARKERS[event.kind];
  return {
    text: [what, ticketLinkMarkup(event.ticketNumber, base), event.queueKey, event.priority].join(" | "),
  };
}

/** Per-queue header. the build record section 2. */
export function eventDigestHeader(queueKey: QueueKey, count: number): SlackLine {
  return { text: `*WM help desk — ${queueKey}:* ${count} ${count === 1 ? "update" : "updates"}` };
}

/** Events grouped by the queue whose channel is notified, each group in ledger order. */
export function groupByQueue(events: readonly QueueEvent[]): Map<QueueKey, QueueEvent[]> {
  const grouped = new Map<QueueKey, QueueEvent[]>();
  for (const event of events) {
    const bucket = grouped.get(event.queueKey);
    if (bucket === undefined) {
      grouped.set(event.queueKey, [event]);
    } else {
      bucket.push(event);
    }
  }
  return grouped;
}

/**
 * `SLACK_QUEUE_WEBHOOKS` parsed into a queue -> webhook map. `env.ts` has already refused a value that is
 * not a JSON object; this drops any key that is not a QueueKey and any value that is not an https URL,
 * so a typo disables one channel rather than throwing at 3 a.m. and taking the sweep down with it.
 */
export function parseQueueWebhooks(raw: string | undefined): Readonly<Partial<Record<QueueKey, string>>> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Partial<Record<QueueKey, string>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isQueueKey(key)) continue;
    if (typeof value !== "string" || !isUsableWebhook(value)) continue;
    out[key] = value.trim();
  }
  return out;
}

/** The cursor row, or null when the job has never run. */
export async function readCursor(): Promise<bigint | null> {
  const row = await prisma.jobCursor.findUnique({ where: { name: EVENT_ALERTS_CURSOR }, select: { seq: true } });
  return row?.seq ?? null;
}

/** Upsert the cursor. A bookmark, not evidence — the run itself is recorded by JOB_RUN. */
export async function writeCursor(seq: bigint): Promise<void> {
  await prisma.jobCursor.upsert({
    where: { name: EVENT_ALERTS_CURSOR },
    create: { name: EVENT_ALERTS_CURSOR, seq },
    update: { seq },
  });
}

/** The ledger's current head, or 0 when the ledger is empty. */
export async function ledgerHead(): Promise<bigint> {
  const agg = await prisma.auditLog.aggregate({ _max: { seq: true } });
  return agg._max.seq ?? BigInt(0);
}

/** One batch of ticket-linked rows after `afterSeq`, oldest first, with the ticket facts a line needs. */
export async function readLedgerEvents(afterSeq: bigint): Promise<LedgerEvent[]> {
  const rows = await prisma.auditLog.findMany({
    where: eventAlertsWhere(afterSeq),
    orderBy: { seq: "asc" },
    take: EVENT_ALERTS_BATCH,
    select: {
      seq: true,
      action: true,
      oldValue: true,
      newValue: true,
      ticket: { select: { number: true, priority: true, queue: { select: { key: true } } } },
    },
  });
  const events: LedgerEvent[] = [];
  for (const row of rows) {
    // ticketId is non-null by the where clause, but the relation is still optional in the types.
    if (row.ticket === null) continue;
    events.push({
      seq: row.seq,
      action: row.action,
      oldValue: row.oldValue,
      newValue: row.newValue,
      ticketNumber: row.ticket.number,
      priority: row.ticket.priority,
      currentQueueKey: row.ticket.queue.key,
    });
  }
  return events;
}

/**
 * The job. Reads a batch, routes it, posts one message per configured queue channel, then advances the
 * cursor — and only then.
 */
export async function runEventAlerts(job: JobContext): Promise<JobOutcome> {
  const cursor = await readCursor();
  if (cursor === null) {
    const head = await ledgerHead();
    await writeCursor(head);
    job.log.info("cursor-initialised", { head: head.toString() });
    return {
      processed: 0,
      skipped: 0,
      posted: 0,
      metadata: { initialised: true, cursor: head.toString(), note: "first run does not backfill" },
    };
  }

  const ledgerEvents = await readLedgerEvents(cursor);
  if (ledgerEvents.length === 0) {
    job.log.info("no-events", { cursor: cursor.toString() });
    return { processed: 0, skipped: 0, posted: 0, metadata: { cursor: cursor.toString() } };
  }

  const lastSeq = ledgerEvents[ledgerEvents.length - 1].seq;
  const routable: QueueEvent[] = [];
  for (const event of ledgerEvents) {
    const routed = toQueueEvent(event);
    if (routed !== null) routable.push(routed);
  }

  const webhooks = parseQueueWebhooks(env.SLACK_QUEUE_WEBHOOKS);
  const grouped = groupByQueue(routable);
  const base = appBaseUrl();

  let posted = 0;
  let failed = 0;
  let unrouted = 0;
  for (const [queueKey, events] of grouped) {
    const webhook = webhooks[queueKey];
    const lines = [eventDigestHeader(queueKey, events.length), ...events.map((e) => eventAlertLine(e, base))];
    const result = await postSlack(webhook, lines);
    job.log.info("queue-digest", { queueKey, events: events.length, slack: result });
    if (result === "posted") posted += 1;
    if (result === "failed") failed += 1;
    if (result === "disabled") unrouted += events.length;
  }

  // At-least-once: hold the cursor where it is when a channel rejected us, so the next run retries.
  const advanced = failed === 0;
  if (advanced) {
    await writeCursor(lastSeq);
  } else {
    job.log.error("cursor-held", { cursor: cursor.toString(), failedChannels: failed });
  }

  return {
    processed: routable.length,
    skipped: ledgerEvents.length - routable.length + unrouted,
    posted,
    ok: failed === 0,
    metadata: {
      fromSeq: cursor.toString(),
      toSeq: lastSeq.toString(),
      scanned: ledgerEvents.length,
      queues: grouped.size,
      failedChannels: failed,
      unroutedEvents: unrouted,
      cursorAdvanced: advanced,
      batchFull: ledgerEvents.length === EVENT_ALERTS_BATCH,
    },
  };
}
