/**
 * Audit-log reads — node only, layer L4.
 *
 * `queryAuditLog` is itself audited (AUDIT_LOG_VIEWED, written before the page is returned).
 * Read-denial rule: every RBAC failure records AUTHZ_DENIED before throwing ForbiddenError.
 */
import type { Prisma } from "@prisma/client";
import { TIMELINE_AUDIT_ACTIONS } from "@/types/domain";
import type { ActivityItem, AuditPage, AuditQuery, AuditRow, RequestContext, Viewer } from "@/types/domain";
import { actorFromViewer, recordDenied, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { canReadQueue, canViewAudit, isDualRole } from "@/lib/rbac";

export const AUDIT_ROW_INCLUDE: { ticket: { select: { number: true } }; actor: { select: { name: true } } } = {
  ticket: { select: { number: true } },
  actor: { select: { name: true } },
};

export type AuditLogWithRefs = Prisma.AuditLogGetPayload<{ include: typeof AUDIT_ROW_INCLUDE }>;

const DECIMAL_SEQ = /^\d{1,19}$/;

/** seq → decimal string; dualRole from the stored actorGroups snapshot; dates ISO. */
export function toAuditRow(a: AuditLogWithRefs): AuditRow {
  return {
    id: a.id,
    seq: a.seq.toString(),
    occurredAt: a.occurredAt.toISOString(),
    actorId: a.actorId,
    actorEmail: a.actorEmail,
    actorGroups: [...a.actorGroups],
    dualRole: isDualRole(a.actorGroups),
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    ticketId: a.ticketId,
    ticketNumber: a.ticket?.number ?? null,
    fieldChanged: a.fieldChanged,
    oldValue: a.oldValue,
    newValue: a.newValue,
    ipAddress: a.ipAddress,
    userAgent: a.userAgent,
    requestId: a.requestId,
    metadata: a.metadata,
    prevHash: a.prevHash,
    hash: a.hash,
  };
}

function parseIsoBound(v: string | undefined): Date | undefined {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * from/to on occurredAt; actorEmail ILIKE; action in; entityType; ticketNumber → ticket.number; cursor → seq
 * lt. Optional `toSeq` adds an inclusive upper `seq <= toSeq` bound so the CSV export is a
 * snapshot as-of one seq: the export's own AUDIT_LOG_EXPORTED row (written before streaming, seq > toSeq) is
 * excluded from both the count and the stream, so the recorded total equals the file's row count.
 */
export function auditWhere(q: AuditQuery, toSeq?: bigint): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};

  const from = parseIsoBound(q.from);
  const to = parseIsoBound(q.to);
  if (from || to) {
    where.occurredAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (q.actorEmail !== undefined && q.actorEmail.trim() !== "") {
    where.actorEmail = { contains: q.actorEmail.trim(), mode: "insensitive" };
  }
  if (q.action !== undefined && q.action.length > 0) {
    where.action = { in: [...q.action] };
  }
  if (q.entityType !== undefined) {
    where.entityType = q.entityType;
  }
  if (q.ticketNumber !== undefined && Number.isInteger(q.ticketNumber)) {
    where.ticket = { number: q.ticketNumber };
  }
  const seq: Prisma.BigIntFilter = {};
  if (q.cursor !== undefined && DECIMAL_SEQ.test(q.cursor)) seq.lt = BigInt(q.cursor);
  if (toSeq !== undefined) seq.lte = toSeq;
  if (seq.lt !== undefined || seq.lte !== undefined) where.seq = seq;
  return where;
}

/**
 * Compliance-only. Pages by seq desc (`take: limit + 1` to detect the next page). Writes AUDIT_LOG_VIEWED
 * with the filters before returning. `total` counts every row matching the filters WITHOUT the cursor, so the
 * figure stays constant while the user pages with "Load more".
 * CONTRACT-GAP: the contract does not say whether `total` honours `cursor`; the cursor-free reading is used
 * because a shrinking total during pagination would read as rows disappearing from the ledger.
 */
export async function queryAuditLog(viewer: Viewer, q: AuditQuery, ctx: RequestContext): Promise<AuditPage> {
  const actor = actorFromViewer(viewer);
  if (!canViewAudit(viewer.groups)) {
    await recordDenied(actor, ctx, "audit:view");
    throw new ForbiddenError("Forbidden: audit:view");
  }

  const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 100;
  const where = auditWhere(q);
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: AUDIT_ROW_INCLUDE,
      orderBy: { seq: "desc" },
      take: limit + 1,
    }),
    prisma.auditLog.count({ where: auditWhere({ ...q, cursor: undefined }) }),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].seq.toString() : null;

  await writeAudit(prisma, actor, ctx, {
    action: "AUDIT_LOG_VIEWED",
    entityType: "AUDIT_LOG",
    metadata: { filters: filtersForMetadata(q) },
  });

  return { rows: pageRows.map(toAuditRow), nextCursor, total };
}

/** JSON-clean copy of the query for the metadata column (drops undefined keys; never carries record content). */
function filtersForMetadata(q: AuditQuery): Prisma.InputJsonObject {
  const out: Record<string, Prisma.InputJsonValue> = {};
  if (q.from !== undefined) out.from = q.from;
  if (q.to !== undefined) out.to = q.to;
  if (q.actorEmail !== undefined) out.actorEmail = q.actorEmail;
  if (q.action !== undefined) out.action = [...q.action];
  if (q.entityType !== undefined) out.entityType = q.entityType;
  if (q.ticketNumber !== undefined) out.ticketNumber = q.ticketNumber;
  if (q.cursor !== undefined) out.cursor = q.cursor;
  out.limit = q.limit;
  return out;
}

/**
 * Ticket-page activity feed: rows in TIMELINE_AUDIT_ACTIONS for one ticket, seq ascending.
 * Ticket missing → []. Unreadable queue → AUTHZ_DENIED("ticket:read activity") then ForbiddenError.
 */
export async function listTicketActivity(viewer: Viewer, ticketId: string, ctx: RequestContext): Promise<ActivityItem[]> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, queue: { select: { key: true } } },
  });
  if (!ticket) return [];

  if (!canReadQueue(viewer.groups, ticket.queue.key)) {
    await recordDenied(actorFromViewer(viewer), ctx, "ticket:read activity", ticketId);
    throw new ForbiddenError("Forbidden: ticket:read activity", ticketId);
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      ticketId,
      action: { in: [...TIMELINE_AUDIT_ACTIONS] },
      // `createUploadIntent` (staff upload) and `persistAttachmentParts` (inbound email part)
      // both write an ATTACHMENT_ADDED row at the RESERVATION — null → PENDING, metadata
      // `{stage: "intent"}` — because the Attachment row they create can never be deleted and so needs
      // a ledger entry. That row belongs in the audit log, not on the reader's timeline: an upload that
      // completed would otherwise draw two identical "attachment added" lines seconds apart, and one
      // that was abandoned would draw a line for a file nobody can see. The READY row is the attachment.
      NOT: { action: "ATTACHMENT_ADDED", newValue: "PENDING" },
    },
    select: {
      id: true,
      seq: true,
      occurredAt: true,
      action: true,
      actorEmail: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      actor: { select: { name: true } },
    },
    orderBy: { seq: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    seq: r.seq.toString(),
    occurredAt: r.occurredAt.toISOString(),
    action: r.action,
    actorEmail: r.actorEmail,
    actorName: r.actor?.name ?? null,
    fieldChanged: r.fieldChanged,
    oldValue: r.oldValue,
    newValue: r.newValue,
  }));
}
