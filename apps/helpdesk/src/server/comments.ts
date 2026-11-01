/**
 * Comment reads for STAFF surfaces — node only, layer L4.
 *
 * Returns BOTH channels (INTERNAL and PUBLIC): this module is never on the client-facing path. The
 * client API reads comments exclusively through src/server/client-view.ts and the "ClientVisibleComment"
 * view. Read-denial rule: an RBAC failure records AUTHZ_DENIED before throwing ForbiddenError.
 */
import type { Prisma } from "@prisma/client";
import type { CommentDTO, RequestContext, Viewer } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { canReadQueue } from "@/lib/rbac";
import { USER_REF_SELECT, toUserRef } from "@/server/tickets";

/**
 * `delivery` and `attachments` are loaded with the comment so the ticket page renders the
 * delivery chip and the per-message attachment list from ONE query — no extra fetch, no
 * extra audit row (reading a delivery's status is not a read of client material; the body is the
 * comment the viewer already has).
 */
export const COMMENT_INCLUDE: {
  author: { select: typeof USER_REF_SELECT };
  macro: { select: { id: true; title: true } };
  delivery: {
    select: { id: true; status: true; attempts: true; toAddress: true; sentAt: true; lastError: true };
  };
  attachments: {
    where: { state: "READY" };
    select: {
      id: true;
      ticketId: true;
      commentId: true;
      kind: true;
      filename: true;
      mime: true;
      size: true;
      state: true;
      createdAt: true;
      uploader: { select: typeof USER_REF_SELECT };
    };
    orderBy: { createdAt: "asc" };
  };
  // --- Wave B foundation edit. Both are at most a handful of rows per
  // comment and both are needed by the SAME render the comment is in, so loading them here is one
  // round trip rather than one per comment from a client component. ---
  retraction: { select: { id: true; reason: true; createdAt: true; retractedBy: { select: typeof USER_REF_SELECT } } };
  reviewStamps: {
    select: { id: true; commentId: true; verdict: true; note: true; createdAt: true; reviewer: { select: typeof USER_REF_SELECT } };
    orderBy: { createdAt: "asc" };
  };
} = {
  author: { select: USER_REF_SELECT },
  macro: { select: { id: true, title: true } },
  delivery: {
    select: { id: true, status: true, attempts: true, toAddress: true, sentAt: true, lastError: true },
  },
  attachments: {
    where: { state: "READY" },
    select: {
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
    },
    orderBy: { createdAt: "asc" },
  },
  retraction: { select: { id: true, reason: true, createdAt: true, retractedBy: { select: USER_REF_SELECT } } },
  reviewStamps: {
    select: { id: true, commentId: true, verdict: true, note: true, createdAt: true, reviewer: { select: USER_REF_SELECT } },
    orderBy: { createdAt: "asc" },
  },
};

export type CommentWithRefs = Prisma.CommentGetPayload<{ include: typeof COMMENT_INCLUDE }>;

/**
 * What a STAFF surface prints for a non-STAFF comment. REQUESTER rows show the ticket's requester
 * name (loaded with the ticket, not with the comment — a comment carries no requester identity), so
 * the caller supplies it; SYSTEM rows show a fixed label.
 */
export const SYSTEM_AUTHOR_LABEL = "Help desk (system)" as const;
export const REQUESTER_AUTHOR_LABEL_FALLBACK = "Client" as const;

/**
 * Staff DTO: ISO dates, macro title when present, and the author kind plus its label.
 * `author` is non-null exactly when `authorKind === "STAFF"` — the DB CHECK guarantees the pairing,
 * and this mapper re-derives it rather than trusting the column, so a hand-written row cannot make a
 * REQUESTER message appear to come from a named staff member.
 */
export function toCommentDTO(c: CommentWithRefs, requesterName?: string): CommentDTO {
  const isStaff = c.authorKind === "STAFF" && c.author !== null;
  return {
    id: c.id,
    ticketId: c.ticketId,
    visibility: c.visibility,
    body: c.body,
    disclaimerKey: c.disclaimerKey,
    authorKind: c.authorKind,
    author: isStaff && c.author ? toUserRef(c.author) : null,
    authorLabel: isStaff
      ? ""
      : c.authorKind === "REQUESTER"
        ? (requesterName?.trim() || REQUESTER_AUTHOR_LABEL_FALLBACK)
        : SYSTEM_AUTHOR_LABEL,
    macroId: c.macroId,
    macroTitle: c.macro?.title ?? null,
    delivery: c.delivery
      ? {
          id: c.delivery.id,
          status: c.delivery.status,
          attempts: c.delivery.attempts,
          toAddress: c.delivery.toAddress,
          sentAt: c.delivery.sentAt?.toISOString() ?? null,
          lastError: c.delivery.lastError,
        }
      : null,
    attachments: c.attachments.map((a) => ({
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
    })),
    // Wave B. The retraction is an OVERLAY, never an edit: `body` above is still exactly what was
    // written and sent, because a staff surface has to be able to read what the desk actually put in
    // front of a client. It is the CLIENT path that never receives it (the view blanks it).
    retraction: c.retraction
      ? {
          id: c.retraction.id,
          reason: c.retraction.reason,
          retractedBy: toUserRef(c.retraction.retractedBy),
          createdAt: c.retraction.createdAt.toISOString(),
        }
      : null,
    reviews: c.reviewStamps.map((r) => ({
      id: r.id,
      commentId: r.commentId,
      verdict: r.verdict,
      note: r.note,
      reviewer: toUserRef(r.reviewer),
      createdAt: r.createdAt.toISOString(),
    })),
    piiRedacted: c.piiRedacted,
    piiRedactionCount: c.piiRedactionCount,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Both channels, createdAt ascending. `opts.limit` returns the LAST N comments (still ascending).
 * Ticket missing → []. Unreadable queue → AUTHZ_DENIED("ticket:read comments") is awaited, then
 * ForbiddenError. Callers only invoke this after a non-null getTicketDetail, so the denial path is a
 * defense-in-depth record, not the primary gate.
 */
export async function listComments(
  viewer: Viewer,
  ticketId: string,
  ctx: RequestContext,
  opts?: { limit?: number },
): Promise<CommentDTO[]> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    // requesterName is loaded here (not per comment) so a REQUESTER-authored row can be labelled.
    select: { id: true, requesterName: true, queue: { select: { key: true } } },
  });
  if (!ticket) return [];

  if (!canReadQueue(viewer.groups, ticket.queue.key)) {
    await recordDenied(actorFromViewer(viewer), ctx, "ticket:read comments", ticketId);
    throw new ForbiddenError("Forbidden: ticket:read comments", ticketId);
  }

  const limit = opts?.limit;
  if (limit !== undefined && Number.isInteger(limit) && limit > 0) {
    // Last N: fetch newest-first, then restore ascending order for the timeline.
    const newest = await prisma.comment.findMany({
      where: { ticketId },
      include: COMMENT_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return newest.reverse().map((c) => toCommentDTO(c, ticket.requesterName));
  }

  const rows = await prisma.comment.findMany({
    where: { ticketId },
    include: COMMENT_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((c) => toCommentDTO(c, ticket.requesterName));
}
