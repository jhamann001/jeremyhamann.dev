"use server";

/**
 * Supervisory review — the writes. `"use server"`, node, layer L4.
 *
 * Reads live in `src/server/reviews.ts`. Two actions:
 *
 *  - `stampReview` records that a named person reviewed one PUBLIC reply, with a verdict, the points
 *    they checked and an optional note. One `ReviewStamp` row and one `REVIEW_STAMPED` audit row in
 *    ONE transaction.
 *  - `openReplyForReview` returns the reply's full text and writes `TICKET_PREVIEWED` before it does.
 *
 * WHY THE SECOND ACTION EXISTS. The review queue renders a bounded excerpt, which sits on the
 * not-a-view side of §e's line for the same reason a held-mail snippet does. Reading
 * the WHOLE reply is a read of client material and is recorded as one, through the same `recordView`
 * the ticket preview route uses. The result is that the ledger can answer the question an examiner
 * asks about a supervisory control — "did the reviewer read what they signed off?" — instead of only
 * recording the signature.
 *
 * WHAT A STAMP IS NOT. It touches no ticket field, no status, no client record and nothing the client
 * can see; it does not un-send, amend or approve the reply, which has already gone. That is precisely
 * why `review:stamp` can be wider than `audit:view` without breaking §b rule 2 — a stamp is an
 * annotation, the same side of the line as an INTERNAL note.
 *
 * `ReviewStamp` is append-only at the database and unique per (comment, reviewer): a
 * second reviewer may add a second opinion, one reviewer may not quietly replace their own. A
 * reviewer who changes their mind says so in a new stamp under their colleague's, or in an internal
 * note on the ticket — both of which leave the first reading in the record, which is the point.
 *
 * Nothing here transmits anything.
 */
import { z } from "zod";
import type { ActionResult, AuditEntry, ReviewVerdict } from "@/types/domain";
import { REVIEW_VERDICTS, WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, recordView, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canReadQueue, canStampReview } from "@/lib/rbac";
import { normalizeChecklist, REVIEW_CHECKLIST_KEYS } from "@/lib/review-checklist";
import { runAction } from "@/server/action-utils";

const NOTE_MAX = WAVE_B_LIMITS.reasonMaxChars;

const stampSchema = z
  .object({
    commentId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid comment id"),
    verdict: z.enum(REVIEW_VERDICTS as unknown as [ReviewVerdict, ...ReviewVerdict[]]),
    /**
     * Which points the reviewer checked. Optional and unvalidated against the reply's text — it is a
     * record of what they say they looked at, not a machine verdict (see `@/lib/review-checklist`).
     */
    checklist: z.array(z.string()).max(REVIEW_CHECKLIST_KEYS.length * 2).optional(),
    note: z.string().trim().max(NOTE_MAX).optional(),
  })
  .superRefine((v, ctx) => {
    // A FLAGGED stamp with no words is an alarm nobody can act on: the next reader has to guess what
    // was wrong with a reply that has already gone to a client. APPROVED needs no note — the checklist
    // and the reviewer's name are the record, and demanding prose for the ordinary case is how a
    // supervisory control becomes something people batch through at 5pm.
    if (v.verdict === "FLAGGED" && (v.note === undefined || v.note.trim().length < 12)) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Say what is wrong with this reply — at least 12 characters.",
      });
    }
  });

export type StampReviewActionInput = z.input<typeof stampSchema>;

const openSchema = z.object({
  commentId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid comment id"),
});

export type OpenReplyForReviewInput = z.input<typeof openSchema>;
export type ReplyForReview = {
  commentId: string;
  ticketId: string;
  ticketNumber: number;
  subject: string;
  body: string;
  sentAt: string;
};

/**
 * Stamps one PUBLIC reply.
 *
 * Order is the control: authenticate (runAction) → validate → `review:stamp` → load the comment →
 * re-check that the viewer can READ the ticket's queue → refuse an INTERNAL note → write the stamp
 * and its audit row in one transaction, with `writeAuditMany` last.
 *
 * The queue re-check is not redundant with the capability. `review:stamp` says "this person
 * supervises correspondence"; `queue:read` says "this person may see this ticket". Today every group
 * holding the first also reads all three queues, so the check refuses nothing — which is exactly when
 * to write it down, because the day the queue table narrows is not the day anyone will remember to
 * come back here.
 */
export async function stampReview(input: StampReviewActionInput): Promise<ActionResult<{ id: string }>> {
  return runAction("stampReview", async (viewer, ctx) => {
    const data = stampSchema.parse(input);
    assertCan(canStampReview(viewer.groups), "review:stamp");
    const actor = actorFromViewer(viewer);
    const checklist = normalizeChecklist(data.checklist ?? []);

    return withTx(async (tx) => {
      const comment = await tx.comment.findUnique({
        where: { id: data.commentId },
        select: {
          id: true,
          ticketId: true,
          visibility: true,
          ticket: { select: { id: true, number: true, queue: { select: { key: true } } } },
        },
      });
      if (comment === null) throw new NotFoundError("reply not found");

      // Existence never leaks across a queue boundary: a comment on a ticket this viewer cannot
      // read is the same NOT_FOUND as a comment that does not exist.
      if (!canReadQueue(viewer.groups, comment.ticket.queue.key)) throw new NotFoundError("reply not found");

      if (comment.visibility !== "PUBLIC") {
        // ForbiddenError rather than ValidationError: this is a capability boundary (supervision is
        // of correspondence), so the refusal belongs in the ledger as an AUTHZ_DENIED row.
        throw new ForbiddenError("only public replies are reviewed", comment.ticketId);
      }

      const note = data.note === undefined || data.note.length === 0 ? null : sanitizePII(data.note).text;

      let stampId: string;
      try {
        const created = await tx.reviewStamp.create({
          data: { commentId: comment.id, reviewerId: viewer.id, verdict: data.verdict, note },
          select: { id: true },
        });
        stampId = created.id;
      } catch (e) {
        // @@unique([commentId, reviewerId]). A double tap on a phone, or two tabs, must not put two
        // rows in the hash chain — and must not silently succeed either, because the second verdict
        // may differ from the first and the first one stands.
        if (isUniqueViolation(e)) throw new ConflictError("you have already reviewed this reply");
        throw e;
      }

      const entries: AuditEntry[] = [
        {
          action: "REVIEW_STAMPED",
          entityType: "REVIEW_STAMP",
          entityId: stampId,
          ticketId: comment.ticketId,
          fieldChanged: "verdict",
          oldValue: null,
          newValue: data.verdict,
          // PII-light: enum values and a count. The note itself is on the row; repeating free
          // text in the ledger doubles the surface that has to be redacted correctly.
          metadata: {
            checklist,
            checkedCount: checklist.length,
            notePresent: note !== null,
            ticketNumber: comment.ticket.number,
          },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: stampId };
    });
  });
}

/**
 * Returns the full text of one PUBLIC reply, and records the read first.
 *
 * `recordView(..., "PREVIEW")` is awaited BEFORE the body is produced: if the ledger write
 * fails, the reviewer gets an error and no text, never text with no row behind it. The action is the
 * one place in this slice that hands out record content, which is why it is the one place that
 * writes a view row.
 */
export async function openReplyForReview(
  input: OpenReplyForReviewInput,
): Promise<ActionResult<ReplyForReview>> {
  return runAction("openReplyForReview", async (viewer, ctx) => {
    const data = openSchema.parse(input);
    assertCan(canStampReview(viewer.groups), "review:stamp read");

    const comment = await prisma.comment.findUnique({
      where: { id: data.commentId },
      select: {
        id: true,
        ticketId: true,
        body: true,
        visibility: true,
        createdAt: true,
        ticket: { select: { id: true, number: true, subject: true, queue: { select: { key: true } } } },
      },
    });
    if (comment === null) throw new NotFoundError("reply not found");
    if (!canReadQueue(viewer.groups, comment.ticket.queue.key)) throw new NotFoundError("reply not found");
    if (comment.visibility !== "PUBLIC") throw new ForbiddenError("only public replies are reviewed", comment.ticketId);

    await recordView(actorFromViewer(viewer), ctx, comment.ticketId, "PREVIEW");

    return {
      commentId: comment.id,
      ticketId: comment.ticketId,
      ticketNumber: comment.ticket.number,
      subject: comment.ticket.subject,
      body: comment.body,
      sentAt: comment.createdAt.toISOString(),
    };
  });
}

/** Prisma's unique-constraint failure, recognised without importing a Prisma VALUE (G1/G2 hygiene). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}
