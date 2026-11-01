"use server";

/**
 * Held inbound mail — the discard path. `"use server"`, node, layer L4.
 *
 * Releasing was the only way a held message could leave the review queue, and release means "open a
 * real ticket, with an SLA clock, in somebody's work queue". Five of the nine hold reasons —
 * `AUTO_REPLY`, `BOUNCE`, `SYSTEM_SENDER`, `SPAM`, `LOOP_DETECTED` — describe machine noise that must
 * never become a ticket, and `PARSE_FAILED` describes a message that `releaseHeldIntake` refuses
 * outright (it has no address a ticket could be answered at). A reviewer facing one of those had two
 * options: file spam as client work, or leave the row `NEW` forever. They left it. The `NEW` counter
 * therefore only ever grew, and the page whose whole purpose is "a wire instruction that failed DMARC
 * must not sit unseen" fills with noise nobody can clear.
 *
 * This is the missing disposition, and the build record already describes it as the operating
 * procedure: *"Something that should not have arrived is released to nothing and marked, not
 * removed."*
 *
 * What a discard is, exactly:
 *   1. `SuspendedIntake.status NEW → DISCARDED` — a conditional `updateMany`, so a double tap
 *      and two reviewers clicking at once produce one transition, not two audit rows.
 *   2. One audit row in the SAME transaction, carrying the reviewer's reason.
 *
 * What a discard is NOT: a delete. The row stays, the snippet stays, the `Discarded` filter shows it
 * forever, and the append-only trigger on `SuspendedIntake` means no code path can remove it. Nothing
 * is sent to the sender — the same as a release.
 *
 * TWO CONTRACT DEVIATIONS, both recorded in
 * the build record:
 *
 * - **The audit action.** `AuditAction` is frozen for this wave and has no `INTAKE_DISCARDED`. The row
 *   is written as `INTAKE_SUSPENDED` / `SUSPENDED_INTAKE` with `fieldChanged: "status"`,
 *   `oldValue: "NEW"`, `newValue: "DISCARDED"` — the same shape `INTAKE_RELEASED` uses, under the
 *   action that already names this entity's lifecycle. It is unambiguous: the row `suspendIntake`
 *   writes carries `fieldChanged: "reason"`, so `fieldChanged` partitions the two cleanly and
 *   `auditFactsFor` reads them apart. The dedicated enum value is requested in the notes.
 * - **Who and when.** `SuspendedIntake` has no `discardedById` / `discardedAt` columns and this wave
 *   runs no migration, so the audit row is the only record of who marked it. `listHeldIntake` reads it
 *   back, so the page shows it. The columns are requested in the same notes.
 *
 * Capability: `intake:review`, NOT `intake:release`. Releasing files a record into someone's work
 * queue, which is operational and therefore excludes compliance. Discarding files
 * nothing, touches no ticket and no client record — it records a reviewer's reading of a refusal,
 * which is precisely what compliance's read-plus-annotate role is. **Recommended default, pending
 * confirmation** (gap analysis §9): if the CCO would rather compliance could not clear the desk's
 * queue, the gate becomes `canReleaseHeldIntake` over the reviewer's writable queues and nothing else
 * in this module changes.
 *
 * Nothing here transmits anything.
 */
import { z } from "zod";
import type { ActionResult, AuditEntry } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import { canReviewHeldIntake } from "@/server/suspended-intake";

/** Mirrors `release-intake-dialog`'s note cap, and the reason here is REQUIRED. */
const DISCARD_REASON_MAX = 500;

const discardSchema = z.object({
  suspendedId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  /**
   * Why this is not for the desk. Required, unlike the release note: a discard is the one disposition
   * that produces no ticket anybody can later read, so the ledger is the whole record of the decision
   * and an empty one would be worthless a year later.
   */
  reason: z
    .string()
    .trim()
    .min(3, "Say in a few words why this is not for the desk")
    .max(DISCARD_REASON_MAX),
});

export type DiscardHeldIntakeInput = z.input<typeof discardSchema>;
export type DiscardHeldIntakeResult = { suspendedId: string; alreadyDiscarded: boolean };

/**
 * Marks one held message as not for the desk.
 *
 * Idempotent: a row already `DISCARDED` returns `alreadyDiscarded: true` and writes nothing, so a
 * double tap on a phone cannot put two rows in the hash chain. A `RELEASED` row is refused — it
 * became a ticket, and a ticket is closed on the ticket, not here.
 */
export async function discardHeldIntake(
  input: DiscardHeldIntakeInput,
): Promise<ActionResult<DiscardHeldIntakeResult>> {
  return runAction("discardHeldIntake", async (viewer, ctx) => {
    const data = discardSchema.parse(input);
    assertCan(canReviewHeldIntake(viewer.groups), "intake:review discard");

    const row = await prisma.suspendedIntake.findUnique({
      where: { id: data.suspendedId },
      select: { id: true, status: true, reason: true, mailbox: true, messageId: true },
    });
    if (row === null) throw new NotFoundError("held message not found");

    if (row.status === "DISCARDED") return { suspendedId: row.id, alreadyDiscarded: true };
    if (row.status === "RELEASED") {
      throw new ConflictError("this held message was released into a ticket; it cannot be discarded");
    }

    // I4: the reviewer's own words are free text and are sanitised before they reach the ledger.
    const note = sanitizePII(data.reason).text;
    const actor = actorFromViewer(viewer);

    const marked = await withTx(async (tx) => {
      const claimed = await tx.suspendedIntake.updateMany({
        where: { id: row.id, status: "NEW" },
        data: { status: "DISCARDED" },
      });
      if (claimed.count === 0) return false;

      const entries: AuditEntry[] = [
        {
          // Wave B landed the dedicated enum value this row was borrowing (Wave A CONTRACT §14 and
          // `fix-admin-intake-discard.md` §1). `metadata.detail` stays so the rows written before this
          // change keep reading the same way, and `auditFactsFor` still partitions the two shapes on
          // `fieldChanged` — a HOLD carries "reason", a disposition carries "status" — so anything
          // counting holds keeps working across the boundary.
          action: "INTAKE_DISCARDED",
          entityType: "SUSPENDED_INTAKE",
          entityId: row.id,
          fieldChanged: "status",
          oldValue: "NEW",
          newValue: "DISCARDED",
          // No `via`: this is a human decision at a screen, and §3 rule 1 partitions the ledger on
          // `metadata->>'via'` being absent for exactly that. The channel the message arrived on is
          // already on its own INTAKE_SUSPENDED row.
          metadata: {
            detail: "DISCARDED_BY_REVIEWER",
            reason: row.reason,
            mailbox: row.mailbox,
            messageId: row.messageId,
            note,
          },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);
      return true;
    });

    if (!marked) {
      // Somebody else handled it between the read and here. Their disposition is the one that counts.
      const winner = await prisma.suspendedIntake.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      if (winner?.status === "DISCARDED") return { suspendedId: row.id, alreadyDiscarded: true };
      throw new ConflictError("this held message is no longer discardable");
    }

    return { suspendedId: row.id, alreadyDiscarded: false };
  });
}
