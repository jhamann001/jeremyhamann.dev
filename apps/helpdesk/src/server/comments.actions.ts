"use server";
/**
 * Comment mutations.
 *
 * Visibility is a CONSTANT inside each action — never an input field. `addInternalNote` writes
 * INTERNAL rows and is allowed on CLOSED tickets (compliance annotation of a closed record). `addPublicReply`
 * writes PUBLIC rows only with a non-NONE, acknowledged disclaimer whose text is appended into the stored
 * body (the row is exactly what the client receives) and stamps the ticket's first response / NEW→OPEN
 * through CONDITIONAL updateMany writes, emitting the matching audit rows only when count === 1.
 *
 * a public reply also enqueues its outbound delivery. `enqueueDelivery` runs INSIDE the same
 * transaction as the Comment insert and RETURNS its `MESSAGE_QUEUED` entry, so the single trailing
 * `writeAuditMany` is still the last statement of the transaction (CONTRACT §3 rule 2). Nothing is sent
 * here: the row sits QUEUED until a poller leases it over /api/integrations/outbox.
 *
 * Every export goes through the shared action runner: zod → rbac → sanitize → withTx (audit last) → return
 * the minimal result. Nothing here throws to the client. No `revalidatePath`: the pages are
 * force-dynamic, and a revalidation inside the action would re-render the detail page in the action response —
 * a second audited TICKET_VIEWED per human mutation. The Composer's single `router.refresh()` is the one
 * audited re-render.
 */
import { z } from "zod";
import type {
  ActionResult,
  AuditEntry,
  CommentActionResult,
  CommentBodyInput,
  CommentVisibility,
  PublicReplyInput,
  QueueKey,
  RequestContext,
  TicketBrand,
  TicketStatus,
  Viewer,
} from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
// --- Wave B call-site hooks (FOUNDATION STUBS with no-op defaults).
// All three run INSIDE the comment's transaction: a macro's side effects are atomic with the comment
// they came from, a submitted draft cannot outlive its own comment, and a notification for a write
// that rolled back must never exist. ---
import { clearDraft } from "@/server/drafts";
import { applyMacroActions } from "@/server/macros-apply";
import { notifyFromEvent } from "@/server/notifications";
import { prisma, withTx } from "@/lib/db";
import type { DbTx } from "@/lib/db";
import { appendDisclaimer } from "@/lib/disclaimers";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatPiiCounts, sanitizePII } from "@/lib/pii";
import { assertCan, canComment } from "@/lib/rbac";
import { canTransition } from "@/lib/ticket-policy";
import { runAction } from "@/server/action-utils";
import { enqueueDelivery } from "@/server/outbox";
import { assertTicketNotClosed } from "@/server/tickets";
import { commentBodySchema, publicReplySchema } from "@/server/validation";

type TicketForComment = {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  version: number;
  brand: TicketBrand;
  requesterEmail: string | null;
  queueId: string;
  queue: { key: QueueKey };
};

type ResolvedMacro = { id: string; key: string };

/** The status a "save reply and set pending" send moves the ticket to. */
const PENDING_CLIENT: TicketStatus = "PENDING_CLIENT";

/**
 * Extra field the pending-client variant carries. `PublicReplyInput` deliberately has no `version`
 * (appending a comment never conflicts with a field edit) — but this variant ALSO changes the
 * ticket's status, and a status change takes the optimistic-concurrency token like every other one.
 */
type PublicReplyPendingInput = PublicReplyInput & { version: number };

/** `addPublicReply`'s result, widened with what happened to the outbound delivery. */
type PublicReplyResult = CommentActionResult & {
  /** True when a MessageDelivery row was written for this reply. */
  deliveryQueued: boolean;
  deliveryId: string | null;
};

/** `addPublicReplyAndSetPending`'s result: the reply plus the ticket's new status and version token. */
type PublicReplyPendingResult = PublicReplyResult & { status: TicketStatus; version: number };

const pendingVersionSchema = z.object({ version: z.number().int().min(1) });

const TICKET_FOR_COMMENT_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  version: true,
  brand: true,
  requesterEmail: true,
  queueId: true,
  queue: { select: { key: true } },
} as const;

async function loadTicketForComment(ticketId: string): Promise<TicketForComment> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: TICKET_FOR_COMMENT_SELECT,
  });
  if (!ticket) throw new NotFoundError("Ticket not found");
  return ticket;
}

/** A macro may be applied only when active, on the matching channel, and global or bound to the ticket's queue. */
async function resolveMacro(
  macroId: string | undefined,
  channel: CommentVisibility,
  ticketQueueId: string,
): Promise<ResolvedMacro | null> {
  if (macroId === undefined) return null;
  const macro = await prisma.macro.findUnique({
    where: { id: macroId },
    select: { id: true, key: true, isActive: true, channel: true, queueId: true },
  });
  const usable =
    macro !== null &&
    macro.isActive &&
    macro.channel === channel &&
    (macro.queueId === null || macro.queueId === ticketQueueId);
  if (!usable) {
    throw new ValidationError("Macro is not available for this ticket", {
      macroId: ["This macro is inactive, on a different channel, or belongs to another queue"],
    });
  }
  return { id: macro.id, key: macro.key };
}

/**
 * Why a guarded ticket write matched no row. The guard pins (id, queue, not-CLOSED) and, for the
 * pending variant, the version token; this re-read turns count 0 into the accurate error instead of
 * always blaming the closed case.
 */
async function explainGuardMiss(tx: DbTx, ticket: TicketForComment, pinnedVersion: number | null): Promise<never> {
  const current = await tx.ticket.findUnique({
    where: { id: ticket.id },
    select: { status: true, queueId: true, version: true },
  });
  if (!current) throw new NotFoundError("Ticket not found");
  if (current.status === "CLOSED") throw new ValidationError("ticket is closed");
  if (current.queueId !== ticket.queueId) throw new ValidationError("ticket moved to another queue");
  if (pinnedVersion !== null && current.version !== pinnedVersion) throw new ConflictError();
  throw new ConflictError();
}

export async function addInternalNote(input: CommentBodyInput): Promise<ActionResult<CommentActionResult>> {
  return runAction("addInternalNote", async (viewer, ctx) => {
    const parsed = commentBodySchema.parse(input);
    const ticket = await loadTicketForComment(parsed.ticketId);
    assertCan(canComment(viewer.groups, ticket.queue.key, "INTERNAL"), "comment:internal", ticket.id);
    // No assertTicketNotClosed here: internal notes are allowed on CLOSED tickets.
    const macro = await resolveMacro(parsed.macroId, "INTERNAL", ticket.queueId);
    const sanitized = sanitizePII(parsed.body);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      // Atomic queue re-check. CLOSED is allowed for internal notes, so this guard does
      // NOT constrain status — but it does verify the ticket is still in the queue the RBAC check was based on
      // and takes the row lock, so a concurrent `moveTicketQueue` cannot land this note on a queue the author
      // can no longer read. A concurrent field edit leaves queueId unchanged, so a note still never conflicts
      // with an edit. It also carries the single version bump; count 0 → refuse.
      const guard = await tx.ticket.updateMany({
        where: { id: ticket.id, queueId: ticket.queueId },
        data: {
          version: { increment: 1 },
          ...(sanitized.redacted ? { piiRedacted: true, piiRedactionCount: { increment: sanitized.count } } : {}),
        },
      });
      if (guard.count === 0) throw new ValidationError("ticket moved to another queue");

      const comment = await tx.comment.create({
        data: {
          ticketId: ticket.id,
          authorId: viewer.id,
          visibility: "INTERNAL",
          body: sanitized.text,
          disclaimerKey: "NONE",
          macroId: macro?.id ?? null,
          piiRedacted: sanitized.redacted,
          piiRedactionCount: sanitized.count,
        },
        select: { id: true },
      });

      const entries: AuditEntry[] = [
        {
          action: "COMMENT_ADDED_INTERNAL",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: sanitized.text,
        },
      ];
      if (macro) {
        entries.push({
          action: "MACRO_APPLIED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "macroId",
          oldValue: null,
          newValue: macro.key,
        });
      }
      if (sanitized.redacted) {
        entries.push({
          action: "PII_REDACTED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: formatPiiCounts(sanitized.byKind),
        });
      }
      // Wave B. Macro actions are applied atomically with the comment; the draft that produced it is
      // cleared in the same transaction; followers and @mentions are notified from the same place.
      // Each returns its AuditEntry[] so `writeAuditMany` stays the last statement (§3 rule 2).
      if (macro) {
        const applied = await applyMacroActions(tx, { ticketId: ticket.id, macroId: macro.id, viewerId: viewer.id });
        entries.push(...applied.auditEntries);
      }
      await clearDraft(tx, { ticketId: ticket.id, userId: viewer.id, channel: "INTERNAL" });
      const notifiedInternal = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: ticket.id,
        commentId: comment.id,
        preview: "Internal note added",
        actorId: viewer.id,
      });
      entries.push(...notifiedInternal.auditEntries);

      await writeAuditMany(tx, actor, ctx, entries);

      const out: CommentActionResult = {
        id: comment.id,
        piiRedacted: sanitized.redacted,
        piiRedactionCount: sanitized.count,
        firstResponseStamped: false,
      };
      return out;
    });

    return result;
  });
}

/**
 * The one body both public-reply actions run. `pendingVersion` null = the plain reply (no status change,
 * NEW auto-opens); a number = "save reply and set Pending client" (version-pinned, status set in the
 * SAME transaction and audited as an ordinary TICKET_STATUS_CHANGED).
 */
async function writePublicReply(
  viewer: Viewer,
  ctx: RequestContext,
  parsed: PublicReplyInput,
  pendingVersion: number | null,
): Promise<PublicReplyPendingResult> {
  // Defense in depth behind the schema: a public reply without an acknowledged disclaimer never persists.
  if (parsed.disclaimerKey === "NONE" || parsed.disclaimerAcknowledged !== true) {
    throw new ValidationError("A public reply requires an acknowledged disclaimer", {
      disclaimerKey: ["Select a disclaimer and confirm it will be appended"],
    });
  }
  const ticket = await loadTicketForComment(parsed.ticketId);
  assertCan(canComment(viewer.groups, ticket.queue.key, "PUBLIC"), "comment:public", ticket.id);
  assertTicketNotClosed(ticket);
  const macro = await resolveMacro(parsed.macroId, "PUBLIC", ticket.queueId);

  // The pending variant is a status change as well as a comment: it obeys the state machine and the
  // optimistic-concurrency token exactly like `changeTicketStatus` does.
  const setsPending = pendingVersion !== null && ticket.status !== PENDING_CLIENT;
  if (pendingVersion !== null) {
    if (ticket.version !== pendingVersion) throw new ConflictError();
    if (setsPending && !canTransition(ticket.status, PENDING_CLIENT)) {
      throw new ValidationError(`cannot change status from ${ticket.status} to ${PENDING_CLIENT}`, {
        status: [`${ticket.status} → ${PENDING_CLIENT} is not an allowed transition`],
      });
    }
  }

  // Sanitize BEFORE appending the disclaimer: the disclaimer text is code, never a redaction target.
  const sanitized = sanitizePII(parsed.body);
  const stored = appendDisclaimer(sanitized.text, parsed.disclaimerKey);
  const disclaimerKey = parsed.disclaimerKey;
  const actor = actorFromViewer(viewer);

  return withTx(async (tx) => {
    // Atomic CLOSED / queue re-check. The pre-tx `assertTicketNotClosed` above is a fast
    // path; this conditional updateMany is the race backstop. Under READ COMMITTED it is evaluated at write
    // time and takes a row lock held until commit, so a `changeTicketStatus`→CLOSED or `moveTicketQueue`
    // that commits between the load and here can no longer let a PUBLIC reply (client-visible) or a
    // first-response stamp land on a closed or moved-away ticket. It also carries the single version bump
    // that the trailing unconditional update used to make; count 0 means the ticket changed → refuse.
    //
    // The pending variant additionally pins the version AND the status it read, and carries the status
    // change in this same statement — so the reply, the status and the version move together or not at all.
    const guard = await tx.ticket.updateMany({
      where: {
        id: ticket.id,
        status: pendingVersion === null ? { not: "CLOSED" } : ticket.status,
        queueId: ticket.queueId,
        ...(pendingVersion === null ? {} : { version: pendingVersion }),
      },
      data: {
        version: { increment: 1 },
        ...(setsPending ? { status: PENDING_CLIENT } : {}),
        ...(sanitized.redacted ? { piiRedacted: true, piiRedactionCount: { increment: sanitized.count } } : {}),
      },
    });
    if (guard.count === 0) await explainGuardMiss(tx, ticket, pendingVersion);

    const comment = await tx.comment.create({
      data: {
        ticketId: ticket.id,
        authorId: viewer.id,
        visibility: "PUBLIC",
        body: stored,
        disclaimerKey,
        macroId: macro?.id ?? null,
        piiRedacted: sanitized.redacted,
        piiRedactionCount: sanitized.count,
      },
      select: { id: true, createdAt: true },
    });

    // Outbound delivery: same transaction, audit entry returned rather than written.
    //
    // The delivery ADDRESS, brand, subject and number are re-read HERE rather than taken from the
    // pre-transaction `ticket` snapshot. The guard above pins `queueId` and the status, but it does not
    // pin `requesterEmail` — and that column is exactly what `changeRequesterEmail` re-points. A
    // redirect committing between `loadTicketForComment` and this statement would otherwise send the
    // reply to the OLD address while the ticket, and every later reply, belong to the new one. The
    // guard's row lock is held until commit, so this read sees the committed truth and cannot race it.
    // The other three fields are re-read from the same row for the same reason: a subject or brand edit
    // in that window would render the email against a state the ticket no longer has.
    const forDelivery = await tx.ticket.findUnique({
      where: { id: ticket.id },
      select: { requesterEmail: true, brand: true, subject: true, number: true },
    });

    // A ticket opened from a voicemail has a phone and no address; the reply is still a
    // record of what the desk said, so it is written — there is simply nothing to deliver it to, and the
    // comment carries no delivery chip. Recommended default, pending confirmation (integration notes).
    const deliverableTo = forDelivery?.requesterEmail?.trim() ?? "";
    let deliveryId: string | null = null;
    let deliveryEntry: AuditEntry | null = null;
    if (forDelivery !== null && deliverableTo.length > 0) {
      const queued = await enqueueDelivery(tx, {
        ticketId: ticket.id,
        ticketNumber: forDelivery.number,
        brand: forDelivery.brand,
        toAddress: deliverableTo,
        subject: forDelivery.subject,
        commentId: comment.id,
        body: stored,
      });
      deliveryId = queued.deliveryId;
      deliveryEntry = queued.auditEntry;
    }

    // Conditional side effects: no read-then-write, exactly one stamp under concurrency. The guard
    // above already holds the row lock open, so `status: { not: "CLOSED" }` here is defense in depth.
    const stamp = await tx.ticket.updateMany({
      where: { id: ticket.id, firstRespondedAt: null, status: { not: "CLOSED" } },
      data: { firstRespondedAt: comment.createdAt },
    });
    const firstResponseStamped = stamp.count === 1;

    // The plain reply auto-opens a NEW ticket. The pending variant already moved NEW → PENDING_CLIENT in
    // the guard, so there is nothing left to open and this write is skipped rather than fighting it.
    let autoOpened = false;
    if (pendingVersion === null) {
      const opened = await tx.ticket.updateMany({ where: { id: ticket.id, status: "NEW" }, data: { status: "OPEN" } });
      autoOpened = opened.count === 1;
    }

    const entries: AuditEntry[] = [
      {
        action: "COMMENT_ADDED_PUBLIC",
        entityType: "COMMENT",
        entityId: comment.id,
        ticketId: ticket.id,
        fieldChanged: "body",
        oldValue: null,
        newValue: stored,
        metadata: { disclaimerKey },
      },
    ];
    if (deliveryEntry) entries.push(deliveryEntry);
    if (macro) {
      entries.push({
        action: "MACRO_APPLIED",
        entityType: "COMMENT",
        entityId: comment.id,
        ticketId: ticket.id,
        fieldChanged: "macroId",
        oldValue: null,
        newValue: macro.key,
      });
    }
    if (sanitized.redacted) {
      entries.push({
        action: "PII_REDACTED",
        entityType: "COMMENT",
        entityId: comment.id,
        ticketId: ticket.id,
        fieldChanged: "body",
        oldValue: null,
        newValue: formatPiiCounts(sanitized.byKind),
      });
    }
    if (firstResponseStamped) {
      entries.push({
        action: "TICKET_FIELD_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "firstRespondedAt",
        oldValue: null,
        newValue: comment.createdAt.toISOString(),
      });
    }
    if (autoOpened) {
      entries.push({
        action: "TICKET_STATUS_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "status",
        oldValue: "NEW",
        newValue: "OPEN",
      });
    }
    if (setsPending) {
      entries.push({
        action: "TICKET_STATUS_CHANGED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: "status",
        oldValue: ticket.status,
        newValue: PENDING_CLIENT,
      });
    }
    // same three hooks as `addInternalNote`, same reasons (see there).
    if (macro) {
      const applied = await applyMacroActions(tx, { ticketId: ticket.id, macroId: macro.id, viewerId: viewer.id });
      entries.push(...applied.auditEntries);
    }
    await clearDraft(tx, { ticketId: ticket.id, userId: viewer.id, channel: "PUBLIC" });
    const notifiedPublic = await notifyFromEvent(tx, {
      kind: "FOLLOWED_UPDATE",
      ticketId: ticket.id,
      commentId: comment.id,
      // NOT "sent": nothing has been transmitted at this point (see the comment below), the reply may
      // still be CANCELLED by a retraction or FAILED_SUPPRESSED, and a phone-only ticket is never
      // emailed at all — while a `Notification` row is permanent, so the claim would
      // outlive the delivery it describes. The `DeliveryChip` is the only surface that may print
      // "Sent" (CROSSWALK P16). This wording matches
      // `ACTION_LABELS.COMMENT_ADDED_PUBLIC` and sits beside "Internal note added" above.
      preview: "Public reply added",
      actorId: viewer.id,
    });
    entries.push(...notifiedPublic.auditEntries);

    await writeAuditMany(tx, actor, ctx, entries);

    const status: TicketStatus =
      pendingVersion !== null ? PENDING_CLIENT : autoOpened ? "OPEN" : ticket.status;
    return {
      id: comment.id,
      piiRedacted: sanitized.redacted,
      piiRedactionCount: sanitized.count,
      firstResponseStamped,
      deliveryQueued: deliveryId !== null,
      deliveryId,
      status,
      version: ticket.version + 1,
    };
  });
}

/**
 * Saves a client-facing reply to the ticket and queues its delivery. Nothing is transmitted here — the
 * UI says "Queued" until a poller reports a result, which is why the button says "Save reply to ticket"
 * and not "Send" (composer copy).
 */
export async function addPublicReply(input: PublicReplyInput): Promise<ActionResult<PublicReplyResult>> {
  return runAction("addPublicReply", async (viewer, ctx) => {
    // Schema enforces disclaimerKey !== "NONE" and disclaimerAcknowledged === true.
    const parsed = publicReplySchema.parse(input);
    const result = await writePublicReply(viewer, ctx, parsed, null);
    return {
      id: result.id,
      piiRedacted: result.piiRedacted,
      piiRedactionCount: result.piiRedactionCount,
      firstResponseStamped: result.firstResponseStamped,
      deliveryQueued: result.deliveryQueued,
      deliveryId: result.deliveryId,
    };
  });
}

/**
 * The same reply, plus "the ball is with the client": the ticket moves to PENDING_CLIENT in the SAME
 * transaction as the comment, the delivery row and the audit rows. Audited as today's
 * `TICKET_STATUS_CHANGED`, not a new action — it is an ordinary status change that happens to be
 * triggered from the composer.
 *
 * CONTRACT-GAP: §10 S3 fixes the button copy but gives no signature for this action, and
 * `PublicReplyInput` carries no version. This is the closest faithful version: the same input plus the
 * optimistic-concurrency token every status change already requires. Recorded in the integration notes.
 */
export async function addPublicReplyAndSetPending(
  input: PublicReplyPendingInput,
): Promise<ActionResult<PublicReplyPendingResult>> {
  return runAction("addPublicReplyAndSetPending", async (viewer, ctx) => {
    const parsed = publicReplySchema.parse(input);
    const { version } = pendingVersionSchema.parse({ version: input.version });
    return writePublicReply(viewer, ctx, parsed, version);
  });
}
