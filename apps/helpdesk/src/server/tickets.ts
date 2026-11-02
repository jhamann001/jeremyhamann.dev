/**
 * Ticket reads — node, layer L4.
 *
 * Every read that returns ticket CONTENT (`getTicketDetail`) takes an explicit `viewer` and `ctx`,
 * re-checks RBAC, records the denial when it fails (returning null so existence never leaks), and
 * `await`s `recordView` before returning content. List rows carry no record content and are not views.
 * The SLA filter is SQL (`slaStatusWhere`), never applied after pagination.
 */
import type { Prisma } from "@prisma/client";
import type {
  AssigneeOption,
  ClientContactChannel,
  FollowUpFilter,
  QueueKey,
  RequestContext,
  TicketDetailDTO,
  TicketListPage,
  TicketListQuery,
  TicketListRow,
  TicketPermissions,
  TicketStatus,
  UserRef,
  Viewer,
} from "@/types/domain";
import {
  ALLOWED_STATUS_TRANSITIONS,
  CLIENT_CONTACT_CHANNELS,
  CLIENT_CONTACT_NOTE_PREFIX,
  OKTA_GROUPS,
  QUEUE_KEYS,
} from "@/types/domain";
import { actorFromViewer, recordDenied, recordView } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { PrefetchNotAllowedError, ValidationError } from "@/lib/errors";
import { startOfFirmDay } from "@/lib/firm-time";
import { canComment, canMoveTicket, canReadQueue, canWriteQueue, readableQueues } from "@/lib/rbac";
import { computeSlaStatus } from "@/lib/sla";
import {
  loadSlaBands,
  slaBandFor,
  slaStatusWhere,
  warningMinutesFromBands,
  NOT_EXCLUDED_FROM_METRICS,
} from "@/server/sla-where";
import type { SlaBandsByPriority, WarningMinutesByPriority } from "@/server/sla-where";

export const USER_REF_SELECT: { id: true; name: true; email: true; image: true } = {
  id: true,
  name: true,
  email: true,
  image: true,
};

export const TICKET_INCLUDE: {
  queue: { select: { id: true; key: true; name: true } };
  assignee: { select: typeof USER_REF_SELECT };
  createdBy: { select: typeof USER_REF_SELECT };
  // Wave B foundation edit: the survivor of a merge, so a list row can print "merged into HD-1042"
  // without a second round trip per row. `number` and nothing else — a merged ticket's subject is its
  // own, and the link is what the reader needs.
  mergedInto: { select: { number: true } };
} = {
  queue: { select: { id: true, key: true, name: true } },
  assignee: { select: USER_REF_SELECT },
  createdBy: { select: USER_REF_SELECT },
  mergedInto: { select: { number: true } },
};

export type TicketWithRefs = Prisma.TicketGetPayload<{ include: typeof TICKET_INCLUDE }>;

export function toUserRef(u: { id: string; name: string | null; email: string; image: string | null }): UserRef {
  return { id: u.id, name: u.name, email: u.email, image: u.image };
}

/**
 * §b.9: CLOSED is read-plus-annotate for everyone — write, public reply and move are off, transitions
 * empty; `canInternalNote` is status-independent (compliance annotation of a closed record is legitimate).
 * RESOLVED behaves like an open status.
 */
export function computeTicketPermissions(
  viewer: Viewer,
  t: { queueKey: QueueKey; status: TicketStatus },
): TicketPermissions {
  const groups = viewer.groups;
  const write = canWriteQueue(groups, t.queueKey);
  // VOIDED is read-plus-annotate exactly like CLOSED, and for a stronger reason — the ticket
  // is asserted never to have happened, so nothing may be written to it afterwards. `canInternalNote`
  // stays status-independent (a reviewer annotating a voided record is legitimate, and is how a void
  // gets explained beyond its one recorded reason).
  const closed = t.status === "CLOSED" || t.status === "VOIDED";
  const canWrite = write && !closed;
  const movableTo = closed ? [] : QUEUE_KEYS.filter((to) => canMoveTicket(groups, t.queueKey, to));
  return {
    canWrite,
    canInternalNote: canComment(groups, t.queueKey, "INTERNAL"),
    canPublicReply: canComment(groups, t.queueKey, "PUBLIC") && !closed,
    canMove: movableTo.length > 0,
    movableTo,
    allowedStatuses: canWrite ? [...ALLOWED_STATUS_TRANSITIONS[t.status]] : [],
  };
}

/**
 * Every mutation except addInternalNote calls this right after its assertCan.
 *
 * a VOIDED ticket is refused here too, with its own message. Voiding asserts the ticket never
 * should have existed; editing it afterwards would be writing to a record the desk has disowned.
 * `voidTicket` itself does not call this — it is the transition INTO the state — and neither does
 * `addInternalNote`, for the same reason it is exempt for CLOSED.
 */
export function assertTicketNotClosed(t: { status: TicketStatus }): void {
  if (t.status === "VOIDED") throw new ValidationError("ticket was voided");
  if (t.status === "CLOSED") throw new ValidationError("ticket is closed");
}

function iso(d: Date): string {
  return d.toISOString();
}

function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

export function toTicketListRow(
  t: TicketWithRefs,
  now: Date = new Date(),
  bands?: SlaBandsByPriority,
): TicketListRow {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    queueKey: t.queue.key,
    assignee: t.assignee ? toUserRef(t.assignee) : null,
    requesterName: t.requesterName,
    // the flag fields ride on LIST rows so the dashboard renders badges and filter chips from
    // the same DTO the table already has (the build record — foundation edit, S6 preserves it).
    brand: t.brand,
    source: t.source,
    isComplaint: t.isComplaint,
    complaintFiledAt: isoOrNull(t.complaintFiledAt),
    escalationTarget: t.escalationTarget,
    followUpAt: isoOrNull(t.followUpAt),
    externalRef: t.externalRef,
    // the outcome and the merge pointer ride on LIST rows for the same reason the Wave A flags
    // do — the board renders the chips, the bulk bar decides what it may touch, and the CSV export
    // builds from one shape (the build record — foundation edit, B2/B7 preserve it).
    resolution: t.resolution,
    mergedIntoId: t.mergedIntoId,
    mergedIntoNumber: t.mergedInto?.number ?? null,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    firstResponseDueAt: iso(t.firstResponseDueAt),
    resolutionDueAt: iso(t.resolutionDueAt),
    firstRespondedAt: isoOrNull(t.firstRespondedAt),
    resolvedAt: isoOrNull(t.resolvedAt),
    piiRedacted: t.piiRedacted,
    piiRedactionCount: t.piiRedactionCount,
    version: t.version,
    // the LIVE warning band for this ticket's priority, so editing /admin/sla
    // re-colours open work on the next render. `bands` omitted → the historical 30 minutes, which
    // is what every test fixture and every caller that does not care still gets.
    sla: computeSlaStatus(t, now, slaBandFor(t.priority, bands)),
  };
}

export function toTicketDetail(
  t: TicketWithRefs,
  viewer: Viewer,
  now: Date = new Date(),
  bands?: SlaBandsByPriority,
): TicketDetailDTO {
  return {
    ...toTicketListRow(t, now, bands),
    description: t.description,
    clientReference: t.clientReference,
    requesterEmail: t.requesterEmail,
    requesterPhone: t.requesterPhone,
    householdId: t.householdId,
    requesterExternalId: t.requesterExternalId,
    linkedFromTicketId: t.linkedFromTicketId,
    externalId: t.externalId,
    queueId: t.queue.id,
    queueName: t.queue.name,
    createdBy: toUserRef(t.createdBy),
    slaFirstResponseMinutes: t.slaFirstResponseMinutes,
    slaResolutionMinutes: t.slaResolutionMinutes,
    closedAt: isoOrNull(t.closedAt),
    // Wave B (foundation edit): the void triple and the merge instant. All four are DB-CHECKed to
    // travel together, so a reader never sees half a void.
    voidedAt: isoOrNull(t.voidedAt),
    voidReason: t.voidReason,
    mergedAt: isoOrNull(t.mergedAt),
    permissions: computeTicketPermissions(viewer, { queueKey: t.queue.key, status: t.status }),
  };
}

/**
 * When was this ticket's requester address last RE-POINTED at a different address, if ever?
 *
 * Reads the ledger, because that is the only place the previous address survives: `Ticket` carries one
 * `requesterEmail` and an overwrite leaves no trace on the row. The row this matches is the one
 * `changeRequesterEmail` writes — `fieldChanged: "requesterEmail"` with a non-null `oldValue`, which is
 * what distinguishes a REDIRECT from `updateTicketFields` ADOPTING a first address on a phone-only
 * ticket (`oldValue` null) or clearing one.
 *
 * Not a view: it returns a timestamp, no description and no comment body, so
 * it writes no `TICKET_VIEWED` row. The caller's own read of the ticket already audited the view.
 */
export async function requesterEmailChangedAt(ticketId: string): Promise<Date | null> {
  const row = await prisma.auditLog.findFirst({
    where: {
      ticketId,
      // `TICKET_REQUESTER_EMAIL_CHANGED` landed as its own enum value.
      // BOTH are read, deliberately: rows written before the change carry `TICKET_FIELD_CHANGED`, and
      // the `oldValue: { not: null }` predicate below is what distinguishes a REDIRECT from
      // `updateTicketFields` ADOPTING a first address (oldValue null) or clearing one — so the two
      // eras answer identically.
      action: { in: ["TICKET_FIELD_CHANGED", "TICKET_REQUESTER_EMAIL_CHANGED"] },
      fieldChanged: "requesterEmail",
      oldValue: { not: null },
    },
    orderBy: { seq: "desc" },
    select: { occurredAt: true },
  });
  return row?.occurredAt ?? null;
}

/** `HD-123`, `wm123`, `123` → 123; anything else → null. */
function ticketNumberFromSearch(search: string): number | null {
  const m = /^HD-?(\d{1,9})$/i.exec(search.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * `followUpAt` predicate. "due" is the working queue — everything whose follow-up date has
 * arrived; "overdue" is the subset the desk has already missed, measured from the start of the current
 * day on the FIRM clock (`startOfFirmDay`, src/lib/firm-time.ts). Every branch requires a non-null
 * `followUpAt`, so a ticket with no cadence never appears.
 *
 * The boundary used to be the process's own midnight (UTC on Cloud Run). The badge that puts the word
 * "overdue" on a card is derived by `followUpState` (src/components/tickets/flag-state.ts), which runs
 * in the viewer's browser as often as on the server, so the filter and the badge were measuring from
 * two different midnights: between Eastern and UTC midnight a card could read "Follow-up overdue" and
 * still be missing from the Overdue filter. Both sides now call `startOfFirmDay`.
 */
export function followUpWhere(filter: FollowUpFilter, now: Date): Prisma.TicketWhereInput {
  switch (filter) {
    case "any":
      return { followUpAt: { not: null } };
    case "due":
      return { followUpAt: { not: null, lte: now } };
    case "overdue":
      return { followUpAt: { not: null, lt: startOfFirmDay(now) } };
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

/**
 * The readable queues this query actually reads: `readableQueues(viewer)` narrowed by `query.queueKey`.
 * Empty means the viewer asked for a queue they cannot read — callers return an empty result rather
 * than widening. Exported so the CSV export bounds its rows by exactly the same set as the list.
 */
export function queuesForQuery(viewer: Viewer, query: TicketListQuery): QueueKey[] {
  const readable = readableQueues(viewer.groups);
  return query.queueKey === undefined ? readable : readable.filter((q) => q === query.queueKey);
}

/**
 * `warnings` is the LIVE per-priority warning band, and a caller that renders SLA chips
 * MUST pass the one it is about to render with. `slaStatusWhere` runs the amber band in SQL, before
 * pagination; `toTicketListRow` colours each chip from the band map the caller loaded. Omitting it here
 * silently pins the FILTER to the 30-minute default while the chips, the queue counters and the CSV
 * cells all follow `/admin/sla` — so the moment an operator moves a priority off 30, the "SLA: Warning"
 * filter returns a ticket whose own chip reads ON_TRACK, and a queue's warning badge links to a list
 * the ticket is missing from. Omitting it is still correct for a caller with no chips to agree with (a
 * pure test, a BREACHED/MET-only surface): those verdicts do not depend on the band.
 */
export function buildListWhere(
  viewer: Viewer,
  queues: QueueKey[],
  query: TicketListQuery,
  now: Date,
  warnings?: WarningMinutesByPriority,
): Prisma.TicketWhereInput {
  const and: Prisma.TicketWhereInput[] = [{ queue: { key: { in: queues } } }];

  if (query.status && query.status.length > 0) and.push({ status: { in: query.status } });
  if (query.priority && query.priority.length > 0) and.push({ priority: { in: query.priority } });

  if (query.assigneeId !== undefined) {
    if (query.assigneeId === "me") and.push({ assigneeId: viewer.id });
    else if (query.assigneeId === "unassigned") and.push({ assigneeId: null });
    else and.push({ assigneeId: query.assigneeId });
  }

  if (query.search !== undefined && query.search.trim().length > 0) {
    const number = ticketNumberFromSearch(query.search);
    if (number !== null) {
      and.push({ number });
    } else {
      const contains = { contains: query.search.trim(), mode: "insensitive" as const };
      // agents find prior work by CONTENT (a control number, "cost basis", a link), not by
      // subject. INTERNAL bodies are searchable by staff who can already read the queue — the queue
      // filter above is applied in the same WHERE, and the rows returned carry no body. The client
      // path never uses this query (it reads through client-view.ts only).
      and.push({
        OR: [
          { subject: contains },
          { requesterName: contains },
          { requesterEmail: contains },
          { description: contains },
          { clientReference: contains },
          { externalRef: contains },
          { comments: { some: { body: contains } } },
        ],
      });
    }
  }

  if (query.slaStatus && query.slaStatus.length > 0) {
    // `slaStatusWhere` carries the exclusion itself.
    and.push(slaStatusWhere(query.slaStatus, now, warnings));
  } else if (query.status === undefined || !query.status.includes("VOIDED")) {
    // CONTRACT §2: a ticket entered in error is nobody's number, so it is absent from an ordinary
    // list as well as from every counter — the exclusion is a property of the BOARD, not of the SLA
    // filter that happened to carry it. The one exception is a caller that NAMED `VOIDED` in its
    // status filter: that is the deliberate "show me what was entered in error" view, and refusing
    // it would make a status nobody can ever look at.
    and.push(NOT_EXCLUDED_FROM_METRICS);
  }

  // --- Wave A filters. Each is an independent AND term, so they compose with the search OR above
  // and with the queue restriction, which stays the outermost guarantee. ---
  if (query.category && query.category.length > 0) and.push({ category: { in: query.category } });
  if (query.brand && query.brand.length > 0) and.push({ brand: { in: query.brand } });
  if (query.source && query.source.length > 0) and.push({ source: { in: query.source } });
  if (query.isComplaint !== undefined) and.push({ isComplaint: query.isComplaint });
  if (query.followUp !== undefined) and.push(followUpWhere(query.followUp, now));
  // Inclusive from, exclusive to (src/types/domain.ts TicketListQuery). The parser already rejected a
  // value Date.parse could not read, so `new Date(...)` here is never Invalid Date.
  if (query.createdFrom !== undefined) and.push({ createdAt: { gte: new Date(query.createdFrom) } });
  if (query.createdTo !== undefined) and.push({ createdAt: { lt: new Date(query.createdTo) } });
  // Exact match, not ILIKE: this backs the header's "other tickets from this requester" link, where a
  // substring match would pull in a different client whose address contains this one.
  if (query.requesterEmail !== undefined) and.push({ requesterEmail: query.requesterEmail.toLowerCase() });
  // Same question, opaque key — what the header link actually uses when the ticket carries a person
  // pointer, so a named client's address never reaches an access log or browser history. Exact
  // match on the existing `requesterExternalId` index.
  if (query.requesterExternalId !== undefined) and.push({ requesterExternalId: query.requesterExternalId });

  return { AND: and };
}

/**
 * Queues = readableQueues(viewer) ∩ (query.queueKey ? [it] : all); none → empty page.
 * `priority` sorts by enum declaration order (URGENT first on asc). Secondary key `number asc` keeps
 * pagination stable.
 */
export async function listTickets(viewer: Viewer, query: TicketListQuery, now: Date = new Date()): Promise<TicketListPage> {
  const queues = queuesForQuery(viewer, query);
  if (queues.length === 0) return { rows: [], total: 0, page: query.page, pageSize: query.pageSize };

  // One read of the four-row policy table per page, so every badge on the board is coloured by the
  // band that is live right now rather than by the fixed 30 minutes. It is read BEFORE
  // the WHERE is built, and the same read feeds both: the `slaStatus` filter runs in SQL on exactly the
  // bands the chips are then rendered with, so "the rows the WARNING filter returned" and "the rows
  // whose chip is amber" are the same set for any policy an operator can save.
  const bands = await loadSlaBands();

  const where = buildListWhere(viewer, queues, query, now, warningMinutesFromBands(bands));
  const orderBy: Prisma.TicketOrderByWithRelationInput[] = [{ [query.sort]: query.dir }, { number: "asc" }];
  const [rows, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      include: TICKET_INCLUDE,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    rows: rows.map((t) => toTicketListRow(t, now, bands)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The content read. Throws PrefetchNotAllowedError for prefetch requests; null when the ticket is
 * missing OR the viewer cannot read its queue (the denial is recorded; existence never leaks); otherwise
 * `await`s the view row (errors propagate — no content is served if the ledger write fails).
 */
export async function getTicketDetail(
  viewer: Viewer,
  ticketId: string,
  ctx: RequestContext,
  opts: { view: "DETAIL" | "PREVIEW" },
): Promise<TicketDetailDTO | null> {
  if (ctx.isPrefetch) throw new PrefetchNotAllowedError();
  const t = await prisma.ticket.findUnique({ where: { id: ticketId }, include: TICKET_INCLUDE });
  if (!t) return null;
  const actor = actorFromViewer(viewer);
  if (!canReadQueue(viewer.groups, t.queue.key)) {
    await recordDenied(actor, ctx, `ticket:read ${opts.view}`, t.id);
    return null;
  }
  await recordView(actor, ctx, t.id, opts.view);
  return toTicketDetail(t, viewer, new Date(), await loadSlaBands());
}

/**
 * Active users whose stored groups grant WRITE on the queue, ordered by name.
 * INTENTIONALLY UNCHECKED (no viewer): staff directory data only, no record content, and every caller
 * invokes it only after its own read check succeeded.
 */
export async function listAssignableUsers(queueKey: QueueKey): Promise<AssigneeOption[]> {
  const writerGroups = OKTA_GROUPS.filter((g) => canWriteQueue([g], queueKey));
  const users = await prisma.user.findMany({
    where: { isActive: true, groups: { hasSome: [...writerGroups] } },
    select: { ...USER_REF_SELECT, groups: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });
  return users.map((u) => ({ ...toUserRef(u), groups: [...u.groups] }));
}

/**
 * Resolve a WM number to a ticket id.
 *
 * `queues` scopes the lookup to the queues the caller may READ. It is OPTIONAL only for source
 * compatibility with the contract's one-argument signature; every session-facing caller passes
 * `readableQueues(viewer.groups)`, because the answer "this number exists" is itself a fact about
 * the desk. Without the scope an authenticated reader of one queue could walk `1..N` and learn
 * exactly which numbers exist in the queues they cannot read (and their internal ids), which is the
 * existence leak `getTicketDetail` is careful to avoid. An EMPTY array therefore resolves nothing —
 * it means "this viewer reads no queue", not "no filter".
 */
export async function getTicketIdByNumber(
  number: number,
  queues?: readonly QueueKey[],
): Promise<string | null> {
  if (!Number.isSafeInteger(number) || number < 1) return null;
  if (queues !== undefined && queues.length === 0) return null;
  const t = await prisma.ticket.findFirst({
    where: { number, ...(queues === undefined ? {} : { queue: { key: { in: [...queues] } } }) },
    select: { id: true },
  });
  return t?.id ?? null;
}

// ---------------------------------------------------------------------------
// the WM deep link (S6 route, consumed by S5's Slack lines and the CSV export)
// ---------------------------------------------------------------------------

/**
 * The stable, human-quotable link to a ticket: `/tickets/wm/<number>`. It exists because the ticket's
 * cuid is meaningless to a person and to every system that already speaks in WM numbers (Slack, an
 * Apex ticket, a CRM task). The route resolves the number and 302s to `/tickets/<id>`.
 * Relative on purpose: the absolute origin differs per environment and belongs to whatever renders it.
 */
export function wmTicketPath(number: number): string {
  return `/tickets/wm/${number}`;
}

// ---------------------------------------------------------------------------
// the INTERNAL note recordClientContact writes
// ---------------------------------------------------------------------------

/**
 * `CLIENT CONTACT [PHONE]` followed by a blank line and the agent's note. The prefix is CODE, never
 * user input, and is applied AFTER sanitizePII (§f: like a disclaimer, it is not a redaction target).
 * Machine-readable so the timeline can render the contact as an event instead of a wall of text.
 */
export const CLIENT_CONTACT_NOTE_PATTERN: RegExp = /^CLIENT CONTACT \[([A-Z_]+)\]\n\n([\s\S]*)$/;

/**
 * The tie between the literal above and the shared constant, and the reason the pattern can BE a
 * literal: `CLIENT_CONTACT_NOTE_PREFIX` is declared `as const`, so its type is the string itself and
 * this assignment stops compiling the moment the prefix changes. The pattern was built with
 * `new RegExp` from an interpolated template before — security scanner reports that as CWE-185 ("Non-literal
 * regular expression"), and a helper that assembles the same literal parts at module load is still
 * non-literal to the scanner. A compile-time check buys the same protection the interpolation did.
 */
const PATTERN_PREFIX: "CLIENT CONTACT" = CLIENT_CONTACT_NOTE_PREFIX;

export function formatClientContactNote(channel: ClientContactChannel, note: string): string {
  return `${PATTERN_PREFIX} [${channel}]\n\n${note}`;
}

/** The inverse of `formatClientContactNote`; null when the body is an ordinary internal note. */
export function parseClientContactNote(body: string): { channel: ClientContactChannel; note: string } | null {
  const m = CLIENT_CONTACT_NOTE_PATTERN.exec(body);
  if (!m) return null;
  const channel = m[1];
  if (!(CLIENT_CONTACT_CHANNELS as readonly string[]).includes(channel)) return null;
  return { channel: channel as ClientContactChannel, note: m[2] };
}

// ---------------------------------------------------------------------------
// requester history (S6 read, S7 renders)
// ---------------------------------------------------------------------------

/**
 * How the panel identifies "the same person" and "the same household". Every field is optional: a
 * phone-only ticket has no email, an un-linked ticket has no advisor platform pointers, and the query simply
 * returns less rather than widening to everyone.
 */
export type RequesterKey = {
  email?: string | null;
  requesterExternalId?: string | null;
  householdId?: string | null;
};

const REQUESTER_HISTORY_DEFAULT_LIMIT = 10;
const REQUESTER_HISTORY_MAX_LIMIT = 50;

/**
 * Other tickets from this requester, and other tickets in this household.
 *
 * LIST ROWS ONLY, therefore NO audit row (docs/ARCHITECTURE.md §e "What counts as a view", restated in
 * the build record rule 3): the rows carry no description, no comment body and no requester
 * email — exactly what the dashboard table already shows without being a view.
 *
 * Queue scoping is the same as every other list read: rows are limited to `readableQueues(viewer)`, so
 * the panel can never reveal that a ticket exists in a queue the viewer cannot read. `household`
 * excludes anything already returned in `requester`, so the panel never shows one ticket twice.
 */
export async function listTicketsByRequester(
  viewer: Viewer,
  key: RequesterKey,
  excludeTicketId: string,
  limit: number = REQUESTER_HISTORY_DEFAULT_LIMIT,
): Promise<{ requester: TicketListRow[]; household: TicketListRow[] }> {
  const empty = { requester: [], household: [] };
  const queues = readableQueues(viewer.groups);
  if (queues.length === 0) return empty;

  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, REQUESTER_HISTORY_MAX_LIMIT) : REQUESTER_HISTORY_DEFAULT_LIMIT;
  const now = new Date();
  const scope: Prisma.TicketWhereInput = { queue: { key: { in: queues } }, id: { not: excludeTicketId } };
  const order: Prisma.TicketOrderByWithRelationInput[] = [{ updatedAt: "desc" }, { number: "desc" }];

  const identity: Prisma.TicketWhereInput[] = [];
  const email = typeof key.email === "string" ? key.email.trim().toLowerCase() : "";
  if (email.length > 0) identity.push({ requesterEmail: email });
  const externalId = typeof key.requesterExternalId === "string" ? key.requesterExternalId.trim() : "";
  if (externalId.length > 0) identity.push({ requesterExternalId: externalId });

  const requesterRows =
    identity.length === 0
      ? []
      : await prisma.ticket.findMany({
          where: { AND: [scope, { OR: identity }] },
          include: TICKET_INCLUDE,
          orderBy: order,
          take,
        });

  const householdId = typeof key.householdId === "string" ? key.householdId.trim() : "";
  const seen = new Set<string>(requesterRows.map((t) => t.id));
  const householdRows =
    householdId.length === 0
      ? []
      : await prisma.ticket.findMany({
          where: { AND: [scope, { householdId }, { id: { notIn: [...seen] } }] },
          include: TICKET_INCLUDE,
          orderBy: order,
          take,
        });

  const bands = await loadSlaBands();
  return {
    requester: requesterRows.map((t) => toTicketListRow(t, now, bands)),
    household: householdRows.map((t) => toTicketListRow(t, now, bands)),
  };
}
