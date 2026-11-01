"use server";

/**
 * Comment retraction — `"use server"`, node, layer L4.
 *
 * The desk sent a client something it should not have. There are only two honest answers to that, and
 * this is the one that does not require a time machine:
 *
 *  - **The comment row is never touched**. What was written is what was written; a staff surface
 *    keeps showing it, struck through, with who withdrew it, when and why, because the desk has to be
 *    able to read what it actually put in front of a client.
 *  - **The client stops being able to reach it at the PRIVILEGE layer, not at the render layer.** The
 *    `ClientVisibleComment` view returns an empty string for a retracted row and `retracted = true`,
 *    and `wm_helpdesk_public` holds no privilege on `"Comment"` or `"CommentRetraction"` — so the
 *    withdrawn text is unreachable through the client API even if a future bug renders whatever it is
 *    handed. `src/server/client-view.ts` additionally refuses a row that claims retraction while
 *    carrying a body (verified: `IsolationViolationError`, guardrail G16).
 *
 * **A retraction cannot be undone.** Un-retracting would be an edit of the record by another name: it
 * would make the client's view of the thread depend on the desk's most recent mood rather than on a
 * sequence of recorded acts. A mistaken retraction is corrected the way every other mistake in
 * correspondence is — by writing to the client again.
 *
 * **A QUEUED delivery is cancelled in the same transaction; a SENT one is not recalled.** Email that
 * has left the building cannot be unsent, and saying otherwise in a UI is the single most dangerous
 * thing this feature could do. The result carries `deliveryCancelled` so the composer's confirmation
 * can state which of the two happened, before the irreversible click and again after it.
 *
 * RBAC is `queue:write` and deliberately not narrower: the person who sent the wrong thing is the
 * person who has to withdraw it, within the minute, and a bar that routes this through a supervisor
 * buys a delay measured in hours on an action whose whole value is being fast. It is NOT gated on
 * "the ticket is open": a reply sent in error on a ticket that has since been closed is exactly the
 * case where withdrawal matters, and `assertTicketNotClosed` would refuse it.
 */
import { z } from "zod";
import type { ActionResult, AuditEntry, RetractCommentInput } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canWriteQueue } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
//
// The schema lives here rather than in `src/server/validation.ts` because that file is shared and B3
// does not own it. Recorded in the build record.
// ---------------------------------------------------------------------------

const retractCommentSchema: z.ZodType<RetractCommentInput, unknown> = z.object({
  commentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  /**
   * The same floor the DB CHECK `comment_retraction_reason_present` enforces, and the same floor
   * `changeRequesterEmail` and `voidTicket` use: twelve characters is a short sentence, which is the
   * least a reviewer can work with. Refused here so the operator sees a field error rather than an
   * opaque constraint violation.
   */
  reason: z
    .string()
    .trim()
    .min(WAVE_B_LIMITS.reasonMinChars, `Say why in at least ${WAVE_B_LIMITS.reasonMinChars} characters`)
    .max(WAVE_B_LIMITS.reasonMaxChars),
  /** Two-step confirmation. Anything but a literal `true` is refused. */
  confirm: z.literal(true),
});

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Withdraws one PUBLIC comment.
 *
 * One transaction: the `CommentRetraction` insert, the delivery cancellation when there is a QUEUED
 * one, and `writeAuditMany` as the last statement (audit rule 2). Nothing here is conditional on a
 * read-then-write: the delivery transition is a guarded `updateMany` on `status: "QUEUED"`, so a
 * poller that leased the row microseconds earlier loses the race honestly — the count comes back 0,
 * the reply is reported as already gone, and no row claims a cancellation that did not happen.
 */
export async function retractComment(
  input: RetractCommentInput,
): Promise<ActionResult<{ id: string; deliveryCancelled: boolean }>> {
  return runAction("retractComment", async (viewer, ctx) => {
    const data = retractCommentSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const comment = await tx.comment.findUnique({
        where: { id: data.commentId },
        select: {
          id: true,
          ticketId: true,
          visibility: true,
          authorKind: true,
          retraction: { select: { id: true } },
          delivery: { select: { id: true, status: true } },
          ticket: { select: { id: true, queue: { select: { key: true } } } },
        },
      });
      if (!comment) throw new NotFoundError("Comment not found");

      assertCan(canWriteQueue(viewer.groups, comment.ticket.queue.key), "comment:retract", comment.ticketId);

      // INTERNAL notes are never withdrawn: nobody outside the desk has seen one, so there is nothing
      // to take back, and striking one through would only hide a note from the colleagues it was for.
      // A REQUESTER's own message is not the desk's to withdraw at all.
      if (comment.visibility !== "PUBLIC") {
        throw new ValidationError("only a public reply can be withdrawn", {
          commentId: ["Internal notes are not client-visible, so there is nothing to withdraw."],
        });
      }
      if (comment.authorKind === "REQUESTER") {
        throw new ValidationError("a client's own message cannot be withdrawn", {
          commentId: ["This message came from the client. The desk does not withdraw it on their behalf."],
        });
      }
      if (comment.retraction !== null) {
        throw new ConflictError("this reply has already been withdrawn");
      }

      // I4: the reason is persisted free text and is echoed onto the audit row.
      const reason = sanitizePII(data.reason).text;

      let retraction: { id: string };
      try {
        retraction = await tx.commentRetraction.create({
          data: { commentId: comment.id, retractedById: viewer.id, reason },
          select: { id: true },
        });
      } catch (e) {
        // Lost the race with another operator between the read above and this insert. `commentId` is
        // UNIQUE, which is what makes "withdrawn twice" impossible rather than merely unlikely.
        if (isUniqueViolation(e)) throw new ConflictError("this reply has already been withdrawn");
        throw e;
      }

      // Only a QUEUED delivery can be stopped. LEASED means a poller already holds it, SENT means it
      // is in somebody's mailbox, and CANCELLED/BOUNCED/FAILED are already terminal.
      const delivery = comment.delivery;
      let deliveryCancelled = false;
      if (delivery !== null) {
        const stopped = await tx.messageDelivery.updateMany({
          where: { id: delivery.id, status: "QUEUED" },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });
        deliveryCancelled = stopped.count === 1;
      }

      const entries: AuditEntry[] = [
        {
          action: "COMMENT_RETRACTED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: comment.ticketId,
          fieldChanged: "body",
          oldValue: null,
          // Never the withdrawn text: the ledger records THAT it was withdrawn, and the comment row
          // is still the copy of what was said.
          newValue: "withdrawn",
          metadata: { reason, deliveryCancelled },
        },
      ];
      if (deliveryCancelled && delivery !== null) {
        entries.push({
          action: "MESSAGE_CANCELLED",
          entityType: "MESSAGE_DELIVERY",
          entityId: delivery.id,
          ticketId: comment.ticketId,
          fieldChanged: "status",
          oldValue: "QUEUED",
          newValue: "CANCELLED",
          metadata: { commentId: comment.id },
        });
      }
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: retraction.id, deliveryCancelled };
    });
  });
}
