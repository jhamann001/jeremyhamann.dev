/**
 * Supervisory review of outbound replies — reads. Node only, layer L4.
 *
 * The write half is `src/server/reviews.actions.ts`. This is a plain module because a `"use server"`
 * file may export only `runAction`-wrapped async actions, and the review queue needs a reader
 * that takes a `Viewer` and returns rows, plus a CSV writer and the query parser — none of which are
 * server actions.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHY THIS SURFACE EXISTS
 *
 * Advisers Act 206(4)-7 requires written policies "reasonably designed to prevent violation" and an
 * annual review of their adequacy. For a desk whose whole output is written correspondence with
 * clients, the operative control is somebody other than the author reading what went out. The legacy help desk
 * has no such concept, which is one of the gaps this wave closes: without it, "we review client
 * correspondence" is a sentence in a manual with no artefact behind it.
 *
 * A `ReviewStamp` is that artefact. It is append-only, it names a reviewer, it carries a verdict and
 * an optional note, and it is unique per (comment, reviewer) so a second reviewer can add a second
 * opinion while one reviewer cannot quietly change their mind.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHAT THIS LIST IS, EVIDENTIALLY
 *
 * It renders ticket metadata plus a bounded, PII-sanitised EXCERPT of each reply — and is therefore
 * on the same side of §e's view line as `listHeldIntake`, whose snippet is sanitised at write time
 * for the same reason. It is capability-gated and unaudited.
 *
 * Reading the FULL reply is a different act and is recorded as one: `openReplyForReview`
 * (`reviews.actions.ts`) writes `TICKET_PREVIEWED` through `recordView` before it returns the body,
 * exactly like the ticket preview route. So the ledger can answer "did this reviewer read the reply
 * they stamped", which is the question an examiner actually asks.
 * ---------------------------------------------------------------------------------------------------
 */
import type { Prisma } from "@prisma/client";
import type {
  CommentDTO,
  MessageDeliveryStatus,
  QueueKey,
  ReviewStampDTO,
  ReviewVerdict,
  TicketCategory,
  Viewer,
} from "@/types/domain";
import { METRICS_EXCLUDED_STATUSES, QUEUE_KEYS, REVIEW_VERDICT_LABELS } from "@/types/domain";
import { prisma } from "@/lib/db";
import { firmInstant, firmWallClock, formatFirmDateTime } from "@/lib/firm-time";
import { readableQueues } from "@/lib/rbac";
import { COMMENT_INCLUDE, toCommentDTO } from "@/server/comments";
import { toUserRef, USER_REF_SELECT, wmTicketPath } from "@/server/tickets";
import { csvCell } from "@/server/audit-export";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Which side of the stamp a row is on. `ALL` is the reviewer's own audit of what they have done. */
export const REVIEW_STATES = ["UNREVIEWED", "REVIEWED", "ALL"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export type ReviewQuery = {
  /** Firm-local `YYYY-MM-DD`, inclusive. */
  from: string | null;
  /** Firm-local `YYYY-MM-DD`, inclusive — the whole day, not its first instant. */
  to: string | null;
  queueKey: QueueKey | null;
  state: ReviewState;
};

/**
 * How far back the queue looks when nobody says. Thirty days is the shortest window that survives a
 * reviewer being on holiday for three weeks, and short enough that the default page is a day's work
 * rather than the whole archive.
 */
export const REVIEW_DEFAULT_WINDOW_DAYS = 30;

/** How much of a reply the LIST shows. Beyond this the reviewer opens it, and that read is recorded. */
export const REVIEW_EXCERPT_CHARS = 600;

/** Hard ceiling on one page, and on one CSV. Matches the reporting cap so no surface is the outlier. */
export const REVIEW_MAX_ROWS = 500;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function firstOr<T extends string>(raw: string | string[] | undefined | null): T | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.length > 0 ? (v as T) : null;
}

/**
 * Parses the review queue's URL parameters. Invalid values fall back to the default rather than
 * throwing: a filter is a convenience, and a hand-edited query string should narrow nothing rather
 * than 500 a compliance page. Bare repeated keys only — never `key[]` (convention 12).
 */
export function parseReviewQuery(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): ReviewQuery {
  const get = (key: string): string | null =>
    params instanceof URLSearchParams ? firstOr(params.get(key)) : firstOr(params[key]);

  const rawFrom = get("from");
  const rawTo = get("to");
  const rawQueue = get("queue");
  const rawState = get("state");

  const queueKey = rawQueue !== null && (QUEUE_KEYS as readonly string[]).includes(rawQueue) ? (rawQueue as QueueKey) : null;
  const state =
    rawState !== null && (REVIEW_STATES as readonly string[]).includes(rawState) ? (rawState as ReviewState) : "UNREVIEWED";

  return {
    from: rawFrom !== null && DATE_ONLY.test(rawFrom) ? rawFrom : null,
    to: rawTo !== null && DATE_ONLY.test(rawTo) ? rawTo : null,
    queueKey,
    state,
  };
}

/** `?from=…&to=…&queue=…&state=…` with only the non-default parts, so a shared link is readable. */
export function reviewQueryToParams(q: ReviewQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.from !== null) p.set("from", q.from);
  if (q.to !== null) p.set("to", q.to);
  if (q.queueKey !== null) p.set("queue", q.queueKey);
  if (q.state !== "UNREVIEWED") p.set("state", q.state);
  return p;
}

/**
 * The instant window the query means, in FIRM time. `from` is midnight of that firm
 * day; `to` is midnight of the day AFTER it, so "to = today" includes everything sent today. When
 * `from` is absent the window opens `REVIEW_DEFAULT_WINDOW_DAYS` before now.
 */
export function reviewWindow(q: ReviewQuery, now: Date = new Date()): { gte: Date; lt: Date | null } {
  const gte =
    q.from === null
      ? new Date(now.getTime() - REVIEW_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      : dayStart(q.from);
  const lt = q.to === null ? null : dayAfter(q.to);
  return { gte, lt };
}

function dayStart(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return firmInstant(y, m, d, 0, 0, 0);
}

/** Midnight of the following firm day — computed by adding 24 h and re-reading the wall clock, so a
 * DST transition cannot make "the day after" land back inside the same day. */
function dayAfter(yyyymmdd: string): Date {
  const start = dayStart(yyyymmdd);
  const wc = firmWallClock(new Date(start.getTime() + 36 * 60 * 60 * 1000));
  if (wc === null) return new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return firmInstant(wc.year, wc.month, wc.day, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One PUBLIC reply as the review queue shows it: ticket context, an excerpt, and its stamps. */
export type ReplyReviewRow = {
  commentId: string;
  ticketId: string;
  ticketNumber: number;
  ticketPath: string;
  subject: string;
  queueKey: QueueKey;
  category: TicketCategory;
  /** Null for a SYSTEM reply — an auto-acknowledgement has no human author to supervise. */
  author: ReviewStampDTO["reviewer"] | null;
  authorLabel: string;
  sentAt: string;
  deliveryStatus: MessageDeliveryStatus | null;
  /** PII-sanitised at write time; truncated here for the list. */
  excerpt: string;
  excerptTruncated: boolean;
  attachmentCount: number;
  retracted: boolean;
  stamps: ReviewStampDTO[];
};

const ROW_SELECT = {
  id: true,
  ticketId: true,
  body: true,
  createdAt: true,
  authorKind: true,
  author: { select: USER_REF_SELECT },
  delivery: { select: { status: true } },
  retraction: { select: { id: true } },
  reviewStamps: {
    select: { id: true, commentId: true, verdict: true, note: true, createdAt: true, reviewer: { select: USER_REF_SELECT } },
    orderBy: { createdAt: "asc" },
  },
  _count: { select: { attachments: true } },
  ticket: {
    select: { id: true, number: true, subject: true, category: true, requesterName: true, queue: { select: { key: true } } },
  },
} as const;

/**
 * The WHERE every reader in this module shares.
 *
 * Four narrowings, each load-bearing:
 *  1. `visibility: "PUBLIC"` — an INTERNAL note is the desk talking to itself and there is nothing
 *     supervisory about it (and the reason `review:stamp` is not a ticket write).
 *  2. the viewer's readable queues — I5, even though every group that holds `review:stamp` today can
 *     read all three. A capability and a queue grant are different facts and the narrowing is free.
 *  3. `status notIn METRICS_EXCLUDED_STATUSES` — the review queue is a counting surface, and a VOIDED
 *     ticket is excluded from every counter. `voidTicket` refuses once a PUBLIC reply
 *     exists, so this should match nothing; it is here because "should" is not an invariant.
 *  4. the firm-local date window.
 */
function reviewWhere(viewer: Viewer, q: ReviewQuery, now: Date): Prisma.CommentWhereInput {
  const { gte, lt } = reviewWindow(q, now);
  const queues = q.queueKey === null ? readableQueues(viewer.groups) : [q.queueKey].filter((k) => readableQueues(viewer.groups).includes(k));

  const where: Prisma.CommentWhereInput = {
    visibility: "PUBLIC",
    createdAt: lt === null ? { gte } : { gte, lt },
    ticket: {
      status: { notIn: [...METRICS_EXCLUDED_STATUSES] },
      queue: { key: { in: queues } },
    },
  };

  if (q.state === "UNREVIEWED") where.reviewStamps = { none: {} };
  if (q.state === "REVIEWED") where.reviewStamps = { some: {} };
  return where;
}

function excerptOf(body: string): { excerpt: string; truncated: boolean } {
  if (body.length <= REVIEW_EXCERPT_CHARS) return { excerpt: body, truncated: false };
  return { excerpt: `${body.slice(0, REVIEW_EXCERPT_CHARS).trimEnd()}…`, truncated: true };
}

/**
 * The review queue, oldest first.
 *
 * OLDEST first on purpose, and it is the one ordering decision in this module worth arguing about:
 * every other list in this app is newest-first, because every other list answers "what is happening".
 * This one answers "what has been waiting", and the reply that has gone unsupervised longest is the
 * one the control exists for.
 */
export async function listRepliesForReview(
  viewer: Viewer,
  query: ReviewQuery,
  now: Date = new Date(),
): Promise<ReplyReviewRow[]> {
  const rows = await prisma.comment.findMany({
    where: reviewWhere(viewer, query, now),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: REVIEW_MAX_ROWS,
    select: ROW_SELECT,
  });

  return rows.map((c) => {
    const { excerpt, truncated } = excerptOf(c.body);
    const isStaff = c.authorKind === "STAFF" && c.author !== null;
    return {
      commentId: c.id,
      ticketId: c.ticketId,
      ticketNumber: c.ticket.number,
      ticketPath: wmTicketPath(c.ticket.number),
      subject: c.ticket.subject,
      queueKey: c.ticket.queue.key,
      category: c.ticket.category,
      author: isStaff && c.author ? toUserRef(c.author) : null,
      authorLabel: isStaff && c.author ? (c.author.name ?? c.author.email) : "Help desk (system)",
      sentAt: c.createdAt.toISOString(),
      deliveryStatus: c.delivery?.status ?? null,
      excerpt,
      excerptTruncated: truncated,
      attachmentCount: c._count.attachments,
      retracted: c.retraction !== null,
      stamps: c.reviewStamps.map((r) => ({
        id: r.id,
        commentId: r.commentId,
        verdict: r.verdict,
        note: r.note,
        reviewer: toUserRef(r.reviewer),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}

/** How many replies match, for the page header and the pre-stream export row. Capped-free: a count. */
export async function countRepliesForReview(
  viewer: Viewer,
  query: ReviewQuery,
  now: Date = new Date(),
): Promise<number> {
  return prisma.comment.count({ where: reviewWhere(viewer, query, now) });
}

/**
 * CONTRACT §10 B6 signature: the unstamped PUBLIC replies, as full `CommentDTO`s.
 *
 * Kept verbatim so another slice can import exactly what the contract promised. The page and the CSV
 * use `listRepliesForReview` instead, because a review row needs the ticket number, subject and queue
 * that a `CommentDTO` does not carry, and loading every comment's attachments and macro to render a
 * queue of two hundred rows is four joins nobody reads. Deviation recorded in the integration notes.
 */
export async function listUnreviewedReplies(
  viewer: Viewer,
  query: { from?: string; to?: string },
  now: Date = new Date(),
): Promise<CommentDTO[]> {
  const q: ReviewQuery = {
    from: query.from !== undefined && DATE_ONLY.test(query.from) ? query.from : null,
    to: query.to !== undefined && DATE_ONLY.test(query.to) ? query.to : null,
    queueKey: null,
    state: "UNREVIEWED",
  };
  const rows = await prisma.comment.findMany({
    where: reviewWhere(viewer, q, now),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: REVIEW_MAX_ROWS,
    include: COMMENT_INCLUDE,
  });
  return rows.map((c) => toCommentDTO(c));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CRLF = "\r\n";

/**
 * The export's columns.
 *
 * **No reply body, deliberately.** This file is the evidence INDEX a reviewer or an examiner works
 * from — which replies went out, when, to which ticket, whether they were supervised, by whom and
 * with what verdict. The correspondence itself lives in the system, where reading it is recorded
 *. A CSV of client correspondence is a copy nobody can audit once it is on a laptop, and the
 * question this file answers does not need one.
 */
export const REVIEW_CSV_COLUMNS = [
  "ticketNumber",
  "link",
  "subject",
  "queueKey",
  "category",
  "commentId",
  "author",
  "sentAt",
  "sentAtFirm",
  "deliveryStatus",
  "attachmentCount",
  "retracted",
  "stamped",
  "verdict",
  "verdictLabel",
  "reviewer",
  "reviewerEmail",
  "stampedAt",
  "reviewNotePresent",
] as const;

function bool(v: boolean): string {
  return v ? "true" : "false";
}

/**
 * One RFC 4180 line per (reply × stamp), and one line for an unstamped reply — so a reply two people
 * reviewed appears twice rather than losing a reviewer to a "first stamp wins" collapse.
 *
 * `reviewNotePresent` is a boolean rather than the note: a reviewer's note is free text about client
 * correspondence and belongs in the system with the rest of it.
 */
export function reviewRowsToCsv(rows: readonly ReplyReviewRow[], withHeader: boolean): string {
  const lines: string[] = [];
  if (withHeader) lines.push(REVIEW_CSV_COLUMNS.map((c) => csvCell(c)).join(","));

  for (const row of rows) {
    const base = [
      csvCell(row.ticketNumber),
      csvCell(row.ticketPath),
      csvCell(row.subject),
      csvCell(row.queueKey),
      csvCell(row.category),
      csvCell(row.commentId),
      csvCell(row.author?.email ?? row.authorLabel),
      csvCell(row.sentAt),
      csvCell(formatFirmDateTime(row.sentAt)),
      csvCell(row.deliveryStatus),
      csvCell(row.attachmentCount),
      csvCell(bool(row.retracted)),
    ];
    if (row.stamps.length === 0) {
      lines.push([...base, csvCell("false"), csvCell(null), csvCell(null), csvCell(null), csvCell(null), csvCell(null), csvCell("false")].join(","));
      continue;
    }
    for (const stamp of row.stamps) {
      lines.push(
        [
          ...base,
          csvCell("true"),
          csvCell(stamp.verdict),
          csvCell(REVIEW_VERDICT_LABELS[stamp.verdict as ReviewVerdict]),
          csvCell(stamp.reviewer.name ?? stamp.reviewer.email),
          csvCell(stamp.reviewer.email),
          csvCell(formatFirmDateTime(stamp.createdAt)),
          csvCell(bool(stamp.note !== null && stamp.note.length > 0)),
        ].join(","),
      );
    }
  }
  return lines.length === 0 ? "" : `${lines.join(CRLF)}${CRLF}`;
}

/** The filters as the pre-stream audit row records them — no free text, just the applied narrowing. */
export function reviewExportFilters(q: ReviewQuery, now: Date = new Date()): Record<string, string | null> {
  const { gte, lt } = reviewWindow(q, now);
  return {
    from: q.from,
    to: q.to,
    queue: q.queueKey,
    state: q.state,
    windowStart: gte.toISOString(),
    windowEnd: lt === null ? null : lt.toISOString(),
  };
}
