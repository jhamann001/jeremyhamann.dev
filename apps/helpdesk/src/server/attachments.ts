/**
 * Attachment reads for STAFF surfaces — node only, layer L4.
 *
 * v1 is INTERNAL-only, deliberately: there is no client-facing attachment DTO and nothing in this
 * module is reachable from `src/server/client-view.ts` or the export routes. The
 * client-API role is REVOKEd from the `Attachment` table in the migration and in runtime-roles.sql,
 * so the isolation does not rest on this file alone.
 *
 * Audit rule (CONTRACT §3 rule 3): LISTING attachment metadata is not a read of client material — a
 * filename, a size and an uploader carry no record content, exactly like a dashboard list row — so
 * `listAttachments` writes nothing. The DOWNLOAD is the read, and it is audited by the route through
 * `recordMaterialRead` BEFORE any URL is minted or any byte is served.
 *
 * Read-denial rule, as everywhere else: an RBAC failure on an existing row records `AUTHZ_DENIED`
 * and then reports "not found", so a denial never tells the caller the row exists.
 */
import type { AttachmentDTO, RequestContext, Viewer } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { canReadAttachment } from "@/lib/rbac";
import { USER_REF_SELECT, toUserRef } from "@/server/tickets";

/** Columns every attachment DTO needs. Never selects `objectKey` — that is storage detail, not UI data. */
export const ATTACHMENT_DTO_SELECT = {
  id: true,
  ticketId: true,
  commentId: true,
  kind: true,
  filename: true,
  mime: true,
  size: true,
  state: true,
  createdAt: true,
  uploader: { select: USER_REF_SELECT },
} as const;

type AttachmentRow = {
  id: string;
  ticketId: string;
  commentId: string | null;
  kind: AttachmentDTO["kind"];
  filename: string;
  mime: string;
  size: number;
  state: AttachmentDTO["state"];
  createdAt: Date;
  uploader: { id: string; name: string | null; email: string; image: string | null } | null;
};

export function toAttachmentDTO(a: AttachmentRow): AttachmentDTO {
  return {
    id: a.id,
    ticketId: a.ticketId,
    commentId: a.commentId,
    kind: a.kind,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    state: a.state,
    uploader: a.uploader ? toUserRef(a.uploader) : null,
    createdAt: a.createdAt.toISOString(),
  };
}

/**
 * READY attachments on a ticket, oldest first. PENDING rows are upload intents that never completed
 * and REMOVED rows are hidden by the soft remove, so neither belongs on the panel.
 *
 * Throws ForbiddenError (after an audited denial, via the caller's `runAction`) when the viewer
 * cannot read the ticket's queue. Writes NO audit row of its own — see the module note.
 */
export async function listAttachments(viewer: Viewer, ticketId: string): Promise<AttachmentDTO[]> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, queue: { select: { key: true } } },
  });
  if (!ticket) return [];
  if (!canReadAttachment(viewer.groups, ticket.queue.key)) {
    throw new ForbiddenError("Forbidden: attachment:read", ticket.id);
  }
  const rows = await prisma.attachment.findMany({
    where: { ticketId: ticket.id, state: "READY" },
    select: ATTACHMENT_DTO_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toAttachmentDTO);
}

/**
 * The download route's loader: RBAC and state check, then the row plus its object key.
 *
 * Returns null when the attachment is missing, not READY, or not readable — existence never leaks,
 * so all three answer identically. A denial on an existing row is recorded as `AUTHZ_DENIED` first
 * (the denial is the evidence; the 404 is only what the caller sees).
 *
 * It does NOT write `ATTACHMENT_VIEWED`: that row belongs to the route, immediately before the URL
 * is minted, so a viewer who is refused never produces a "viewed" row.
 */
export async function getAttachmentForDownload(
  viewer: Viewer,
  attachmentId: string,
  ctx: RequestContext,
): Promise<{ attachment: AttachmentDTO; objectKey: string } | null> {
  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { ...ATTACHMENT_DTO_SELECT, objectKey: true, ticket: { select: { queue: { select: { key: true } } } } },
  });
  if (!row) return null;
  if (!canReadAttachment(viewer.groups, row.ticket.queue.key)) {
    await recordDenied(actorFromViewer(viewer), ctx, "attachment:read", row.ticketId);
    return null;
  }
  // A PENDING intent has no complete object behind it and a REMOVED row has been taken off the
  // ticket; neither is downloadable, and neither reveals itself by answering differently.
  if (row.state !== "READY") return null;
  return { attachment: toAttachmentDTO(row), objectKey: row.objectKey };
}
