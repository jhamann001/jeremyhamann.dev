/**
 * CSV export of ticket ROWS — node only, layer L4, a plain module (not a server-action file)
 *. The route (`/api/tickets/export`)
 * authorizes, counts, writes `TICKET_LIST_EXPORTED` and only then streams; this module supplies the
 * count, the row iterator, the `full`-scope extras loader and an RFC 4180 writer.
 *
 * Three things make this safe to hand to a person:
 *  - Rows are bounded by `queuesForQuery`, the same readable-queue narrowing `listTickets` uses, so an
 *    export can never contain a queue the viewer cannot read.
 *  - Cells go through `csvCell` (shared with the audit export): a leading `=`, `+`, `-`, `@`, TAB or CR
 *    is neutralized so a spreadsheet never evaluates a client's words as a formula.
 *  - The `standard` scope is built ENTIRELY from `TicketListRow`, which by construction carries no
 *    record content (no description, no comment body, no requester email). Only `full` — gated on the
 *    compliance capability in the route — adds the description and the comment bodies.
 *
 * Paging: the iterator is a keyset walk on `number` — the ticket's immutable, unique, monotonic
 * reference — not OFFSET and NOT `(updatedAt, id)`. That distinction is the whole point: a keyset walk
 * only guarantees "no skip, no repeat" over a sort key the rows cannot change underneath it, and
 * `updatedAt` moves every time an agent comments on, assigns or transitions a ticket. A walk ordered on
 * it would emit a ticket a second time the moment a busy desk touched a row the walk had already
 * passed, and the file would then carry more rows than the count on the `TICKET_LIST_EXPORTED` ledger
 * entry. `number` cannot move, so the guarantee is real. (The `[updatedAt, id]` index still exists and
 * is still right for `/api/export/tickets`, whose whole job is "what changed since": an incremental
 * mirror WANTS to see a re-touched row again.)
 *
 * `query.page` / `query.pageSize` / `query.sort` / `query.dir` are ignored: an export is the whole
 * matching set in a stable order, and `exportFilters` strips them from the metadata recorded on the
 * audit row so the ledger never implies a page was applied.
 */
import type { Prisma } from "@prisma/client";
import type { TicketExportScope, TicketListQuery, TicketListRow, Viewer } from "@/types/domain";
import { prisma } from "@/lib/db";
import { csvCell } from "@/server/audit-export";
import { buildListWhere, queuesForQuery, TICKET_INCLUDE, toTicketListRow, wmTicketPath } from "@/server/tickets";
import { loadSlaBands, warningMinutesFromBands } from "@/server/sla-where";
import type { WarningMinutesByPriority } from "@/server/sla-where";

const CRLF = "\r\n";
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 2_000;

/**
 * One row per ticket. The names are the stored field names, not prose, so a downstream sheet or
 * Warehouse load can map them without a legend.
 */
const BASE_COLUMNS = [
  "number",
  "link",
  "subject",
  "status",
  "priority",
  "category",
  "queueKey",
  "brand",
  "source",
  "requesterName",
  "assigneeName",
  "assigneeEmail",
  "isComplaint",
  "complaintFiledAt",
  "escalationTarget",
  "followUpAt",
  "externalRef",
  "createdAt",
  "updatedAt",
  "firstResponseDueAt",
  "firstRespondedAt",
  "resolutionDueAt",
  "resolvedAt",
  "slaPhase",
  "slaStatus",
  "firstResponseMet",
  "resolutionMet",
  "piiRedacted",
  "piiRedactionCount",
] as const;

/** Only the `full` scope carries record content, and only compliance may ask for it. */
const FULL_ONLY_COLUMNS = ["description", "comments"] as const;

export const TICKET_CSV_COLUMNS: readonly string[] = BASE_COLUMNS;
export const TICKET_CSV_COLUMNS_FULL: readonly string[] = [...BASE_COLUMNS, ...FULL_ONLY_COLUMNS];

export function ticketCsvColumns(scope: TicketExportScope): readonly string[] {
  return scope === "full" ? TICKET_CSV_COLUMNS_FULL : TICKET_CSV_COLUMNS;
}

/** The `full`-scope additions for one ticket. Absent for `standard`. */
export type TicketExportExtra = { description?: string; comments?: string };
export type TicketExportExtras = ReadonlyMap<string, TicketExportExtra>;

function bool(v: boolean | null): string {
  return v === null ? "" : v ? "true" : "false";
}

/** One RFC 4180 line (no terminator) in `ticketCsvColumns(scope)` order. */
export function ticketRowToCsvLine(row: TicketListRow, scope: TicketExportScope, extra?: TicketExportExtra): string {
  const cells: string[] = [
    csvCell(row.number),
    csvCell(wmTicketPath(row.number)),
    csvCell(row.subject),
    csvCell(row.status),
    csvCell(row.priority),
    csvCell(row.category),
    csvCell(row.queueKey),
    csvCell(row.brand),
    csvCell(row.source),
    csvCell(row.requesterName),
    csvCell(row.assignee?.name ?? null),
    csvCell(row.assignee?.email ?? null),
    csvCell(bool(row.isComplaint)),
    csvCell(row.complaintFiledAt),
    csvCell(row.escalationTarget),
    csvCell(row.followUpAt),
    csvCell(row.externalRef),
    csvCell(row.createdAt),
    csvCell(row.updatedAt),
    csvCell(row.firstResponseDueAt),
    csvCell(row.firstRespondedAt),
    csvCell(row.resolutionDueAt),
    csvCell(row.resolvedAt),
    csvCell(row.sla.phase),
    csvCell(row.sla.status),
    csvCell(bool(row.sla.firstResponseMet)),
    csvCell(bool(row.sla.resolutionMet)),
    csvCell(bool(row.piiRedacted)),
    csvCell(row.piiRedactionCount),
  ];
  if (scope === "full") {
    cells.push(csvCell(extra?.description ?? null), csvCell(extra?.comments ?? null));
  }
  return cells.join(",");
}

/** CRLF line endings; header (column order) when `includeHeader`; "" for an empty page with no header. */
export function ticketRowsToCsv(
  rows: readonly TicketListRow[],
  includeHeader: boolean,
  scope: TicketExportScope,
  extras?: TicketExportExtras,
): string {
  const lines: string[] = [];
  if (includeHeader) lines.push(ticketCsvColumns(scope).map((c) => csvCell(c)).join(","));
  for (const row of rows) lines.push(ticketRowToCsvLine(row, scope, extras?.get(row.id)));
  return lines.length === 0 ? "" : `${lines.join(CRLF)}${CRLF}`;
}

/**
 * The part of the query that actually selects rows — what belongs on the `TICKET_LIST_EXPORTED` row.
 * Paging and ordering are dropped: they change nothing about which tickets the file contains, and
 * recording them would suggest to a later reader that the export was a page.
 */
const NON_SELECTING_QUERY_KEYS = ["sort", "dir", "page", "pageSize"] as const;

export type TicketExportFilters = Omit<TicketListQuery, (typeof NON_SELECTING_QUERY_KEYS)[number]>;

export function exportFilters(query: TicketListQuery): TicketExportFilters {
  const filters: Partial<TicketListQuery> = { ...query };
  for (const key of NON_SELECTING_QUERY_KEYS) delete filters[key];
  return filters as TicketExportFilters;
}

/**
 * The WHERE both the count and the walk use — identical by construction, because the recorded total and
 * the delivered file have to describe the same set of tickets.
 *
 * `createdAt <= now` is the second half of that promise. The count and the walk are separate statements
 * (an interactive transaction long enough to stream several thousand rows is not available to us), so
 * without an upper bound a ticket opened AFTER the count would be picked up by the walk and the file
 * would carry a row the ledger never counted. `now` is the one the route took before it wrote the audit
 * row, so the bound is the same instant for both reads and for every SLA verdict in the file.
 */
function whereFor(
  viewer: Viewer,
  query: TicketListQuery,
  now: Date,
  warnings: WarningMinutesByPriority,
): Prisma.TicketWhereInput | null {
  const queues = queuesForQuery(viewer, query);
  if (queues.length === 0) return null;
  return { AND: [buildListWhere(viewer, queues, query, now, warnings), { createdAt: { lte: now } }] };
}

/**
 * How many rows the file will carry. Read BEFORE the audit row is written, with the same `now` the
 * stream uses, so the recorded total and the file agree (the audit export makes the same promise).
 *
 * "Agree" is exact for the two ways the set could otherwise drift — a row inserted mid-export (excluded
 * by the `createdAt <= now` bound in `whereFor`) and a row re-emitted mid-export (impossible on an
 * immutable sort key). It is NOT a snapshot: a ticket whose fields change mid-export such that it stops
 * matching the filter leaves the walk and the file then carries FEWER rows than were counted. That is
 * why the route also records the number of rows it actually emitted once the stream closes — the ledger
 * states both, and a reader never has to guess which number the file honoured.
 */
export async function countExportRows(viewer: Viewer, query: TicketListQuery, now: Date = new Date()): Promise<number> {
  // The live warning bands, for the same reason the walk reads them: an `slaStatus=WARNING` export
  // whose COUNT used the 30-minute default while its CELLS used `/admin/sla` would record a total the
  // file cannot honour.
  const where = whereFor(viewer, query, now, warningMinutesFromBands(await loadSlaBands()));
  if (where === null) return 0;
  return prisma.ticket.count({ where });
}

/**
 * Pages of matching rows, `number asc`, one page per yield. Keyset — not OFFSET — over a key no
 * concurrent write can move, so a ticket commented on, reassigned or transitioned while the file is
 * streaming can neither be skipped nor emitted twice. (`number` is `Int @unique @default(autoincrement())`:
 * unique, so the cursor needs no tiebreaker, and never updated, so a row cannot jump the cursor.)
 */
export async function* iterateExportRows(
  viewer: Viewer,
  query: TicketListQuery,
  pageSize: number = DEFAULT_PAGE_SIZE,
  now: Date = new Date(),
): AsyncGenerator<TicketListRow[]> {
  // Read ONCE, before the WHERE and before the cursor loop, and reuse for every page: an export is one
  // answer to one question, and a mid-stream policy edit must not colour the second half of a file
  // differently from the first. The same read also builds the `slaStatus` predicate, so
  // a WARNING export SELECTS on exactly the bands its cells are rendered with.
  const bands = await loadSlaBands();

  const where = whereFor(viewer, query, now, warningMinutesFromBands(bands));
  if (where === null) return;
  const take =
    Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  let cursor: number | null = null;
  for (;;) {
    const after: Prisma.TicketWhereInput =
      cursor === null ? where : { AND: [where, { number: { gt: cursor } }] };
    const rows = await prisma.ticket.findMany({
      where: after,
      include: TICKET_INCLUDE,
      orderBy: { number: "asc" },
      take,
    });
    if (rows.length === 0) return;
    yield rows.map((t) => toTicketListRow(t, now, bands));
    if (rows.length < take) return;
    cursor = rows[rows.length - 1].number;
  }
}

/** `[2026-09-19T14:03:00.000Z] INTERNAL casey@…: <body>` — one block per comment, oldest first. */
function formatComment(c: {
  createdAt: Date;
  visibility: string;
  authorKind: string;
  body: string;
  author: { email: string } | null;
}): string {
  // A REQUESTER or SYSTEM row has no author by design (the CHECK constraint enforces it), so the
  // author KIND stands in — never a fabricated name.
  const who = c.author?.email ?? c.authorKind.toLowerCase();
  return `[${c.createdAt.toISOString()}] ${c.visibility} ${who}: ${c.body}`;
}

/**
 * The `full`-scope additions for a page of tickets: the ORIGINAL description and every comment body,
 * INTERNAL ones included. This is record content — the caller has already been checked for the
 * compliance capability and has already written `TICKET_LIST_EXPORTED`. Never call it for `standard`.
 */
export async function loadExportExtras(ticketIds: readonly string[]): Promise<TicketExportExtras> {
  const out = new Map<string, TicketExportExtra>();
  if (ticketIds.length === 0) return out;

  const tickets = await prisma.ticket.findMany({
    where: { id: { in: [...ticketIds] } },
    select: {
      id: true,
      description: true,
      comments: {
        select: {
          createdAt: true,
          visibility: true,
          authorKind: true,
          body: true,
          author: { select: { email: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  for (const t of tickets) {
    out.set(t.id, {
      description: t.description,
      comments: t.comments.map((c) => formatComment(c)).join("\n\n"),
    });
  }
  return out;
}
