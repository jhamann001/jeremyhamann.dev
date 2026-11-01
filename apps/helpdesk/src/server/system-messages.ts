/**
 * SYSTEM-authored client messages — node, layer L4.
 *
 * Two messages, both written by the desk itself rather than by a person: the auto-acknowledgement that
 * a requester-created ticket has arrived, and the notice that it has been resolved. Both are ordinary
 * PUBLIC comments — they appear on the timeline, they are visible through the client view, they carry
 * a disclaimer, and their delivery goes through the same transactional outbox as a staff reply. What
 * makes them different is who wrote them, and that fact is `authorKind: SYSTEM` with `authorId: null`,
 * enforced by the DB CHECK `comment_staff_has_author`.
 *
 * FOUR RULES, each a control rather than a preference (they are the four the foundation stub stated,
 * and none of them moved):
 *
 *  1. **`authorKind: SYSTEM`, `authorId: null`.** A machine is not a person. Attributing a receipt to
 *     whichever staff account happened to be nearby would put a name on words nobody wrote.
 *  2. **It NEVER stamps `firstRespondedAt`.** An automatic receipt is not a first response. If it
 *     counted as one, every first-response number in the reporting suite would report the latency of a
 *     database write instead of the latency of a human reading the request — and the SLA the firm shows
 *     an examiner would be a measurement of itself. This module simply never writes that column, and
 *     the message it sends says the same thing to the client in words.
 *  3. **It is enqueued in the SAME transaction as its comment.** "A receipt exists" and "a receipt is
 *     queued to leave" cannot disagree, in either direction.
 *  4. **Suppression is respected.** A destination on `RequesterSuppression` produces a delivery row in
 *     `FAILED_SUPPRESSED` and no send. The comment is still written: the desk's record of what it
 *     would have said is not contingent on the mail leaving.
 *
 * NOTHING HERE TRANSMITS, and nothing here runs at all unless `AUTO_ACK_ENABLED` /
 * `RESOLVED_NOTICE_ENABLED` are set — which they are nowhere. The wording is DRAFT
 * (the build record, `resolved-notice.md`) and needs approval before
 * either key can ever be set; the build record records that as an open item.
 *
 * AUDIT DISCIPLINE (§3 rule 2): both functions RETURN their audit entries rather than writing them, so
 * the caller's single trailing `writeAuditMany` stays the last statement of its transaction. They are
 * called from inside `createTicketCore` and `changeTicketStatus`; neither opens a transaction of its own.
 */
import type { AuditEntry, DisclaimerKey, TicketBrand, TicketSource } from "@/types/domain";
import { AUDIT_VIA } from "@/lib/audit";
import type { AuditVia } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { renderSystemMessage } from "@/lib/email/templates/system";
import type { SystemMessageKind } from "@/lib/email/templates/system";
import { env } from "@/lib/env";
import { enqueueDelivery, isDeliverableAddress } from "@/server/outbox";

export type SystemMessageResult = { commentId: string; deliveryId: string; auditEntries: AuditEntry[] };

/**
 * The sources that mean "a requester created this", and therefore the only ones that get a receipt.
 *
 * A `STAFF_FORM` ticket was typed by the person who would receive the acknowledgement's own colleague;
 * a `PHONE` ticket was logged by the staff member already talking to the client; `SYSTEM`, `IMPORT` and
 * `API` are the desk talking to itself. Sending a receipt for any of those is at best noise and at
 * worst a machine emailing a client about a call that just ended.
 *
 * `VOICEMAIL` IS on the list, conditionally: a voicemail ticket often has a phone number and no address
 *, and one with no deliverable address is skipped by the address check below rather than
 * by this list — but a voicemail ticket that DOES carry an address is a client who left a message and
 * has heard nothing, which is precisely the case a receipt exists for.
 *
 * NOT `REQUESTER_AUTHORED_SOURCES` (`src/types/domain.ts`), and the one-value difference is load-
 * bearing rather than an oversight. This list asks WHO CREATED THE TICKET — is there a human out there
 * waiting for a receipt? That list asks WHO WROTE THE TEXT of `description` — may the desk show it back
 * to them as their own words? `VOICEMAIL` answers yes to the first and no to the
 * second: the caller is the requester, but the stored field is a machine transcript wrapped in desk
 * metadata (the phone system line name, the duration, a link to the recording). Neither list may be derived
 * from the other, and a tenth `TicketSource` has to be classified against BOTH.
 */
export const AUTO_ACK_SOURCES: readonly TicketSource[] = Object.freeze(["EMAIL", "CLIENT_APP", "VOICEMAIL"]);

/** `metadata.systemMessage` on the rows these two functions produce, so the ledger can filter them. */
export const SYSTEM_MESSAGE_METADATA_KEY = "systemMessage" as const;

/**
 * `metadata.via` for a SYSTEM message, derived from the channel the ticket arrived on (§3 rule 1).
 *
 * CONTRACT-GAP: `maybeSendAutoAcknowledgement`'s input is `{ ticketId, ticketNumber }`, so this module
 * cannot be handed the caller's own `IngestCallContext.via`. The channel on the ticket row is the next
 * best fact and is the one the caller's `withVia` would have recorded anyway. The resolved notice takes
 * no `via` at all: its caller is `changeTicketStatus`, a human action, and `metadata->>'via' IS NULL`
 * must keep meaning "a person did this". Recorded in
 * the build record
 */
export function systemMessageVia(source: TicketSource): AuditVia {
  switch (source) {
    case "EMAIL":
      return AUDIT_VIA.email;
    case "CLIENT_APP":
      return AUDIT_VIA.clientApp;
    default:
      return AUDIT_VIA.api;
  }
}

type TicketForSystemMessage = {
  id: string;
  number: number;
  subject: string;
  brand: TicketBrand;
  source: TicketSource;
  requesterEmail: string | null;
};

const TICKET_SELECT = {
  id: true,
  number: true,
  subject: true,
  brand: true,
  source: true,
  requesterEmail: true,
} as const;

/**
 * INTEGRATION ROUND 1 — both of these are now one-line delegations to `@/server/outbox`, exactly as
 * this module's own comment anticipated ("when it lands, this function becomes a one-line delegation
 * and nothing else here changes"). B9 landed `findLiveSuppression` / `isRequesterSuppressed` /
 * `SUPPRESSED_DELIVERY_ERROR` there, and `enqueueDelivery` now performs the suppression check itself.
 *
 * They stay EXPORTED under these names because B5's tests and its admin surfaces import them from
 * here. Re-exporting rather than deleting keeps one definition of "live means `removedAt IS NULL`",
 * which is the thing that must not fork.
 */
export { findLiveSuppression, isRequesterSuppressed, SUPPRESSED_DELIVERY_ERROR } from "@/server/outbox";

/**
 * The same shape `enqueueDelivery` requires of a destination address, checked HERE so a ticket whose
 * `requesterEmail` is present but malformed skips the receipt instead of failing the ingest.
 *
 * This matters because of where the call sits: `maybeSendAutoAcknowledgement` runs inside
 * `createTicketCore`'s transaction, and `enqueueDelivery` refuses an undeliverable address by throwing
 * — which is exactly right for a staff reply (the reply rolls back with it) and exactly wrong here (a
 * client's ticket would be rejected because the desk could not send them a receipt).
 *
 * INTEGRATION ROUND 1: the duplicated regex is gone. `isDeliverableAddress` is B9's export from
 * `@/server/outbox` — the SAME predicate `enqueueDelivery` applies — so this pre-check and the throw it
 * is avoiding can no longer disagree about what "deliverable" means.
 */

/**
 * The shared body of both messages: write the SYSTEM comment, enqueue its delivery, honour suppression.
 *
 * Returns null — without writing anything — when the ticket has no address a reply can be delivered to.
 * A SYSTEM message with nowhere to go is not a record worth keeping: unlike a staff reply, which is the
 * desk's own words and belongs on the ticket whether or not it can be delivered, this
 * text says "we have emailed you", and writing it when no email exists would put a false statement on
 * the client-visible timeline.
 */
async function writeSystemMessage(
  tx: DbTx,
  kind: SystemMessageKind,
  ticketId: string,
  via: AuditVia | null,
): Promise<SystemMessageResult | null> {
  const ticket = (await tx.ticket.findUnique({
    where: { id: ticketId },
    select: TICKET_SELECT,
  })) as TicketForSystemMessage | null;
  if (ticket === null) return null;

  const toAddress = ticket.requesterEmail?.trim().toLowerCase() ?? "";
  if (!isDeliverableAddress(toAddress)) return null;

  const rendered = renderSystemMessage(ticket.brand, kind, { ticketNumber: ticket.number });

  // The template is firm-authored code, so it is NOT run through `sanitizePII` — there is no client
  // input in it to redact, and a sanitizer pass over a fixed string is a false reassurance. The one
  // interpolation is the ticket's own number.
  const comment = await tx.comment.create({
    data: {
      ticketId: ticket.id,
      authorId: null,
      authorKind: "SYSTEM",
      visibility: "PUBLIC",
      body: rendered.body,
      disclaimerKey: rendered.disclaimerKey satisfies DisclaimerKey,
      piiRedacted: false,
      piiRedactionCount: 0,
    },
    select: { id: true },
  });

  const queued = await enqueueDelivery(tx, {
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    brand: ticket.brand,
    toAddress,
    subject: ticket.subject,
    commentId: comment.id,
    body: rendered.body,
    ...(via === null ? {} : { via, source: ticket.source }),
  });

  const auditEntries: AuditEntry[] = [
    {
      action: "COMMENT_ADDED_PUBLIC",
      entityType: "COMMENT",
      entityId: comment.id,
      ticketId: ticket.id,
      fieldChanged: "body",
      oldValue: null,
      newValue: rendered.body,
      metadata: {
        disclaimerKey: rendered.disclaimerKey,
        [SYSTEM_MESSAGE_METADATA_KEY]: kind,
        authorKind: "SYSTEM",
        // Spelled out so a reader of this row does not have to know the SLA code to see why the
        // first-response clock did not move when a PUBLIC reply was written.
        stampsFirstResponse: false,
        ...(via === null ? {} : { via, source: ticket.source }),
      },
    },
    queued.auditEntry,
  ];

  // SUPPRESSION IS NOT CHECKED HERE ANY MORE (integration round 1, B9's note §2.3).
  //
  // `enqueueDelivery` now does it, inside this same transaction and in the same two steps — create
  // QUEUED, then refuse — with the same `lastError` and the same `QUEUED → FAILED_SUPPRESSED`
  // transition. This module used to repeat that block, so one suppressed SYSTEM message wrote the
  // transition twice and pushed TWO `MESSAGE_FAILED` entries into the ledger for one delivery.
  //
  // `queued.auditEntry` is already the right entry either way: `MESSAGE_QUEUED` for an ordinary
  // destination, `MESSAGE_FAILED` carrying the suppression reason for a stopped one. The one thing
  // this path loses is the `systemMessage: <kind>` tag on that entry's metadata, which the ordinary
  // outbound path does not carry either — the comment's own `COMMENT_ADDED_*` row names the kind.

  return { commentId: comment.id, deliveryId: queued.deliveryId, auditEntries };
}

/**
 * The receipt for a requester-created ticket. Called INSIDE `createTicketCore`'s transaction, after the
 * Ticket and its `IngestReceipt` are written and before the trailing `writeAuditMany`.
 *
 * Returns null — writing nothing — when `AUTO_ACK_ENABLED` is unset, when the ticket did not come from
 * a requester channel, or when there is no address to deliver to. A null is the ordinary outcome today.
 */
export async function maybeSendAutoAcknowledgement(
  tx: DbTx,
  input: { ticketId: string; ticketNumber: number },
): Promise<SystemMessageResult | null> {
  if (!env.AUTO_ACK_ENABLED) return null;

  const ticket = await tx.ticket.findUnique({ where: { id: input.ticketId }, select: { source: true } });
  if (ticket === null) return null;
  if (!AUTO_ACK_SOURCES.includes(ticket.source)) return null;

  return writeSystemMessage(tx, "AUTO_ACK", input.ticketId, systemMessageVia(ticket.source));
}

/**
 * The notice that a ticket has been resolved. Called INSIDE `changeTicketStatus`'s transaction on the
 * transition into RESOLVED, before the trailing `writeAuditMany`.
 *
 * Deliberately NOT deduped across a reopen. A ticket that was resolved, reopened by the client and
 * resolved again has been through the work twice, and the second resolution is news to the person who
 * reopened it — a notice suppressed because an older one exists would leave them waiting. The
 * *recommended default, pending confirmation* is therefore one notice per transition into RESOLVED, and
 * the transition itself is already rate-limited by the state machine: RESOLVED → RESOLVED is not an
 * allowed transition, so a repeated save cannot produce a second notice.
 *
 * Unlike the acknowledgement this carries NO `metadata.via`: its caller is a person clicking Resolve,
 * and `metadata->>'via' IS NULL` is what partitions the ledger into human and machine rows.
 */
export async function maybeSendResolvedNotice(
  tx: DbTx,
  input: { ticketId: string; ticketNumber: number },
): Promise<SystemMessageResult | null> {
  if (!env.RESOLVED_NOTICE_ENABLED) return null;
  return writeSystemMessage(tx, "RESOLVED_NOTICE", input.ticketId, null);
}
