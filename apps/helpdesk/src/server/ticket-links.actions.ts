"use server";

/**
 * Link and merge — `"use server"`, node, layer L4.
 *
 * Every export goes through `runAction` and the Wave A pipeline: zod → load → RBAC → one Prisma
 * transaction that mutates AND writes its `AuditLog` rows, with `writeAuditMany` as the last statement.
 *
 * `links:write` is checked on **both** tickets. A link is a statement about two records,
 * and a viewer who may write one queue must not be able to attach a ticket in a queue they may not
 * write — or, worse, learn that one exists there by watching the error change.
 *
 * `mergeTickets` NEVER MOVES COMMENTS. The loser keeps its number, its comments and its ledger and
 * points at the survivor; the link is how a reader gets from one to the other. Moving comments would
 * rewrite two tickets' histories at once, and the second one belongs to a client who was never told.
 *
 * The duplicate-candidate read lives here too, because `src/server/duplicates.ts` is a plain module and
 * B11's new-ticket form is a client component that may not import one.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type {
  ActionResult,
  AddTicketLinkInput,
  AuditEntry,
  DuplicateCandidateDTO,
  MergeTicketsInput,
  OktaGroup,
  QueueKey,
  RemoveTicketLinkInput,
  TicketLinkKind,
  TicketStatus,
} from "@/types/domain";
import { TICKET_LINK_KINDS, WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatPiiCounts, sanitizePII } from "@/lib/pii";
import { assertCan, canWriteLinks, readableQueues } from "@/lib/rbac";
import { canTransition } from "@/lib/ticket-policy";
import { runAction } from "@/server/action-utils";
import { findDuplicateCandidates, findDuplicateCandidatesFor } from "@/server/duplicates";
import { assertIdentityGate } from "@/server/identity-gate";
import { notifyFromEvent } from "@/server/notifications";
import { maybeSendResolvedNotice } from "@/server/system-messages";
import {
  LINK_NOTE_MAX_CHARS,
  MANUAL_LINK_KINDS,
  countLiveLinks,
  describeDisallowedUrls,
  disallowedNoteUrls,
} from "@/server/ticket-links";
import { assertTicketNotClosed } from "@/server/tickets";

// ---------------------------------------------------------------------------
// Validation (module-private: a "use server" file exports async functions only)
// ---------------------------------------------------------------------------

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
const ticketNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const noteSchema = z.string().trim().max(LINK_NOTE_MAX_CHARS).optional();

const addTicketLinkSchema: z.ZodType<AddTicketLinkInput, unknown> = z.object({
  ticketId: idSchema,
  otherTicketNumber: ticketNumberSchema,
  kind: z.enum(TICKET_LINK_KINDS),
  note: noteSchema,
});

const removeTicketLinkSchema: z.ZodType<RemoveTicketLinkInput, unknown> = z.object({ linkId: idSchema });

const reasonSchema = z
  .string()
  .trim()
  .min(WAVE_B_LIMITS.reasonMinChars, `Say why, in at least ${WAVE_B_LIMITS.reasonMinChars} characters`)
  .max(WAVE_B_LIMITS.reasonMaxChars);

const mergeTicketsSchema: z.ZodType<MergeTicketsInput, unknown> = z.object({
  ticketId: idSchema,
  version: z.number().int().min(1),
  intoTicketNumber: ticketNumberSchema,
  reason: reasonSchema,
});

const draftSchema = z.object({
  requesterEmail: z.string().trim().max(320).nullish(),
  requesterPhone: z.string().trim().max(32).nullish(),
  subject: z.string().trim().max(500),
  externalRef: z.string().trim().max(200).nullish(),
});

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

const LINK_TICKET_INCLUDE = {
  queue: { select: { id: true, key: true } },
} as const;

type LinkTicket = {
  id: string;
  number: number;
  status: TicketStatus;
  version: number;
  mergedIntoId: string | null;
  queue: { id: string; key: QueueKey };
};

async function loadTicketById(tx: DbTx, ticketId: string): Promise<LinkTicket> {
  const t = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, number: true, status: true, version: true, mergedIntoId: true, ...LINK_TICKET_INCLUDE },
  });
  if (!t) throw new NotFoundError("ticket not found");
  return t;
}

/**
 * The OTHER ticket, by its WM number, scoped to the queues the viewer may READ.
 *
 * Scoping the LOOKUP (not only the write check) is what stops the number box becoming an existence
 * oracle: `getTicketIdByNumber` makes the same argument, for the same reason.
 */
async function loadTicketByNumber(tx: DbTx, number: number, groups: readonly OktaGroup[]): Promise<LinkTicket> {
  const queues = readableQueues(groups);
  if (queues.length === 0) throw new NotFoundError(`HD-${number} was not found`);
  const t = await tx.ticket.findFirst({
    where: { number, queue: { key: { in: queues } } },
    select: { id: true, number: true, status: true, version: true, mergedIntoId: true, ...LINK_TICKET_INCLUDE },
  });
  if (!t) throw new NotFoundError(`HD-${number} was not found`);
  return t;
}

function linkEntry(
  link: { id: string; kind: TicketLinkKind },
  ticketId: string,
  action: "TICKET_LINK_ADDED" | "TICKET_LINK_REMOVED",
  toTicketNumber: number,
): AuditEntry {
  return {
    action,
    entityType: "TICKET_LINK",
    entityId: link.id,
    ticketId,
    fieldChanged: "kind",
    oldValue: action === "TICKET_LINK_REMOVED" ? link.kind : null,
    newValue: action === "TICKET_LINK_REMOVED" ? null : link.kind,
    metadata: { toTicketNumber },
  };
}

function ticketEntry(ticketId: string, entry: Omit<AuditEntry, "entityType" | "entityId" | "ticketId">): AuditEntry {
  return { entityType: "TICKET", entityId: ticketId, ticketId, ...entry };
}

/** The version-guarded ticket update every mutation here uses. */
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Link this ticket to another by WM number.
 *
 * A previously removed link of the same (from, to, kind) is REVIVED rather than duplicated — the table
 * has a unique index on that triple and no DELETE privilege, so a second insert would fail and a
 * second row would be a lie about how many links exist. The revival writes a fresh
 * `TICKET_LINK_ADDED`, so the ledger reads add → remove → add, which is what happened.
 */
export async function addTicketLink(input: AddTicketLinkInput): Promise<ActionResult<{ id: string }>> {
  return runAction("addTicketLink", async (viewer, ctx) => {
    const data = addTicketLinkSchema.parse(input);
    const actor = actorFromViewer(viewer);

    if (!(MANUAL_LINK_KINDS as readonly TicketLinkKind[]).includes(data.kind)) {
      throw new ValidationError("that link kind is not created by hand", {
        kind: ['Use "Mark as duplicate" — it sets the resolution and the link together.'],
      });
    }

    const bad = disallowedNoteUrls(data.kind, data.note);
    if (bad.length > 0) throw new ValidationError(describeDisallowedUrls(bad), { note: [describeDisallowedUrls(bad)] });

    return withTx(async (tx) => {
      const from = await loadTicketById(tx, data.ticketId);
      const to = await loadTicketByNumber(tx, data.otherTicketNumber, viewer.groups);
      if (from.id === to.id) {
        throw new ValidationError("a ticket cannot be linked to itself", { otherTicketNumber: ["Pick a different ticket"] });
      }

      assertCan(canWriteLinks(viewer.groups, from.queue.key), "links:write", from.id);
      assertCan(canWriteLinks(viewer.groups, to.queue.key), "links:write", to.id);
      // The ticket being written is the FROM side. The other end may be closed or voided: linking a live
      // ticket to the closed one it follows on from is exactly what the panel is for.
      assertTicketNotClosed(from);

      const live = await countLiveLinks(tx, from.id);
      if (live >= WAVE_B_LIMITS.maxLinksPerTicket) {
        throw new ValidationError(`a ticket may carry ${WAVE_B_LIMITS.maxLinksPerTicket} links`, {
          _form: [`This ticket already has ${live} links. Remove one first.`],
        });
      }

      const sanitized = data.note === undefined || data.note.length === 0 ? null : sanitizePII(data.note);
      const note = sanitized === null ? null : sanitized.text;

      const existing = await tx.ticketLink.findUnique({
        where: { fromTicketId_toTicketId_kind: { fromTicketId: from.id, toTicketId: to.id, kind: data.kind } },
        select: { id: true, removedAt: true },
      });

      let linkId: string;
      if (existing === null) {
        const created = await tx.ticketLink.create({
          data: { fromTicketId: from.id, toTicketId: to.id, kind: data.kind, note, createdById: viewer.id },
          select: { id: true },
        });
        linkId = created.id;
      } else {
        if (existing.removedAt === null) {
          throw new ValidationError("these tickets are already linked that way", {
            otherTicketNumber: [`HD-${to.number} is already linked to this ticket.`],
          });
        }
        await tx.ticketLink.update({
          where: { id: existing.id },
          data: { removedAt: null, removedById: null, note, createdById: viewer.id, createdAt: new Date() },
        });
        linkId = existing.id;
      }

      const entries: AuditEntry[] = [linkEntry({ id: linkId, kind: data.kind }, from.id, "TICKET_LINK_ADDED", to.number)];
      if (sanitized?.redacted) {
        entries.push({
          action: "PII_REDACTED",
          entityType: "TICKET_LINK",
          entityId: linkId,
          ticketId: from.id,
          fieldChanged: "note",
          oldValue: null,
          newValue: formatPiiCounts(sanitized.byKind),
        });
      }
      await writeAuditMany(tx, actor, ctx, entries);
      return { id: linkId };
    });
  });
}

/**
 * Take a link off both tickets. SOFT remove — `removedAt` + `removedById` — because
 * `TICKET_LINK_ADDED` and `TICKET_LINK_REMOVED` both point at the row, and a deleted row leaves the
 * pair unreadable. Re-removing an already-removed link is accepted and writes NOTHING: there was no
 * transition, and an audit row for a state that did not change is noise in an evidentiary ledger.
 */
export async function removeTicketLink(input: RemoveTicketLinkInput): Promise<ActionResult<{ id: string }>> {
  return runAction("removeTicketLink", async (viewer, ctx) => {
    const data = removeTicketLinkSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const link = await tx.ticketLink.findUnique({
        where: { id: data.linkId },
        select: {
          id: true,
          kind: true,
          removedAt: true,
          fromTicketId: true,
          toTicketId: true,
          fromTicket: { select: { id: true, number: true, status: true, queue: { select: { key: true } } } },
          toTicket: { select: { id: true, number: true, status: true, queue: { select: { key: true } } } },
        },
      });
      if (!link) throw new NotFoundError("link not found");

      assertCan(canWriteLinks(viewer.groups, link.fromTicket.queue.key), "links:write", link.fromTicketId);
      assertCan(canWriteLinks(viewer.groups, link.toTicket.queue.key), "links:write", link.toTicketId);

      if (link.removedAt !== null) return { id: link.id };

      await tx.ticketLink.update({
        where: { id: link.id },
        data: { removedAt: new Date(), removedById: viewer.id },
      });

      await writeAuditMany(tx, actor, ctx, [
        linkEntry(link, link.fromTicketId, "TICKET_LINK_REMOVED", link.toTicket.number),
      ]);
      return { id: link.id };
    });
  });
}

/**
 * Mark this ticket a duplicate of another.
 *
 * ONE transaction: `mergedIntoId` + `mergedAt` + `resolution: DUPLICATE` + the status move to RESOLVED
 * + a `DUPLICATE_OF` link + `TICKET_MERGED` + the follower notifications B1's core returns.
 *
 * ONE link row, not two. `TicketLink` is directional and `TICKET_LINK_INVERSE_LABELS` is how the same
 * row reads from the other end — "Duplicate of HD-9" on the loser, "Has duplicate HD-12" on the
 * survivor. A second row pointing the other way would assert that the SURVIVOR is a duplicate, which
 * is the opposite of what happened.
 *
 * The client's resolved notice fires here too, for the same reason and on the same edge: this IS a
 * transition into RESOLVED, and every other path into RESOLVED sends it.
 *
 * The identity gate runs, because this IS a transition into RESOLVED. A money-movement
 * ticket therefore cannot be closed out as a duplicate without a verification or an audited override —
 * the same bar as answering it, on purpose: "it was a duplicate" is the easiest thing to say about a
 * wire request an impostor sent twice.
 */
export async function mergeTickets(
  input: MergeTicketsInput,
): Promise<ActionResult<{ version: number; intoTicketId: string }>> {
  return runAction("mergeTickets", async (viewer, ctx) => {
    const data = mergeTicketsSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const loser = await tx.ticket.findUnique({
        where: { id: data.ticketId },
        select: {
          id: true,
          number: true,
          status: true,
          version: true,
          category: true,
          resolution: true,
          mergedIntoId: true,
          resolvedAt: true,
          queue: { select: { id: true, key: true } },
        },
      });
      if (!loser) throw new NotFoundError("ticket not found");
      const survivor = await loadTicketByNumber(tx, data.intoTicketNumber, viewer.groups);

      assertCan(canWriteLinks(viewer.groups, loser.queue.key), "links:write", loser.id);
      assertCan(canWriteLinks(viewer.groups, survivor.queue.key), "links:write", survivor.id);
      assertTicketNotClosed(loser);

      if (loser.id === survivor.id) {
        throw new ValidationError("a ticket cannot be a duplicate of itself", {
          intoTicketNumber: ["Pick a different ticket"],
        });
      }
      if (loser.mergedIntoId !== null) {
        throw new ValidationError("this ticket has already been merged", {
          _form: ["It already points at another ticket. Open that one instead."],
        });
      }
      if (survivor.mergedIntoId === loser.id) {
        throw new ValidationError("that ticket is already a duplicate of this one", {
          intoTicketNumber: [`HD-${survivor.number} points here. Merging back would make a loop.`],
        });
      }
      if (survivor.status === "VOIDED") {
        throw new ValidationError("that ticket was voided", {
          intoTicketNumber: [`HD-${survivor.number} was entered in error, so nothing should point at it.`],
        });
      }

      const sanitized = sanitizePII(data.reason);
      const reason = sanitized.text.trim();
      if (reason.length < WAVE_B_LIMITS.reasonMinChars) {
        throw new ValidationError("say why these are the same request", {
          reason: [`At least ${WAVE_B_LIMITS.reasonMinChars} characters, after redaction.`],
        });
      }

      const becomesResolved = loser.status !== "RESOLVED";
      if (becomesResolved && !canTransition(loser.status, "RESOLVED")) {
        throw new ValidationError(`cannot resolve a ticket from ${loser.status}`, {
          _form: [`${loser.status} → RESOLVED is not an allowed transition.`],
        });
      }
      // Decision #103. Merging is a way of finishing a ticket, so the gate applies exactly as it does
      // to any other RESOLVED transition. Throws ValidationError; B6's override is the escape hatch.
      await assertIdentityGate(tx, { ticketId: loser.id, category: loser.category });

      const now = new Date();
      await guardedUpdate(tx, loser.id, data.version, {
        mergedIntoId: survivor.id,
        mergedAt: now,
        resolution: "DUPLICATE",
        ...(becomesResolved ? { status: "RESOLVED", resolvedAt: now } : {}),
      });

      const existing = await tx.ticketLink.findUnique({
        where: {
          fromTicketId_toTicketId_kind: { fromTicketId: loser.id, toTicketId: survivor.id, kind: "DUPLICATE_OF" },
        },
        select: { id: true, removedAt: true },
      });
      let linkId: string;
      if (existing === null) {
        const created = await tx.ticketLink.create({
          data: {
            fromTicketId: loser.id,
            toTicketId: survivor.id,
            kind: "DUPLICATE_OF",
            note: reason,
            createdById: viewer.id,
          },
          select: { id: true },
        });
        linkId = created.id;
      } else {
        await tx.ticketLink.update({
          where: { id: existing.id },
          data: { removedAt: null, removedById: null, note: reason, createdById: viewer.id, createdAt: now },
        });
        linkId = existing.id;
      }

      const entries: AuditEntry[] = [
        ticketEntry(loser.id, {
          action: "TICKET_MERGED",
          fieldChanged: "mergedIntoId",
          oldValue: null,
          newValue: survivor.id,
          metadata: { intoTicketNumber: survivor.number, reason },
        }),
        linkEntry({ id: linkId, kind: "DUPLICATE_OF" }, loser.id, "TICKET_LINK_ADDED", survivor.number),
        ticketEntry(loser.id, {
          action: "TICKET_FIELD_CHANGED",
          fieldChanged: "resolution",
          oldValue: loser.resolution,
          newValue: "DUPLICATE",
        }),
      ];
      if (becomesResolved) {
        entries.push(
          ticketEntry(loser.id, {
            action: "TICKET_STATUS_CHANGED",
            fieldChanged: "status",
            oldValue: loser.status,
            newValue: "RESOLVED",
          }),
        );
      }
      if (sanitized.redacted) {
        entries.push(
          ticketEntry(loser.id, {
            action: "PII_REDACTED",
            fieldChanged: "reason",
            oldValue: null,
            newValue: formatPiiCounts(sanitized.byKind),
          }),
        );
      }

      // Fix round 2. The RESOLVED side-effects belong to the TRANSITION, not to the control that
      // caused it. `changeTicketStatus`, the bulk status change and `applyMacroActions` all send the
      // client's resolved notice; leaving it out here made Mark as duplicate the ONE remaining path
      // into RESOLVED that told the client nothing — two tickets resolved on the same day carried
      // different correspondence histories depending only on which control the operator reached for.
      // The same reasoning already puts the identity gate on this edge above: merging
      // IS a real resolve, and a duplicate the client raised is still a request they are waiting on.
      // Only on `becomesResolved`: a ticket already in RESOLVED is not transitioning, and re-sending
      // a notice because somebody tidied up the link afterwards would be news about nothing.
      // Runs INSIDE this transaction and its entries join the array `writeAuditMany` writes last
      // (CONTRACT §3 rule 2). A no-op — null, nothing written, nothing transmitted — while
      // `RESOLVED_NOTICE_ENABLED` is unset, which it is everywhere today.
      if (becomesResolved) {
        const notice = await maybeSendResolvedNotice(tx, { ticketId: loser.id, ticketNumber: loser.number });
        if (notice) entries.push(...notice.auditEntries);
      }

      // PII-light preview: numbers only, never a subject.
      const notified = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: loser.id,
        preview: `Merged into HD-${survivor.number} as a duplicate`,
        actorId: viewer.id,
      });
      entries.push(...notified.auditEntries);

      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, intoTicketId: survivor.id };
    });
  });
}

/**
 * Possible duplicates, for a surface that cannot import `@/server/duplicates` itself: B11's new-ticket
 * form (a client component) and any client control that wants to re-score after an edit.
 *
 * Pass `ticketId` for an existing ticket, or the three draft fields for a form that has not saved yet.
 * A read of list rows: no audit row, scoped to the viewer's readable queues inside the module.
 */
export async function duplicateCandidates(
  input: { ticketId: string } | { draft: z.infer<typeof draftSchema>; excludeTicketId?: string },
): Promise<ActionResult<DuplicateCandidateDTO[]>> {
  return runAction("duplicateCandidates", async (viewer) => {
    if ("ticketId" in input) {
      const ticketId = idSchema.parse(input.ticketId);
      return findDuplicateCandidates(viewer, ticketId);
    }
    const draft = draftSchema.parse(input.draft);
    const exclude = input.excludeTicketId === undefined ? undefined : idSchema.parse(input.excludeTicketId);
    return findDuplicateCandidatesFor(
      viewer,
      {
        requesterEmail: draft.requesterEmail ?? null,
        requesterPhone: draft.requesterPhone ?? null,
        subject: draft.subject,
        externalRef: draft.externalRef ?? null,
        createdAt: new Date(),
      },
      exclude ?? null,
    );
  });
}
