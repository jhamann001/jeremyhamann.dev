"use server";

/**
 * Bulk actions — `"use server"`, node, layer L4 (the build record rule 4).
 *
 * **A bulk action is N ORDINARY actions, not a blanket write.** Per ticket: its own RBAC check, its own
 * version guard, its own transaction, its own audit rows. That is the whole design, and everything
 * below follows from it:
 *
 *  - A ticket the viewer may not act on is **SKIPPED with a reason and reported back**, and the denial
 *    is recorded as `AUTHZ_DENIED` like any other — never silently succeeded, never allowed to
 *    fail the batch. Fifty tickets where one is in a queue you cannot write is forty-nine applied and
 *    one explained, not a red toast and nothing done.
 *  - **The bar per kind is the bar the single-ticket control applies.** `assign`, `status`, `priority`
 *    and `queue` change the ticket and need queue WRITE (`bulk:apply`). `follow` changes no ticket
 *    field and needs queue **READ**, exactly as `followTicket` does — otherwise a reader who may
 *    follow one ticket at a time could never follow two.
 *  - A ticket whose version moved between the read and the write is skipped as `CONFLICT`. Somebody
 *    else was working it; overwriting them is exactly what the version token exists to prevent.
 *  - Each ticket writes its ORDINARY audit row — `TICKET_ASSIGNED`, `TICKET_STATUS_CHANGED`,
 *    `TICKET_PRIORITY_CHANGED`, `TICKET_QUEUE_CHANGED`, `TICKET_FOLLOWED` — plus **one**
 *    `BULK_ACTION_APPLIED` summary row carrying `{batchId, count}`. The batch id is what lets a reader
 *    reconstruct "these twelve rows were one click" from a ledger that otherwise looks like twelve
 *    unrelated edits.
 *
 * PARTIAL SUCCESS IS THE CONTRACT, not a failure mode: `BulkActionResult` reports `applied` and a
 * `skipped` entry per ticket with its code and a sentence. The bar renders every one of them. A ticket
 * that is ALREADY in the state asked for is not one of them: `follow` counts it as applied and writes
 * nothing, exactly as `followTicket` does, because a `skipped` entry is a refusal an operator has to
 * act on and "you already follow this" is not.
 *
 * And because a bulk change is an ordinary change, it carries the ordinary change's SIDE-EFFECTS: the
 * transition into RESOLVED runs the Decision #103 identity gate AND sends the client's resolved notice,
 * the same two things `changeTicketStatus` does, so what a client hears does not depend on which
 * control the operator reached for.
 *
 * The tickets are processed SEQUENTIALLY. Each is its own transaction and the audit chain trigger takes
 * an advisory lock per write, so concurrency here would buy contention rather than speed — and a
 * deterministic order makes the ledger read in the order the operator's list did.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type {
  ActionErrorCode,
  ActionResult,
  AuditActor,
  AuditEntry,
  BulkActionInput,
  BulkActionResult,
  OktaGroup,
  QueueKey,
  RequestContext,
  TicketCategory,
  TicketPriority,
  TicketResolution,
  TicketStatus,
  Viewer,
} from "@/types/domain";
import {
  OPERATOR_RESOLUTIONS,
  QUEUE_KEYS,
  QUEUE_LABELS,
  RESOLUTION_BEARING_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  WAVE_B_LIMITS,
} from "@/types/domain";
import { actorFromViewer, diffFields, recordDenied, writeAuditMany } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { withTx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, isAppError } from "@/lib/errors";
import { PRIORITY_LABELS, STATUS_LABELS, formatTicketNumber } from "@/lib/format";
import { logError } from "@/lib/logger";
import { assertCan, canApplyBulk, canMoveTicket, canReadQueue, canWriteQueue } from "@/lib/rbac";
import { canTransition } from "@/lib/ticket-policy";
import { runAction } from "@/server/action-utils";
import { assertIdentityGate } from "@/server/identity-gate";
import { notifyFromEvent } from "@/server/notifications";
import { maybeSendResolvedNotice } from "@/server/system-messages";
import { assertTicketNotClosed } from "@/server/tickets";

// ---------------------------------------------------------------------------
// Validation (module-private)
// ---------------------------------------------------------------------------

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

const bulkActionSchema: z.ZodType<BulkActionInput, unknown> = z.object({
  ticketIds: z
    .array(idSchema)
    .min(1, "Select at least one ticket")
    .max(WAVE_B_LIMITS.bulkMaxTickets, `A bulk action may touch ${WAVE_B_LIMITS.bulkMaxTickets} tickets at a time`)
    // The UI cannot select the same row twice, but an input that arrives with duplicates would write
    // two audit rows for one ticket and count it twice.
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate ticket ids"),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("assign"), assigneeId: idSchema.nullable() }),
    // `resolution` is OPTIONAL and only ever an operator outcome. The bar asks once for
    // the whole batch, because the alternative — one outcome per ticket — is a form, not a bulk action.
    z.object({
      kind: z.literal("status"),
      status: z.enum(TICKET_STATUSES),
      resolution: z.enum(OPERATOR_RESOLUTIONS).optional(),
    }),
    z.object({ kind: z.literal("priority"), priority: z.enum(TICKET_PRIORITIES) }),
    z.object({ kind: z.literal("queue"), queueKey: z.enum(QUEUE_KEYS) }),
    z.object({ kind: z.literal("follow"), follow: z.boolean() }),
  ]),
});

type BulkAction = BulkActionInput["action"];

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

const BULK_TICKET_SELECT = {
  id: true,
  number: true,
  status: true,
  priority: true,
  version: true,
  category: true,
  // Read so the status branch can tell "no outcome yet" from "already ended as X" without a second
  // query, and so `diffFields` has an OLD value to compare the new outcome against.
  resolution: true,
  assigneeId: true,
  queueId: true,
  queue: { select: { id: true, key: true } },
  assignee: { select: { id: true, email: true, groups: true } },
} as const;

type BulkTicket = {
  id: string;
  number: number;
  status: TicketStatus;
  priority: TicketPriority;
  version: number;
  category: TicketCategory;
  resolution: TicketResolution;
  assigneeId: string | null;
  queueId: string;
  queue: { id: string; key: QueueKey };
  assignee: { id: string; email: string; groups: OktaGroup[] } | null;
};

function ticketEntry(ticketId: string, entry: Omit<AuditEntry, "entityType" | "entityId" | "ticketId">): AuditEntry {
  return { entityType: "TICKET", entityId: ticketId, ticketId, ...entry };
}

/** The `{batchId, count}` summary row. One PER TICKET, beside that ticket's own field row. */
function bulkEntry(ticketId: string, kind: BulkAction["kind"], batchId: string, count: number): AuditEntry {
  return ticketEntry(ticketId, {
    action: "BULK_ACTION_APPLIED",
    fieldChanged: "bulk",
    oldValue: null,
    newValue: kind,
    metadata: { batchId, count },
  });
}

/**
 * The follower preview for a bulk change (§7.3: ids, numbers and enum values — never a subject, a
 * requester or body text).
 *
 * It prints the LABEL, not the discriminator. `action.kind` is how this module spells its own union;
 * "HD-1042 updated (queue)" put that spelling in front of a reader of /inbox, where every other
 * surface says "Client Service". A label is the same enum value written the way the badge, the
 * filters and the bar write it, so nothing widens by using one. `follow` never reaches here — the
 * caller skips the notification entirely — but the switch is total so a sixth kind cannot fall back
 * to printing its own name.
 */
function bulkPreview(ticketNumber: number, action: BulkAction): string {
  const n = formatTicketNumber(ticketNumber);
  switch (action.kind) {
    case "assign":
      return `${n} assignment changed`;
    case "status":
      return `${n} status → ${STATUS_LABELS[action.status]}`;
    case "priority":
      return `${n} priority → ${PRIORITY_LABELS[action.priority]}`;
    case "queue":
      return `${n} moved to ${QUEUE_LABELS[action.queueKey]}`;
    case "follow":
      return `${n} updated`;
  }
}

async function guardedUpdate(
  tx: DbTx,
  ticketId: string,
  version: number,
  data: Prisma.TicketUncheckedUpdateManyInput,
): Promise<void> {
  const r = await tx.ticket.updateMany({
    where: { id: ticketId, version },
    data: { ...data, version: { increment: 1 } },
  });
  if (r.count === 0) throw new ConflictError();
}

/** §b.4, restated per ticket: an assignee must be active and hold WRITE on THIS ticket's queue. */
async function assertAssigneeEligible(tx: DbTx, assigneeId: string, queueKey: QueueKey): Promise<{ id: string; email: string }> {
  const u = await tx.user.findUnique({ where: { id: assigneeId }, select: { id: true, email: true, isActive: true, groups: true } });
  if (!u || !u.isActive || !canWriteQueue(u.groups, queueKey)) {
    throw new ValidationError(`that person cannot work the ${queueKey} queue`);
  }
  return { id: u.id, email: u.email };
}

/**
 * One ticket, one transaction. Throws; the caller turns the throw into a `skipped` entry with a code
 * and a sentence, and the batch continues.
 */
async function applyToTicket(
  viewer: Viewer,
  actor: AuditActor,
  ctx: RequestContext,
  ticketId: string,
  action: BulkAction,
  batchId: string,
  count: number,
): Promise<void> {
  await withTx(async (tx) => {
    const t = (await tx.ticket.findUnique({ where: { id: ticketId }, select: BULK_TICKET_SELECT })) as BulkTicket | null;
    if (!t) throw new NotFoundError("ticket not found");

    // The bar is the SAME bar the single-ticket control applies, re-checked per ticket.
    //
    // For the four kinds that change the ticket that is `bulk:apply` — queue WRITE. `follow` is not
    // one of them: it writes a `TicketFollower` row and touches no ticket field, and `followTicket`
    // (notifications.actions.ts) deliberately requires only queue **READ** because following is
    // watching. Gating the bulk path on WRITE would mean a compliance officer — READ everywhere,
    // WRITE nowhere — can follow a ticket from its page and can never follow one from the board, and
    // every refusal would drop a permanent `AUTHZ_DENIED` row for something the same person is
    // authorised to do one click away. Same rule as an INTERNAL note (`canComment`): read to annotate,
    // write to change. Deviation from the §5 matrix row, recorded in
    // the build record
    if (action.kind === "follow") {
      assertCan(canReadQueue(viewer.groups, t.queue.key), `bulk:apply follow (queue:read ${t.queue.key})`, t.id);
    } else {
      assertCan(canApplyBulk(viewer.groups, t.queue.key), `bulk:apply ${action.kind}`, t.id);
    }

    const entries: AuditEntry[] = [];

    switch (action.kind) {
      case "follow": {
        // Following is not a write to the ticket, so a CLOSED or VOIDED ticket may still be followed:
        // a reviewer watching a closed record is legitimate, exactly as an internal note is.
        const existing = await tx.ticketFollower.findUnique({
          where: { ticketId_userId: { ticketId: t.id, userId: viewer.id } },
          select: { id: true, removedAt: true },
        });
        const following = existing !== null && existing.removedAt === null;
        // The ledger records CHANGES, not intentions. `followTicket` states that rule
        // and implements it: asking for the state that already holds is a SUCCESS that writes nothing
        // — no follower row, no `TICKET_FOLLOWED`, and no `BULK_ACTION_APPLIED` claiming a change that
        // did not happen. Throwing here instead made the bulk path disagree with the control one click
        // away: an operator selecting a mixed set and pressing Follow saw the tickets they ALREADY
        // follow reported as skipped failures beside the genuine refusals, with no way to tell a
        // denial from a no-op. Returning counts the ticket as applied, which is what the operator
        // asked for and what is now true of it.
        if (following === action.follow) return;
        if (existing === null) {
          await tx.ticketFollower.create({ data: { ticketId: t.id, userId: viewer.id, source: "MANUAL" } });
        } else {
          // Soft remove / revive — TicketFollower has no DELETE privilege.
          await tx.ticketFollower.update({
            where: { id: existing.id },
            data: action.follow ? { removedAt: null, source: "MANUAL" } : { removedAt: new Date() },
          });
        }
        entries.push(
          ticketEntry(t.id, {
            action: action.follow ? "TICKET_FOLLOWED" : "TICKET_UNFOLLOWED",
            fieldChanged: "follower",
            oldValue: null,
            newValue: viewer.email,
            metadata: { followerId: viewer.id, source: "MANUAL" },
          }),
        );
        break;
      }

      case "assign": {
        assertTicketNotClosed(t);
        const next = action.assigneeId === null ? null : await assertAssigneeEligible(tx, action.assigneeId, t.queue.key);
        if ((t.assigneeId ?? null) === (next?.id ?? null)) {
          throw new ValidationError(next === null ? "already unassigned" : "already assigned to that person");
        }
        const opens = t.status === "NEW" && next !== null;
        await guardedUpdate(tx, t.id, t.version, {
          assigneeId: next?.id ?? null,
          ...(opens ? { status: "OPEN" } : {}),
        });
        entries.push(
          ticketEntry(t.id, {
            action: "TICKET_ASSIGNED",
            fieldChanged: "assigneeId",
            oldValue: t.assigneeId ?? null,
            newValue: next?.id ?? null,
            metadata: { oldEmail: t.assignee?.email ?? null, newEmail: next?.email ?? null },
          }),
        );
        if (opens) {
          entries.push(
            ticketEntry(t.id, { action: "TICKET_STATUS_CHANGED", fieldChanged: "status", oldValue: "NEW", newValue: "OPEN" }),
          );
        }
        break;
      }

      case "priority": {
        assertTicketNotClosed(t);
        if (t.priority === action.priority) throw new ValidationError("already at that priority");
        // Deliberately NOT re-stamping the SLA due dates. `changeTicketPriority` does, from the ticket's
        // own createdAt and its own policy row — that is a per-ticket computation with a per-ticket
        // policy read, and doing it forty times inside a bulk loop is how a board gets re-clocked by
        // accident. The bar says so, and offers the single-ticket control for the clock change.
        await guardedUpdate(tx, t.id, t.version, { priority: action.priority });
        entries.push(
          ticketEntry(t.id, {
            action: "TICKET_PRIORITY_CHANGED",
            fieldChanged: "priority",
            oldValue: t.priority,
            newValue: action.priority,
          }),
        );
        break;
      }

      case "status": {
        assertTicketNotClosed(t);
        if (t.status === action.status) throw new ValidationError("already at that status");
        if (!canTransition(t.status, action.status)) {
          throw new ValidationError(`${t.status} → ${action.status} is not an allowed transition`);
        }
        if (action.status === "RESOLVED") {
          // Decision #103, per ticket: the gate is not relaxed because the change arrived in a batch.
          await assertIdentityGate(tx, { ticketId: t.id, category: t.category });
        }
        const now = new Date();
        const after: {
          status: TicketStatus;
          resolvedAt?: Date | null;
          closedAt?: Date;
          resolution?: TicketResolution;
        } = { status: action.status };
        if (action.status === "RESOLVED") after.resolvedAt = now;
        if (t.status === "RESOLVED" && action.status === "CLOSED") after.closedAt = now;
        if (t.status === "RESOLVED" && action.status === "OPEN") {
          after.resolvedAt = null;
          // A reopened ticket has not ended, so it carries no outcome — the same reason `resolvedAt`
          // is cleared, and the same clear `changeTicketStatus` performs. Without it a ticket reopened
          // in a batch would keep a stale outcome and re-enter the mix the next time it resolved.
          after.resolution = "NONE";
        }
        // Fix round 2. The outcome the bar collected, applied per ticket and audited per ticket.
        // SKIPPED (not refused) for a ticket that already carries one: a batch of forty is exactly
        // where one already-resolved ticket would otherwise abort the whole action, and the single
        // -ticket rule — an outcome is written once and changed only by reopening — is preserved by
        // not overwriting it. `assertResolutionAllowed`'s other two refusals cannot fire here: zod
        // has already restricted the value to the four operator outcomes, and the branch only runs
        // on a transition this same block proved legal.
        if (
          action.resolution !== undefined &&
          t.resolution === "NONE" &&
          (RESOLUTION_BEARING_STATUSES as readonly TicketStatus[]).includes(action.status)
        ) {
          after.resolution = action.resolution;
        }
        await guardedUpdate(tx, t.id, t.version, after);
        entries.push(
          ticketEntry(t.id, {
            action: "TICKET_STATUS_CHANGED",
            fieldChanged: "status",
            oldValue: t.status,
            newValue: action.status,
          }),
          // The outcome gets its OWN row, exactly as it does on the single-ticket path. `diffFields`
          // drops a no-op, so a reopen of a ticket that never had one writes nothing.
          ...diffFields(t, after, ["resolution"]).map((d) =>
            ticketEntry(t.id, { action: "TICKET_FIELD_CHANGED", ...d }),
          ),
        );
        // The RESOLVED side-effects belong to the TRANSITION, not to the control that triggered it
        //. `changeTicketStatus` sends the client's resolved notice inside its own
        // transaction and appends the returned entries; leaving it out here meant a client was emailed
        // when an operator used the ticket page's Resolve control and told nothing when the same
        // operator resolved the same ticket from the dashboard checkbox — and two tickets resolved on
        // the same day carried different correspondence histories for no reason a reader could see.
        // Runs INSIDE this ticket's transaction and RETURNS its entries, so `writeAuditMany` below
        // stays the last statement (CONTRACT §3 rule 2). A no-op — null, nothing written, nothing
        // transmitted — while `RESOLVED_NOTICE_ENABLED` is unset, which it is everywhere today.
        //
        // The `resolution` column is still NOT written here: `changeTicketStatus` takes an outcome
        // from its caller and this input carries none, and inventing one would put a fact on the
        // record nobody stated. That asymmetry is reported and owned separately.
        if (action.status === "RESOLVED") {
          const notice = await maybeSendResolvedNotice(tx, { ticketId: t.id, ticketNumber: t.number });
          if (notice) entries.push(...notice.auditEntries);
        }
        break;
      }

      case "queue": {
        assertTicketNotClosed(t);
        const from = t.queue.key;
        const to = action.queueKey;
        if (from === to) throw new ValidationError("already in that queue");
        assertCan(canMoveTicket(viewer.groups, from, to), `ticket:move ${from}->${to}`, t.id);
        const destination = await tx.queue.findUnique({ where: { key: to }, select: { id: true } });
        if (!destination) throw new NotFoundError(`queue ${to} is not provisioned`);
        // §b.5: a move clears an assignee who cannot write the destination.
        const clearAssignee = t.assignee !== null && !canWriteQueue(t.assignee.groups, to);
        await guardedUpdate(tx, t.id, t.version, {
          queueId: destination.id,
          ...(clearAssignee ? { assigneeId: null } : {}),
        });
        entries.push(
          ticketEntry(t.id, { action: "TICKET_QUEUE_CHANGED", fieldChanged: "queueKey", oldValue: from, newValue: to }),
        );
        if (clearAssignee && t.assignee) {
          entries.push(
            ticketEntry(t.id, {
              action: "TICKET_ASSIGNED",
              fieldChanged: "assigneeId",
              oldValue: t.assignee.id,
              newValue: null,
              metadata: { oldEmail: t.assignee.email, newEmail: null },
            }),
          );
        }
        break;
      }
    }

    entries.push(bulkEntry(t.id, action.kind, batchId, count));

    // Followers hear about the change itself, never about the batch (§7.3: ids, numbers and enums only).
    if (action.kind !== "follow") {
      const notified = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: t.id,
        preview: bulkPreview(t.number, action),
        actorId: viewer.id,
      });
      entries.push(...notified.auditEntries);
    }

    await writeAuditMany(tx, actor, ctx, entries);
  });
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function applyBulkAction(input: BulkActionInput): Promise<ActionResult<BulkActionResult>> {
  return runAction("applyBulkAction", async (viewer, ctx) => {
    const data = bulkActionSchema.parse(input);
    const actor = actorFromViewer(viewer);
    const batchId = randomUUID();
    const count = data.ticketIds.length;

    let applied = 0;
    const skipped: BulkActionResult["skipped"] = [];

    for (const ticketId of data.ticketIds) {
      try {
        await applyToTicket(viewer, actor, ctx, ticketId, data.action, batchId, count);
        applied++;
      } catch (e) {
        if (e instanceof ForbiddenError) {
          // The denial is evidence (I3/I5). `runAction` records the one that escapes; these are caught
          // here to keep the batch going, so this path records its own.
          await recordDenied(actor, ctx, `applyBulkAction: ${e.message}`, ticketId);
          skipped.push({ ticketId, code: "FORBIDDEN", message: e.message });
          continue;
        }
        if (isAppError(e)) {
          skipped.push({ ticketId, code: e.code as ActionErrorCode, message: e.message });
          continue;
        }
        // Never the message: an unexpected error's text can carry ticket content.
        logError("action:applyBulkAction", e, { ticketId });
        skipped.push({ ticketId, code: "INTERNAL", message: "Unexpected error" });
      }
    }

    return { applied, skipped };
  });
}
