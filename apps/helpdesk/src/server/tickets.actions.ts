"use server";

/**
 * Ticket mutations — `"use server"`, node, layer L4.
 *
 * Every export is wrapped by `runAction` and follows one pipeline:
 *   zod → load ticket → RBAC (`assertCan`) → `assertTicketNotClosed` → sanitize → `withTx` (writes, then
 *   `writeAuditMany` as the LAST statement) → return the minimal result.
 * Field mutations are optimistic-concurrency checked with `updateMany({ where: { id, version } })`;
 * count 0 → ConflictError → `{ code: "CONFLICT" }`.
 *
 * No `revalidatePath` / `next/cache` here: every (app) page is force-dynamic and nothing uses
 * the Data Cache, so there is nothing to invalidate — and a revalidation inside an action makes Next re-render
 * the current page inside the action response, which on the ticket detail page is a second audited
 * TICKET_VIEWED per human mutation. The UI's single `router.refresh()` is the one audited re-render.
 */
import type { Prisma } from "@prisma/client";
import type {
  ActionResult,
  AssignTicketInput,
  AssignToMeInput,
  AuditEntry,
  ChangePriorityInput,
  ChangeStatusInput,
  CreateTicketInput,
  MoveQueueInput,
  QueueKey,
  RecordClientContactInput,
  TicketPriority,
  TicketResolution,
  TicketSource,
  TicketStatus,
  UpdateTicketFieldsInput,
  UserRef,
} from "@/types/domain";
import { REQUESTER_AUTHORED_SOURCES, RESOLUTION_BEARING_STATUSES, isOperatorResolution } from "@/types/domain";
import { actorFromViewer, diffFields, writeAuditMany } from "@/lib/audit";
// --- Wave B call-site hooks. Each is a FOUNDATION STUB with a no-op default, owned by the slice named
// in its own module docstring, so the hook sits in the right transaction from the first commit and the
// slice never has to reopen a mutation path. See the build record ---
import { assertIdentityGate } from "@/server/identity-gate";
import { notifyFromEvent } from "@/server/notifications";
import { maybeSendResolvedNotice } from "@/server/system-messages";
import type { DbTx } from "@/lib/db";
import { withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { allowedRequesterDomains, env } from "@/lib/env";
import { isRequesterDomainAllowed } from "@/lib/requester-guard";
import { STATUS_LABELS } from "@/lib/format";
import { formatPiiCounts, sanitizeFields, sanitizePII } from "@/lib/pii";
import { assertCan, canChangeRequesterEmail, canCreateTicket, canMoveTicket, canWriteQueue } from "@/lib/rbac";
import { routeCategory } from "@/lib/routing";
import { safeEqualEmails } from "@/lib/safe-equal";
import { computeDueDates, slaPolicyFor } from "@/lib/sla";
import { canTransition } from "@/lib/ticket-policy";
import { runAction } from "@/server/action-utils";
import { assertTicketNotClosed, formatClientContactNote, toUserRef } from "@/server/tickets";
import {
  assignTicketSchema,
  assignToMeSchema,
  changePrioritySchema,
  type ChangeRequesterEmailInput,
  changeRequesterEmailSchema,
  changeStatusSchema,
  createTicketSchema,
  moveQueueSchema,
  recordClientContactSchema,
  updateTicketFieldsSchema,
} from "@/server/validation";

// ---------------------------------------------------------------------------
// Module-private helpers (not exported: a "use server" module exports async functions only)
// ---------------------------------------------------------------------------

const WRITE_INCLUDE = {
  queue: { select: { id: true, key: true } },
  assignee: { select: { id: true, name: true, email: true, image: true, groups: true, isActive: true } },
} as const;

type TicketForWrite = Prisma.TicketGetPayload<{ include: typeof WRITE_INCLUDE }>;

async function loadTicketForWrite(tx: DbTx, ticketId: string): Promise<TicketForWrite> {
  const t = await tx.ticket.findUnique({ where: { id: ticketId }, include: WRITE_INCLUDE });
  if (!t) throw new NotFoundError("ticket not found");
  return t;
}

const ASSIGNEE_SELECT = { id: true, name: true, email: true, image: true, groups: true, isActive: true } as const;
type AssigneeCandidate = Prisma.UserGetPayload<{ select: typeof ASSIGNEE_SELECT }>;

/** §b.4: an assignee must be active and hold WRITE on the ticket's queue. */
async function loadEligibleAssignee(tx: DbTx, userId: string, queueKey: QueueKey): Promise<AssigneeCandidate> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: ASSIGNEE_SELECT });
  if (!u || !u.isActive || !canWriteQueue(u.groups, queueKey)) {
    throw new ValidationError("assignee is not eligible for this queue", {
      assigneeId: ["Assignee must be an active user who can work this queue"],
    });
  }
  return u;
}

/**
 * Decision #117. A `description` edit is REFUSED on a ticket whose source is in
 * `REQUESTER_AUTHORED_SOURCES` — the text is the client's own, and the client now reads it back.
 *
 * `Ticket.description` is the opening message of a thread, and the client API returns it as the first
 * entry of `messages`, attributed to the client as "You". `source` proves how the ticket ARRIVED; it
 * cannot prove that the CURRENT value of the field is still what the client sent. Without this refusal
 * an associate with plain `queue:write` could tidy or annotate an emailed ticket's opening text — "…
 * NOTE: flagged for fraud review, do not disclose" is the realistic shape — and the read would serve
 * that sentence to the client as their own words, stamped with the ticket's `createdAt` and visually
 * identical to a `Comment` row the database guarantees nobody can alter.
 *
 * Refusing is the honest rule rather than a workaround: editing a client's own words was already
 * questionable, and rewriting the field is the only way to silently alter the audited record of what
 * they sent. `retractions.actions.ts` refuses the same thing from the other side — the desk does not
 * withdraw a REQUESTER's message on their behalf. Every other channel's description is an operator's
 * account and stays freely editable, so the properties panel is unchanged for STAFF_FORM, PHONE,
 * VOICEMAIL and the rest; subject, category and every other field are unaffected on every source.
 */
function assertDescriptionIsNotTheRequesters(t: { source: TicketSource }, description: string | undefined): void {
  if (description === undefined) return;
  if (!(REQUESTER_AUTHORED_SOURCES as readonly TicketSource[]).includes(t.source)) return;
  throw new ValidationError("a client's own opening message cannot be edited", {
    description: [
      "This ticket opened with the client's own message, and the client can read it back. The desk does not rewrite it on their behalf — reply on the thread instead.",
    ],
  });
}

function ticketEntry(ticketId: string, entry: Omit<AuditEntry, "entityType" | "entityId" | "ticketId">): AuditEntry {
  return { entityType: "TICKET", entityId: ticketId, ticketId, ...entry };
}

function piiEntry(ticketId: string, fields: readonly string[], byKind: Parameters<typeof formatPiiCounts>[0]): AuditEntry {
  return ticketEntry(ticketId, {
    action: "PII_REDACTED",
    fieldChanged: fields.join(","),
    oldValue: null,
    newValue: formatPiiCounts(byKind),
  });
}

/**
 * updateMany guarded by {id, version}; count 0 means the row changed since it was loaded.
 * Typed with the unchecked input so FK scalars (queueId, assigneeId) can be set directly.
 */
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

function emptyToNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  return v.length === 0 ? null : v;
}

/**
 * Fix round 1 (security). `Ticket.requesterEmail` is not an ordinary data column: it IS the
 * authorization subject of the client-facing API. `/api/client/tickets/[id]` and
 * `/api/client/tickets/[id]/messages` decide access by comparing the stored column for equality with
 * the `X-Requester-Email` bearer header (src/server/client-view.ts), and `addPublicReply` enqueues
 * every future outbound reply to it (src/server/comments.actions.ts). So writing a DIFFERENT address
 * onto a ticket that already has one does two things at once:
 *
 *  1. it grants the new address retroactive read access to every PUBLIC comment already on the thread;
 *  2. it redirects all future client correspondence to that address.
 *
 * Three cases, deliberately not treated alike:
 *  - ADOPT   (null → an address): the phone-only ticket getting its FIRST address. Nobody loses or
 *            gains access to a thread they could already reach by that address. Ordinary `queue:write`
 *            — but only when it really is the first: see the round-2 note below.
 *  - CLEAR   (an address → null): access-REMOVING for the address being dropped, and fenced by the
 *            `ticket_requester_contact_present` rule below. Ordinary `queue:write`, plus the
 *            complaint / escalation refusal.
 *  - REDIRECT(an address → a different address): the privileged one. It leaves `updateTicketFields`
 *            entirely and goes through `changeRequesterEmail`, which needs an explicit confirmation
 *            and a recorded reason, and refuses outright on a complaint or an escalated ticket.
 *
 * Fix round 2 (security). Treating the three cases as three INDEPENDENT field writes left the fence
 * open: CLEAR and ADOPT are each individually permitted, and run back to back they compose into
 * exactly the REDIRECT this function exists to refuse. Two ordinary `updateTicketFields` calls —
 * `{requesterEmail: null, requesterPhone: "+1…"}` then `{requesterEmail: "attacker@elsewhere"}` —
 * handed a new address retroactive client-API read of the whole thread and every future outbound
 * reply, with no confirmation, no reason, no complaint/escalation refusal and no `privileged` marker
 * on either audit row. So the pair is now one decision, not two:
 *
 *  - an ADOPT is refused here when the ledger shows this ticket has already moved AWAY from an
 *    address (`previousRequesterEmail`). That is a two-step redirect, and it belongs on
 *    `changeRequesterEmail`, which accepts it for exactly that reason — otherwise the pair would have
 *    no legal path at all, and a genuinely mistyped address on a phone-reachable ticket could never
 *    be corrected;
 *  - a CLEAR now runs `assertRequesterEmailRedirectAllowed` too. Dropping the address on a complaint
 *    or an escalated ticket alters the same correspondence record the absolute rule protects, and it
 *    is the first half of the bypass above.
 */
function isRequesterEmailRedirect(current: string | null, next: string | null | undefined): boolean {
  return next !== undefined && next !== null && current !== null && next !== current;
}

/**
 * Tickets whose correspondence record must not be MOVED at all, at any capability.
 *
 * A complaint file and an escalated ticket are the two places where "who the firm was writing to" is
 * itself the record a reviewer reconstructs; silently re-pointing it at another address defeats the
 * purpose of keeping it. The correct move is a new ticket for the correct address, which leaves both
 * threads intact and both addressable.
 *
 * Round 2 widened where this is applied. It gates `changeRequesterEmail`'s redirect AND
 * `updateTicketFields`' CLEAR: dropping the address is not a neutral edit here either — it erases the
 * one column that says where this complaint's correspondence went, and it is the first half of the
 * CLEAR-then-ADOPT bypass. It deliberately does NOT gate a genuine first adoption, which records
 * where correspondence started rather than moving it.
 */
function assertRequesterEmailRedirectAllowed(t: TicketForWrite): void {
  if (t.isComplaint) {
    throw new ValidationError("the requester address on a complaint cannot be changed", {
      requesterEmail: [
        "This ticket is filed as a complaint, so its correspondence record is fixed. Open a new ticket for the correct address.",
      ],
    });
  }
  if (t.escalationTarget !== "NONE") {
    throw new ValidationError("the requester address on an escalated ticket cannot be changed", {
      requesterEmail: [
        `This ticket is escalated to ${t.escalationTarget}, so its correspondence record is fixed. Open a new ticket for the correct address.`,
      ],
    });
  }
}

/**
 * The most recent address this ticket is recorded as having moved AWAY from, or null when it has
 * never carried one.
 *
 * The ledger is the only place a previous address survives — `Ticket` holds one `requesterEmail` and
 * an overwrite or a clear leaves nothing behind on the row. Any audit row whose `fieldChanged` is
 * `requesterEmail` with a non-null `oldValue` recorded a departure: `updateTicketFields` writes one
 * when it CLEARS, `changeRequesterEmail` writes one when it REDIRECTS. The action is deliberately NOT
 * pinned, so this keeps working the day the dedicated `TICKET_REQUESTER_EMAIL_CHANGED` action lands
 * (the build record).
 *
 * Read on `tx`, so it sees this transaction's own writes and takes the same snapshot as the ticket
 * load it guards. It returns a stored address to the SERVER only — it is never part of a result — and
 * reads no record content, so it is not a view and writes no audit row.
 */
async function previousRequesterEmail(tx: DbTx, ticketId: string): Promise<string | null> {
  const row = await tx.auditLog.findFirst({
    where: { ticketId, fieldChanged: "requesterEmail", oldValue: { not: null } },
    orderBy: { seq: "desc" },
    select: { oldValue: true },
  });
  return row?.oldValue ?? null;
}

/**
 * The single refusal every privileged-edit path raises, so an agent who reaches it from a one-step
 * redirect and one who reaches it from the second half of a CLEAR-then-ADOPT are told the same thing
 * and sent to the same control. `edit-ticket-sheet.tsx` already renders `errors.requesterEmail`.
 */
function requesterEmailIsPrivilegedError(): ValidationError {
  return new ValidationError("changing an existing requester address is a privileged edit", {
    requesterEmail: [
      "Use “Change requester address”: redirecting correspondence needs a reason and an explicit confirmation.",
    ],
  });
}

/**
 * The Ticket columns `updateTicketFields` diffs into `TICKET_FIELD_CHANGED` rows — the schema's
 * editable keys plus `complaintFiledAt`, which is server-stamped rather than submitted
 * and still has to appear in the ledger when it changes.
 */
const TICKET_DIFFED_COLUMNS = [
  "subject",
  "description",
  "clientReference",
  "category",
  "requesterName",
  "requesterEmail",
  "requesterPhone",
  "brand",
  "isComplaint",
  "complaintFiledAt",
  "escalationTarget",
  "followUpAt",
  "externalRef",
] as const satisfies readonly (keyof TicketForWrite & string)[];

/** Exactly the scalar columns above — narrow enough to spread straight into a Prisma update. */
type TicketFieldUpdate = Partial<Pick<TicketForWrite, (typeof TICKET_DIFFED_COLUMNS)[number]>>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * `ALLOWED_REQUESTER_DOMAINS` (src/lib/requester-guard.ts) on the staff paths as well as intake: where the list
 * is set, an address outside it cannot become a ticket's requester by any route, including the new-ticket form
 * and a requester edit. Refused as a field error the forms render. Unset means no guard, as before.
 */
function assertRequesterDomainForForm(email: string | null | undefined): void {
  const domains = allowedRequesterDomains(env.ALLOWED_REQUESTER_DOMAINS);
  if (domains === undefined || email === null || email === undefined || isRequesterDomainAllowed(email, domains)) return;
  throw new ValidationError("The requester address is outside the domains this instance accepts", {
    requesterEmail: [`Only addresses at ${domains.join(" or ")} can be used here.`],
  });
}

export async function createTicket(
  input: CreateTicketInput,
): Promise<ActionResult<{ id: string; number: number; piiRedacted: boolean; piiRedactionCount: number }>> {
  return runAction("createTicket", async (viewer, ctx) => {
    const data = createTicketSchema.parse(input);
    const routed = routeCategory(data.category);
    const queueKey = data.queueKey ?? routed.queueKey;
    const priority = data.priority ?? routed.priority;
    assertCan(canCreateTicket(viewer.groups, queueKey), "ticket:create");
    assertRequesterDomainForForm(data.requesterEmail);

    // I4: every persisted free-text field is sanitized after zod and before any Prisma write.
    const s = sanitizeFields({
      subject: data.subject,
      description: data.description,
      clientReference: data.clientReference ?? null,
      requesterName: data.requesterName,
    });
    const subject = s.values.subject ?? data.subject;
    const description = s.values.description ?? data.description;
    const clientReference = emptyToNull(s.values.clientReference);
    const requesterName = s.values.requesterName ?? data.requesterName;
    const now = new Date();
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const queue = await tx.queue.findUnique({ where: { key: queueKey }, select: { id: true } });
      if (!queue) throw new NotFoundError(`queue ${queueKey} is not provisioned`);

      const policy = slaPolicyFor(priority, await tx.sLA.findUnique({ where: { priority } }));
      const due = computeDueDates(now, policy);

      const assignee = data.assigneeId ? await loadEligibleAssignee(tx, data.assigneeId, queueKey) : null;

      const ticket = await tx.ticket.create({
        data: {
          subject,
          description,
          clientReference,
          requesterName,
          requesterEmail: data.requesterEmail,
          category: data.category,
          priority,
          status: "NEW",
          queueId: queue.id,
          createdById: viewer.id,
          assigneeId: assignee?.id ?? null,
          slaFirstResponseMinutes: policy.firstResponseMinutes,
          slaResolutionMinutes: policy.resolutionMinutes,
          firstResponseDueAt: due.firstResponseDueAt,
          resolutionDueAt: due.resolutionDueAt,
          piiRedacted: s.redacted,
          piiRedactionCount: s.count,
          createdAt: now,
        },
        select: { id: true, number: true },
      });

      const entries: AuditEntry[] = [
        ticketEntry(ticket.id, {
          action: "TICKET_CREATED",
          newValue: JSON.stringify({
            subject,
            category: data.category,
            priority,
            queueKey,
            requesterName,
            requesterEmail: data.requesterEmail,
            assigneeId: assignee?.id ?? null,
          }),
        }),
      ];
      if (data.priority !== undefined && data.priority !== routed.priority) {
        entries.push(
          ticketEntry(ticket.id, {
            action: "TICKET_PRIORITY_CHANGED",
            fieldChanged: "priority",
            oldValue: routed.priority,
            newValue: priority,
          }),
        );
      }
      if (assignee) {
        entries.push(
          ticketEntry(ticket.id, {
            action: "TICKET_ASSIGNED",
            fieldChanged: "assigneeId",
            oldValue: null,
            newValue: assignee.id,
            metadata: { oldEmail: null, newEmail: assignee.email },
          }),
        );
      }
      if (s.redacted) entries.push(piiEntry(ticket.id, s.redactedFields, s.byKind));

      await writeAuditMany(tx, actor, ctx, entries);
      return { id: ticket.id, number: ticket.number, piiRedacted: s.redacted, piiRedactionCount: s.count };
    });

    return result;
  });
}

export async function updateTicketFields(
  input: UpdateTicketFieldsInput,
): Promise<ActionResult<{ version: number; piiRedacted: boolean; piiRedactionCount: number }>> {
  return runAction("updateTicketFields", async (viewer, ctx) => {
    const data = updateTicketFieldsSchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      assertCan(canWriteQueue(viewer.groups, t.queue.key), "queue:write", t.id);
      assertTicketNotClosed(t);
      assertDescriptionIsNotTheRequesters(t, data.description);

      // I4: every persisted free-text field is sanitized after zod and before any Prisma write.
      // requesterEmail / requesterPhone are deliberately NOT in this set: they are contact data the
      // schema validated, not prose, and redacting them would destroy the address the desk replies to
      // (prisma/schema.prisma documents both columns as "not a redaction target").
      const s = sanitizeFields({
        subject: data.subject,
        description: data.description,
        clientReference: data.clientReference,
        requesterName: data.requesterName,
        externalRef: data.externalRef,
      });
      const after: TicketFieldUpdate = {};
      if (data.subject !== undefined) after.subject = s.values.subject ?? data.subject;
      if (data.description !== undefined) after.description = s.values.description ?? data.description;
      if (data.clientReference !== undefined) after.clientReference = emptyToNull(s.values.clientReference);
      if (data.category !== undefined) after.category = data.category;
      // --- Wave A ---
      if (data.requesterName !== undefined) after.requesterName = s.values.requesterName ?? data.requesterName;
      // Already trim + lower-cased by the schema, which is what keeps the client API's equality check
      // against X-Requester-Email working.
      //
      // Fix round 1 (security): adopting a first address and clearing one stay here; REDIRECTING an
      // existing address is an access-control decision and is refused, with the field error the
      // properties form renders, pointing the agent at `changeRequesterEmail`. See
      // `isRequesterEmailRedirect` above for why the three cases are not alike.
      //
      // Fix round 2 (security): the three cases are ONE decision, not three independent writes —
      // CLEAR then ADOPT composed into the very redirect this refuses. See
      // `isRequesterEmailRedirect` above for the sequence and why each arm below is where it is.
      if (data.requesterEmail !== undefined) {
        assertRequesterDomainForForm(data.requesterEmail);
        if (isRequesterEmailRedirect(t.requesterEmail, data.requesterEmail)) {
          throw requesterEmailIsPrivilegedError();
        }
        if (t.requesterEmail === null && data.requesterEmail !== null) {
          // ADOPT — allowed only when it is genuinely the ticket's FIRST address. If the ledger shows
          // one was already dropped, this call is the second half of a two-step redirect and goes to
          // `changeRequesterEmail` with the confirmation, the reason and the complaint refusal.
          if ((await previousRequesterEmail(tx, t.id)) !== null) throw requesterEmailIsPrivilegedError();
        }
        if (t.requesterEmail !== null && data.requesterEmail === null) {
          // CLEAR — access-removing, but it still moves the correspondence record, which is fixed on a
          // complaint and on an escalated ticket at any capability.
          assertRequesterEmailRedirectAllowed(t);
        }
        after.requesterEmail = data.requesterEmail;
      }
      if (data.requesterPhone !== undefined) after.requesterPhone = data.requesterPhone;
      if (data.brand !== undefined) after.brand = data.brand;
      if (data.isComplaint !== undefined) after.isComplaint = data.isComplaint;
      if (data.escalationTarget !== undefined) after.escalationTarget = data.escalationTarget;
      if (data.followUpAt !== undefined) after.followUpAt = data.followUpAt === null ? null : new Date(data.followUpAt);
      if (data.externalRef !== undefined) after.externalRef = emptyToNull(s.values.externalRef);

      // DB CHECK `ticket_requester_contact_present`: refuse in the app, with a field
      // error the form can render, rather than letting Postgres raise a constraint violation the
      // agent would see as an opaque INTERNAL.
      const nextEmail = after.requesterEmail !== undefined ? after.requesterEmail : t.requesterEmail;
      const nextPhone = after.requesterPhone !== undefined ? after.requesterPhone : t.requesterPhone;
      if (nextEmail === null && nextPhone === null) {
        throw new ValidationError("a ticket must keep an email address or a phone number", {
          requesterEmail: ["Keep an email address or a phone number on the ticket"],
        });
      }

      // complaintFiledAt is stamped by the server the FIRST time isComplaint goes true,
      // and is never cleared by un-flagging — the filing date is the record, not the current checkbox.
      if (after.isComplaint === true && !t.isComplaint && t.complaintFiledAt === null) {
        after.complaintFiledAt = new Date();
      }

      const diffs = diffFields(t, after, TICKET_DIFFED_COLUMNS);
      if (diffs.length === 0) {
        // Nothing to write; still honor the concurrency token so stale clients learn to refresh.
        if (t.version !== data.version) throw new ConflictError();
        return { version: t.version, piiRedacted: false, piiRedactionCount: 0 };
      }

      await guardedUpdate(tx, t.id, data.version, {
        ...after,
        ...(s.redacted ? { piiRedacted: true, piiRedactionCount: { increment: s.count } } : {}),
      });

      const entries: AuditEntry[] = diffs.map((d) => ticketEntry(t.id, { action: "TICKET_FIELD_CHANGED", ...d }));
      if (s.redacted) entries.push(piiEntry(t.id, s.redactedFields, s.byKind));
      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, piiRedacted: s.redacted, piiRedactionCount: s.count };
    });

    return result;
  });
}

/**
 * Fix round 1 (security). Re-points a ticket's requester address — the privileged half of what
 * `updateTicketFields` used to do behind a plain `queue:write`.
 *
 * Why it is separate: the stored address is the authorization subject of the client-facing API and the
 * destination of every outbound reply (see `isRequesterEmailRedirect`). Before this, one CS or
 * Operations agent could hand an outside address retroactive read of a whole client thread, and
 * redirect all future mail to it, with one field edit and a generic `TICKET_FIELD_CHANGED` row — which
 * is detection, not prevention.
 *
 * The shape is `deactivateUser`'s: a literal `confirm: true` the UI can only send from a second step,
 * plus a reason that is sanitized and recorded on the audit row. `queue:write` on the ticket's
 * queue is still required — the confirmation is ON TOP of the existing bar, never instead of it — and
 * the change is refused outright on a complaint or an escalated ticket.
 *
 * Audit: one `TICKET_FIELD_CHANGED` row for `requesterEmail`, with the old and new addresses in the
 * hash-chained columns and `metadata.privileged = "REQUESTER_EMAIL_CHANGED"` plus the reason. The
 * catalog has no dedicated action for this yet (`@/types/domain` and the Prisma enum are not this
 * fix's to change); the build record carries the exact
 * addition to make, and the marker is what a query keys on until then.
 */
export async function changeRequesterEmail(
  input: ChangeRequesterEmailInput,
): Promise<ActionResult<{ version: number; requesterEmail: string; changed: boolean }>> {
  return runAction("changeRequesterEmail", async (viewer, ctx) => {
    const data = changeRequesterEmailSchema.parse(input);
    assertRequesterDomainForForm(data.requesterEmail);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      // `ticket:requester-email` is queue WRITE in the matrix; what makes it privileged is the
      // two-step confirmation and the recorded reason below, not a narrower group bar (src/lib/rbac.ts
      // explains why a group bar would lock the CS desk out of its own tickets).
      assertCan(canChangeRequesterEmail(viewer.groups, t.queue.key), "ticket:requester-email", t.id);
      assertTicketNotClosed(t);

      // `safeEqualEmails` rather than `===` (CWE-208): the right-hand side came off the wire and the
      // left-hand side is the stored identity. Both are already trimmed and lower-cased —
      // `changeRequesterEmailSchema` normalises the input and `nullableEmailSchema` normalised what was
      // stored — so the shared normalisation inside it changes nothing about which addresses match.
      if (t.requesterEmail !== null && safeEqualEmails(t.requesterEmail, data.requesterEmail)) {
        // Already the stored address: nothing is redirected, so none of the gates below apply and
        // there is nothing to record. The token is still honored so a stale client learns to refresh.
        if (t.version !== data.version) throw new ConflictError();
        return { version: t.version, requesterEmail: data.requesterEmail, changed: false };
      }

      // Adopting a FIRST address is not a redirect and belongs on `updateTicketFields`, which is where
      // the `ticket_requester_contact_present` rule and the rest of the field diff live. Refusing it
      // here keeps exactly one way to do each thing.
      //
      // Fix round 2 (security): `null → an address` is NOT a first adoption when the ledger shows the
      // ticket already moved away from one. CLEAR-then-ADOPT is a redirect split across two calls, and
      // `updateTicketFields` now refuses its second half, so it lands here — where it meets the same
      // bar as a one-step redirect. Routing it here rather than refusing it outright is what keeps a
      // mistyped address on a phone-reachable ticket correctable at all.
      const priorAddress = t.requesterEmail === null ? await previousRequesterEmail(tx, t.id) : null;
      if (t.requesterEmail === null && priorAddress === null) {
        throw new ValidationError("this ticket has no requester address to change", {
          requesterEmail: ["Set the first address from the ticket's properties instead."],
        });
      }

      assertRequesterEmailRedirectAllowed(t);

      // I4: the reason is operator free text and is sanitized before it reaches the ledger. The
      // address itself is NOT sanitized — `prisma/schema.prisma` documents `requesterEmail` as
      // contact data validated by zod and explicitly not a redaction target.
      const reason = sanitizePII(data.reason);

      await guardedUpdate(tx, t.id, data.version, { requesterEmail: data.requesterEmail });

      const entries: AuditEntry[] = [
        ticketEntry(t.id, {
          // Wave B landed the dedicated enum value this row was borrowing: the
          // REDIRECT is `TICKET_REQUESTER_EMAIL_CHANGED`, an ordinary edit stays `TICKET_FIELD_CHANGED`.
          // `metadata.privileged` stays so the rows written before this change keep reading the same
          // way, and `requesterEmailChangedAt` reads BOTH actions for the same reason.
          action: "TICKET_REQUESTER_EMAIL_CHANGED",
          fieldChanged: "requesterEmail",
          oldValue: t.requesterEmail,
          newValue: data.requesterEmail,
          metadata: {
            privileged: "REQUESTER_EMAIL_CHANGED",
            confirmed: true,
            reason: reason.text,
            previousEmail: t.requesterEmail ?? priorAddress,
            // Round 2: the address was cleared first and re-adopted. `oldValue` is faithfully null
            // (that IS what the column held), so this is what tells a reviewer the redirect arrived
            // in two steps rather than one; the CLEAR's own row carries the address it dropped.
            ...(t.requesterEmail === null ? { readoptedAfterClear: true } : {}),
            // Spelled out so a later reader does not have to know the client API to see what moved.
            grantsClientApiAccess: true,
            redirectsOutboundMail: true,
          },
        }),
      ];
      if (reason.redacted) entries.push(piiEntry(t.id, ["reason"], reason.byKind));
      await writeAuditMany(tx, actor, ctx, entries);

      return { version: data.version + 1, requesterEmail: data.requesterEmail, changed: true };
    });

    return result;
  });
}

// `OPERATOR_RESOLUTIONS`, `RESOLUTION_BEARING_STATUSES` and `isOperatorResolution` moved to
// `src/types/domain.ts` in fix round 2, so the Resolve control can render the same four outcomes this
// action accepts. A `"use server"` file may export nothing but actions, so a shared vocabulary
// cannot live here. The RULE below is unchanged and still server-side.

/**
 * Wave B fix round 1. `resolution` had no writer on any ordinary path: the column, its `[status,
 * resolution]` index and the `resolution-mix` report could only ever say "Not recorded", and four of
 * the seven enum values were unreachable from anywhere in the app. This is the resolve path's writer.
 *
 * Three refusals, each with a field error the composer can render:
 *  1. **Only on an ending transition.** A resolution on a move to OPEN or PENDING_* would describe an
 *     ending that is not happening. The reopen edge below CLEARS the column for the same reason.
 *  2. **Only the four operator outcomes** (see `OPERATOR_RESOLUTIONS`).
 *  3. **Write-once per resolve cycle.** Once a ticket carries an outcome, changing it on a later
 *     transition would rewrite a recorded fact with no reason attached — and on a merged ticket it
 *     would erase the DUPLICATE that the merge, the link and the `TICKET_MERGED` row all assert.
 *     Re-sending the SAME value is not a change and is allowed (it lands as a no-op diff). The one
 *     legitimate way back to NONE is a reopen, which is an audited edge of its own.
 */
function assertResolutionAllowed(current: TicketResolution, next: TicketStatus, resolution: TicketResolution): void {
  if (!(RESOLUTION_BEARING_STATUSES as readonly TicketStatus[]).includes(next)) {
    throw new ValidationError("an outcome can only be recorded when a ticket is resolved or closed", {
      resolution: [`${next} does not end a ticket, so it has no outcome to record.`],
    });
  }
  if (!isOperatorResolution(resolution)) {
    throw new ValidationError(`${resolution} is not an outcome this action can record`, {
      resolution: [
        resolution === "NONE"
          ? "Leave the outcome out instead of setting it to NONE."
          : "DUPLICATE is recorded by merging, and ENTERED_IN_ERROR by voiding.",
      ],
    });
  }
  if (current !== "NONE" && current !== resolution) {
    throw new ValidationError("this ticket already has a recorded outcome", {
      resolution: [`It ended as ${current}. Reopen it to record a different outcome.`],
    });
  }
}

/**
 * Status transitions, and the outcome that travels with the ending ones.
 *
 * Fix round 2 completed the set. The ticket properties panel's Resolve control now asks for the
 * outcome in a dialog before it applies, `bulk.actions.ts` threads an optional one through the
 * bulk status change, and `macros-apply.ts` applies a macro's stored `resolution`. All three go
 * through `assertResolutionAllowed`, so the rule is stated once here and enforced for every caller.
 *
 * What stays deliberately unrecorded: an outcome is never INFERRED. "Not recorded yet" is a
 * first-class answer on every one of those paths, because a books-and-records column filled with a
 * guess (ANSWERED because a public reply exists) is worse than one that is honestly empty.
 */
export async function changeTicketStatus(
  input: ChangeStatusInput,
): Promise<ActionResult<{ version: number; status: TicketStatus }>> {
  return runAction("changeTicketStatus", async (viewer, ctx) => {
    const data = changeStatusSchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      assertCan(canWriteQueue(viewer.groups, t.queue.key), "queue:write", t.id);
      assertTicketNotClosed(t);
      if (!canTransition(t.status, data.status)) {
        throw new ValidationError(`cannot change status from ${t.status} to ${data.status}`, {
          status: [`${t.status} → ${data.status} is not an allowed transition`],
        });
      }

      // Checked with the transition, before the identity gate: whether the OUTCOME is a legal thing to
      // say about this edge is a property of the request, and an ill-formed request should not come
      // back wearing a compliance refusal it did not cause.
      if (data.resolution !== undefined) assertResolutionAllowed(t.resolution, data.status, data.resolution);

      // the money-movement identity gate. Checked BEFORE the write and only on
      // the transition INTO RESOLVED — a wire ticket can be worked, replied to and reassigned without a
      // verification; it cannot be called finished. Throws ValidationError, which `runAction` turns into
      // an ActionError the composer can render. FOUNDATION DEFAULT: never throws (B6 owns the body).
      if (data.status === "RESOLVED") {
        await assertIdentityGate(tx, { ticketId: t.id, category: t.category });
      }

      const now = new Date();
      const after: Partial<Pick<TicketForWrite, "status" | "resolvedAt" | "closedAt" | "resolution">> = {
        status: data.status,
      };
      if (data.status === "RESOLVED") after.resolvedAt = now; // any → RESOLVED
      if (t.status === "RESOLVED" && data.status === "CLOSED") after.closedAt = now;
      if (t.status === "RESOLVED" && data.status === "OPEN") {
        after.resolvedAt = null; // reopen
        // A reopened ticket has not ended, so it has no outcome — the same reason `resolvedAt` is
        // cleared. Leaving a stale ANSWERED on an OPEN row would put it back into the mix the next
        // time it resolves, and would make `[status, resolution]` describe a state that is over.
        after.resolution = "NONE";
      }
      // Checked above; a supplied outcome only ever arrives on an ending transition, so it never
      // collides with the reopen clear.
      if (data.resolution !== undefined) after.resolution = data.resolution;

      await guardedUpdate(tx, t.id, data.version, after);

      const entries: AuditEntry[] = [
        ticketEntry(t.id, {
          action: "TICKET_STATUS_CHANGED",
          fieldChanged: "status",
          oldValue: t.status,
          newValue: data.status,
        }),
        // `resolution` is here so the outcome gets its OWN `TICKET_FIELD_CHANGED` row, exactly as
        // `voidTicket` writes one beside `TICKET_VOIDED`. `diffFields` drops a no-op, so re-sending
        // the same outcome and a reopen of a ticket that never had one write nothing.
        ...diffFields(t, after, ["resolvedAt", "closedAt", "resolution"]).map((d) =>
          ticketEntry(t.id, { action: "TICKET_FIELD_CHANGED", ...d }),
        ),
      ];

      // Wave B. Both cores run INSIDE this transaction and RETURN their audit entries rather than
      // writing them, so `writeAuditMany` below stays the last statement (CONTRACT §3 rule 2).
      // FOUNDATION DEFAULTS: both no-ops.
      if (data.status === "RESOLVED") {
        const notice = await maybeSendResolvedNotice(tx, { ticketId: t.id, ticketNumber: t.number });
        if (notice) entries.push(...notice.auditEntries);
      }
      const notified = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: t.id,
        // The words every other surface uses (`STATUS_LABELS`), not the raw enum: /inbox is read by
        // people, and "Status PENDING_CLIENT → RESOLVED" is the schema talking. Still §7.3-clean —
        // a label IS the enum value, spelled the way the badge, the filters and the bar spell it.
        preview: `Status ${STATUS_LABELS[t.status]} → ${STATUS_LABELS[data.status]}`,
        actorId: viewer.id,
      });
      entries.push(...notified.auditEntries);

      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, status: data.status };
    });

    return result;
  });
}

export async function changeTicketPriority(
  input: ChangePriorityInput,
): Promise<ActionResult<{ version: number; priority: TicketPriority }>> {
  return runAction("changeTicketPriority", async (viewer, ctx) => {
    const data = changePrioritySchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      assertCan(canWriteQueue(viewer.groups, t.queue.key), "queue:write", t.id);
      assertTicketNotClosed(t);

      if (t.priority === data.priority) {
        if (t.version !== data.version) throw new ConflictError();
        return { version: t.version, priority: t.priority };
      }

      // §d: re-stamp both due dates from the ORIGINAL createdAt and snapshot the policy that applied.
      const policy = slaPolicyFor(data.priority, await tx.sLA.findUnique({ where: { priority: data.priority } }));
      const due = computeDueDates(t.createdAt, policy);
      const after: Partial<
        Pick<
          TicketForWrite,
          "priority" | "slaFirstResponseMinutes" | "slaResolutionMinutes" | "firstResponseDueAt" | "resolutionDueAt"
        >
      > = {
        priority: data.priority,
        slaFirstResponseMinutes: policy.firstResponseMinutes,
        slaResolutionMinutes: policy.resolutionMinutes,
        firstResponseDueAt: due.firstResponseDueAt,
        resolutionDueAt: due.resolutionDueAt,
      };

      await guardedUpdate(tx, t.id, data.version, after);

      const entries: AuditEntry[] = [
        ticketEntry(t.id, {
          action: "TICKET_PRIORITY_CHANGED",
          fieldChanged: "priority",
          oldValue: t.priority,
          newValue: data.priority,
        }),
        ...diffFields(t, after, [
          "slaFirstResponseMinutes",
          "slaResolutionMinutes",
          "firstResponseDueAt",
          "resolutionDueAt",
        ]).map((d) => ticketEntry(t.id, { action: "TICKET_FIELD_CHANGED", ...d })),
      ];
      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, priority: data.priority };
    });

    return result;
  });
}

export async function assignTicket(
  input: AssignTicketInput,
): Promise<ActionResult<{ version: number; assignee: UserRef | null }>> {
  return runAction("assignTicket", async (viewer, ctx) => {
    const data = assignTicketSchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      assertCan(canWriteQueue(viewer.groups, t.queue.key), "queue:write", t.id);
      assertTicketNotClosed(t);

      const next = data.assigneeId === null ? null : await loadEligibleAssignee(tx, data.assigneeId, t.queue.key);
      const nextRef: UserRef | null = next ? toUserRef(next) : null;

      if ((t.assigneeId ?? null) === (next?.id ?? null)) {
        if (t.version !== data.version) throw new ConflictError();
        return { version: t.version, assignee: nextRef };
      }

      // §b.6: assigning a NEW ticket auto-opens it.
      const opens = t.status === "NEW" && next !== null;
      const after: Partial<Pick<TicketForWrite, "assigneeId" | "status">> = { assigneeId: next?.id ?? null };
      if (opens) after.status = "OPEN";

      await guardedUpdate(tx, t.id, data.version, after);

      const entries: AuditEntry[] = [
        ticketEntry(t.id, {
          action: "TICKET_ASSIGNED",
          fieldChanged: "assigneeId",
          oldValue: t.assigneeId ?? null,
          newValue: next?.id ?? null,
          metadata: { oldEmail: t.assignee?.email ?? null, newEmail: next?.email ?? null },
        }),
      ];
      if (opens) {
        entries.push(
          ticketEntry(t.id, {
            action: "TICKET_STATUS_CHANGED",
            fieldChanged: "status",
            oldValue: "NEW",
            newValue: "OPEN",
          }),
        );
      }
      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, assignee: nextRef };
    });

    return result;
  });
}

export async function moveTicketQueue(
  input: MoveQueueInput,
): Promise<ActionResult<{ version: number; queueKey: QueueKey }>> {
  return runAction("moveTicketQueue", async (viewer, ctx) => {
    const data = moveQueueSchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      const from = t.queue.key;
      const to = data.queueKey;
      assertCan(canMoveTicket(viewer.groups, from, to), `ticket:move ${from}->${to}`, t.id);
      assertTicketNotClosed(t);

      const destination = await tx.queue.findUnique({ where: { key: to }, select: { id: true } });
      if (!destination) throw new NotFoundError(`queue ${to} is not provisioned`);

      // §b.5: moves clear an assignee who cannot write the destination.
      const clearAssignee = t.assignee !== null && !canWriteQueue(t.assignee.groups, to);
      const after: Partial<Pick<TicketForWrite, "queueId" | "assigneeId">> = { queueId: destination.id };
      if (clearAssignee) after.assigneeId = null;

      await guardedUpdate(tx, t.id, data.version, after);

      const entries: AuditEntry[] = [
        ticketEntry(t.id, {
          action: "TICKET_QUEUE_CHANGED",
          fieldChanged: "queueKey",
          oldValue: from,
          newValue: to,
        }),
      ];
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
      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, queueKey: to };
    });

    return result;
  });
}

// ---------------------------------------------------------------------------
// Decision #66 and the one-click assignment
// ---------------------------------------------------------------------------

/**
 * Credit a callback, a returned voicemail, an in-person conversation or an SMS as the first response
 *. Before this, a desk that phoned the client back inside the SLA still showed as
 * breached, because `firstRespondedAt` moved only on a PUBLIC reply — so the SLA numbers punished the
 * faster channel.
 *
 * One transaction: the version-guarded bump, the INTERNAL note, the CONDITIONAL first-response
 * stamp, then `writeAuditMany` as the last statement (the build record rule 2).
 * The stamp reuses the EXISTING guard `{ firstRespondedAt: null, status: { not: "CLOSED" } }`, so a
 * ticket that was already answered keeps its original first-response time and a concurrent public
 * reply and contact record can never both claim it.
 *
 * WRITE on the queue is required: recording a client contact moves an SLA clock, which is operational.
 * compliance_officers may annotate a ticket with an internal note (`addInternalNote`) but may not
 * credit a response — read-plus-annotate is unchanged (§b rule 2).
 */
export async function recordClientContact(
  input: RecordClientContactInput,
): Promise<ActionResult<{ version: number; firstResponseStamped: boolean; commentId: string }>> {
  return runAction("recordClientContact", async (viewer, ctx) => {
    const data = recordClientContactSchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      assertCan(canWriteQueue(viewer.groups, t.queue.key), "queue:write", t.id);
      assertTicketNotClosed(t);

      // I4 / §f: sanitize the agent's words, THEN apply the structured prefix — the prefix is code and
      // is never a redaction target, exactly as a disclaimer is not.
      const sanitized = sanitizePII(data.note);
      const body = formatClientContactNote(data.channel, sanitized.text);

      await guardedUpdate(tx, t.id, data.version, {
        ...(sanitized.redacted ? { piiRedacted: true, piiRedactionCount: { increment: sanitized.count } } : {}),
      });

      const comment = await tx.comment.create({
        data: {
          ticketId: t.id,
          authorId: viewer.id,
          authorKind: "STAFF",
          visibility: "INTERNAL",
          body,
          disclaimerKey: "NONE",
          piiRedacted: sanitized.redacted,
          piiRedactionCount: sanitized.count,
        },
        select: { id: true, createdAt: true },
      });

      // Conditional side effect: no read-then-write, exactly one stamp under concurrency.
      const stamp = await tx.ticket.updateMany({
        where: { id: t.id, firstRespondedAt: null, status: { not: "CLOSED" } },
        data: { firstRespondedAt: comment.createdAt },
      });
      const firstResponseStamped = stamp.count === 1;

      const entries: AuditEntry[] = [
        {
          action: "COMMENT_ADDED_INTERNAL",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: t.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: body,
        },
        ticketEntry(t.id, {
          action: "CLIENT_CONTACT_RECORDED",
          fieldChanged: "channel",
          oldValue: null,
          newValue: data.channel,
          metadata: { commentId: comment.id, firstResponseStamped },
        }),
      ];
      if (sanitized.redacted) {
        entries.push({
          action: "PII_REDACTED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: t.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: formatPiiCounts(sanitized.byKind),
        });
      }
      if (firstResponseStamped) {
        entries.push(
          ticketEntry(t.id, {
            action: "TICKET_FIELD_CHANGED",
            fieldChanged: "firstRespondedAt",
            oldValue: null,
            newValue: comment.createdAt.toISOString(),
          }),
        );
      }
      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, firstResponseStamped, commentId: comment.id };
    });

    return result;
  });
}

/**
 * One-click self-assignment. Identical semantics to `assignTicket` with `assigneeId = viewer.id` — the
 * same §b.4 eligibility check (active user holding WRITE on the queue), the same §b.6 NEW → OPEN
 * auto-open, the same `TICKET_ASSIGNED` row — but it cannot be aimed at anyone else, so the dashboard
 * can expose it as a single control on a row the viewer can work.
 */
export async function assignToMe(input: AssignToMeInput): Promise<ActionResult<{ version: number; assignee: UserRef }>> {
  return runAction("assignToMe", async (viewer, ctx) => {
    const data = assignToMeSchema.parse(input);
    const actor = actorFromViewer(viewer);

    const result = await withTx(async (tx) => {
      const t = await loadTicketForWrite(tx, data.ticketId);
      assertCan(canWriteQueue(viewer.groups, t.queue.key), "queue:write", t.id);
      assertTicketNotClosed(t);

      // §b.4 re-check against the STORED groups, not the token's: the same bar every other assignment
      // clears, so a viewer whose access was reduced since sign-in cannot self-assign.
      const me = await loadEligibleAssignee(tx, viewer.id, t.queue.key);
      const meRef = toUserRef(me);

      if (t.assigneeId === me.id) {
        // Already mine: honor the token anyway so a stale client learns to refresh.
        if (t.version !== data.version) throw new ConflictError();
        return { version: t.version, assignee: meRef };
      }

      const opens = t.status === "NEW";
      const after: Partial<Pick<TicketForWrite, "assigneeId" | "status">> = { assigneeId: me.id };
      if (opens) after.status = "OPEN";

      await guardedUpdate(tx, t.id, data.version, after);

      const entries: AuditEntry[] = [
        ticketEntry(t.id, {
          action: "TICKET_ASSIGNED",
          fieldChanged: "assigneeId",
          oldValue: t.assigneeId ?? null,
          newValue: me.id,
          metadata: { oldEmail: t.assignee?.email ?? null, newEmail: me.email },
        }),
      ];
      if (opens) {
        entries.push(
          ticketEntry(t.id, {
            action: "TICKET_STATUS_CHANGED",
            fieldChanged: "status",
            oldValue: "NEW",
            newValue: "OPEN",
          }),
        );
      }
      await writeAuditMany(tx, actor, ctx, entries);
      return { version: data.version + 1, assignee: meRef };
    });

    return result;
  });
}
