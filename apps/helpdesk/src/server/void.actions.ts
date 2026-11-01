"use server";

/**
 * "Entered in error" — `"use server"`, node, layer L4.
 *
 * **VOIDED is not a transition.** `ALLOWED_STATUS_TRANSITIONS.VOIDED = []` and no status lists VOIDED
 * as a target, so `changeTicketStatus` can never reach it. This action writes that one edge itself,
 * behind three separate bars:
 *
 *  1. **ops_team AND queue WRITE** (`canVoidTicket`). WRITE keeps it inside the queue the ticket lives
 *     in; `ops_team` is the extra bar, because a void removes a ticket from every counter, every SLA
 *     number and every export at once, and the honest failure mode of a status anyone can set is a desk
 *     that voids its way to a clean board.
 *  2. **A recorded reason of at least 12 characters**, sanitized, stored on the row AND on the
 *     `TICKET_VOIDED` row. The DB CHECK `ticket_void_reason_length` is the backstop; this is the check
 *     that produces a field error a person can act on.
 *  3. **Refused once any PUBLIC comment exists.** After the desk has written to the client the ticket
 *     is correspondence, and the answer to a mistake in correspondence is a correction, not a deletion.
 *     B3's `retractComment` is that correction. The refusal has TWO wordings for the one
 *     policy: a reply still on the client's view is answered by withdrawing it, while a reply already
 *     withdrawn is answered by closing the ticket — naming the first remedy to an operator who has
 *     already performed it says something untrue and leaves them without a next step.
 *
 * One transaction: the three void columns + `resolution: ENTERED_IN_ERROR` + `TICKET_VOIDED` + the
 * follower notification, with `writeAuditMany` last.
 */
import { z } from "zod";
import type { ActionResult, AuditEntry, VoidTicketInput } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatPiiCounts, sanitizePII } from "@/lib/pii";
import { assertCan, canVoidTicket } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import { notifyFromEvent } from "@/server/notifications";
import { assertTicketNotClosed } from "@/server/tickets";

const voidTicketSchema: z.ZodType<VoidTicketInput, unknown> = z.object({
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  version: z.number().int().min(1),
  reason: z
    .string()
    .trim()
    .min(WAVE_B_LIMITS.reasonMinChars, `Say why, in at least ${WAVE_B_LIMITS.reasonMinChars} characters`)
    .max(WAVE_B_LIMITS.reasonMaxChars),
  // Not a formality: the sheet's explicit confirmation is part of the input, so a mis-wired caller
  // cannot void a ticket by omission.
  confirm: z.literal(true),
});

export async function voidTicket(input: VoidTicketInput): Promise<ActionResult<{ version: number }>> {
  return runAction("voidTicket", async (viewer, ctx) => {
    const data = voidTicketSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const t = await tx.ticket.findUnique({
        where: { id: data.ticketId },
        select: {
          id: true,
          number: true,
          status: true,
          version: true,
          resolution: true,
          queue: { select: { key: true } },
        },
      });
      if (!t) throw new NotFoundError("ticket not found");

      assertCan(canVoidTicket(viewer.groups, t.queue.key), "ticket:void", t.id);
      // Refuses VOIDED (already) and CLOSED (a real record of real work), each with its own message.
      assertTicketNotClosed(t);

      // The test is the existence of a PUBLIC comment, which is not the same fact as a send: a
      // retracted reply never left the building (its delivery is CANCELLED), a phone-only ticket is
      // deliberately never emailed, and a suppressed address reads FAILED_SUPPRESSED.
      // The policy is right in all three cases — a public comment is correspondence whether or not an
      // email went — so the refusal states the fact the code actually tested rather than claiming a
      // delivery (CROSSWALK P16).
      //
      // Fix round 2: the POLICY is unchanged, the WORDING is split. A withdrawn reply is still
      // correspondence (the record of it is permanent, and CommentRetraction is append-only), but the
      // client can no longer see it — the client API serves the withdrawal placeholder — so telling
      // the operator to "withdraw the reply" after they already have states something false and hands
      // them a step they have performed. Each branch names the state the ticket is actually in and
      // leaves exactly one next step.
      const publicComments = await tx.comment.count({ where: { ticketId: t.id, visibility: "PUBLIC" } });
      if (publicComments > 0) {
        const liveComments = await tx.comment.count({
          where: { ticketId: t.id, visibility: "PUBLIC", retraction: { is: null } },
        });
        throw new ValidationError("this ticket has already been answered", {
          _form: [
            liveComments > 0
              ? "This ticket already carries a reply the client can see, so it is correspondence and cannot be voided. Withdraw the reply and close the ticket with a correction instead."
              : "This ticket carried a reply to the client. Withdrawing it took the reply off the client's view but not off the record, so the ticket is still correspondence and cannot be voided. Close it with the Withdrawn outcome instead.",
          ],
        });
      }

      const sanitized = sanitizePII(data.reason);
      const reason = sanitized.text.trim();
      if (reason.length < WAVE_B_LIMITS.reasonMinChars) {
        throw new ValidationError("say why this ticket should never have existed", {
          reason: [`At least ${WAVE_B_LIMITS.reasonMinChars} characters, after redaction.`],
        });
      }

      const now = new Date();
      const updated = await tx.ticket.updateMany({
        where: { id: t.id, version: data.version },
        data: {
          status: "VOIDED",
          resolution: "ENTERED_IN_ERROR",
          voidedAt: now,
          voidedById: viewer.id,
          voidReason: reason,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new ConflictError();

      const entries: AuditEntry[] = [
        {
          action: "TICKET_VOIDED",
          entityType: "TICKET",
          entityId: t.id,
          ticketId: t.id,
          fieldChanged: "status",
          oldValue: t.status,
          newValue: "VOIDED",
          metadata: { reason },
        },
        {
          action: "TICKET_FIELD_CHANGED",
          entityType: "TICKET",
          entityId: t.id,
          ticketId: t.id,
          fieldChanged: "resolution",
          oldValue: t.resolution,
          newValue: "ENTERED_IN_ERROR",
        },
      ];
      if (sanitized.redacted) {
        entries.push({
          action: "PII_REDACTED",
          entityType: "TICKET",
          entityId: t.id,
          ticketId: t.id,
          fieldChanged: "voidReason",
          oldValue: null,
          newValue: formatPiiCounts(sanitized.byKind),
        });
      }

      // PII-light preview: the number and the fact, never the reason text — a void reason is
      // free text about a mistake and has no business in a Slack DM or a push payload.
      const notified = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: t.id,
        preview: `HD-${t.number} was voided (entered in error)`,
        actorId: viewer.id,
      });
      entries.push(...notified.auditEntries);

      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1 };
    });
  });
}
