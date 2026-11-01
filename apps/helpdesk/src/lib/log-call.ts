/**
 * "Log a call" — the channel rules behind the new-ticket form's intake variant.
 *
 * Pure, layer L1, and in `src/lib/` rather than `src/server/` for a reason G1 enforces: the FORM is a
 * client component, and a client component may not import a non-action `@/server/*` module. The labels
 * and the channel rules are needed on both sides, so they live where both may have them — and the
 * browser and the server then decide "does a voicemail need an email address" with the same function
 * rather than with two copies that drift.
 *
 * **Why an intake variant exists at all.** The desk answers the phone. The legacy help desk's own answer to this is
 * an agent creating a ticket "on behalf of" a caller, and the one thing it always needed was an email
 * address — so the associate either typed a guess or pasted the firm's own address, and the record
 * ended up naming the wrong person. Decision #62 made `Ticket.requesterEmail` nullable precisely so a
 * call can be a ticket with a PHONE and nothing else, and the DB CHECK
 * `ticket_requester_contact_present` keeps "and nothing at all" from being a third option.
 *
 * CONTRACT-GAP, recorded in the build record: §10 B11 names no server
 * export for this form, and the staff `createTicket` takes a REQUIRED `requesterEmail` and no
 * source — so a phone-only ticket cannot go through it. `logCall` is the closest faithful version: it
 * is an ordinary `runAction` action that calls the SAME `createTicketCore` every other channel uses,
 * so the routing defaults, the SLA stamping, the PII pass and the audit shape cannot drift.
 */
import type { ClientContactChannel, TicketCategory, TicketPriority, TicketSource, QueueKey } from "@/types/domain";

/** The four ways a request reaches the desk that this form can record. */
export const LOG_CALL_CHANNELS = ["WEB_FORM", "PHONE", "VOICEMAIL", "IN_PERSON"] as const;
export type LogCallChannel = (typeof LOG_CALL_CHANNELS)[number];

export const LOG_CALL_CHANNEL_LABELS: Readonly<Record<LogCallChannel, string>> = {
  WEB_FORM: "Web form",
  PHONE: "Phone",
  VOICEMAIL: "Voicemail",
  IN_PERSON: "In person",
};

/**
 * Channel → `Ticket.source`.
 *
 * `IN_PERSON` maps to `STAFF_FORM` because `TicketSource` has no in-person value and this slice does
 * not own the enum. The fact is not lost: the ticket's client-contact note records `IN_PERSON`, and the
 * audit row carries `channel`. The one-line schema change that would make it first-class is filed in
 * the integration notes.
 */
export function sourceForChannel(channel: LogCallChannel): TicketSource {
  switch (channel) {
    case "PHONE":
      return "PHONE";
    case "VOICEMAIL":
      return "VOICEMAIL";
    case "WEB_FORM":
    case "IN_PERSON":
      return "STAFF_FORM";
  }
}

/**
 * The category a channel pre-selects. A voicemail is a callback until the associate says otherwise —
 * `VOICEMAIL_CALLBACK` routes to Client Service at HIGH priority, which is the desk's own answer to
 * "somebody left a message and nobody has called them back yet".
 */
export function defaultCategoryForChannel(channel: LogCallChannel): TicketCategory {
  return channel === "VOICEMAIL" ? "VOICEMAIL_CALLBACK" : "OTHER";
}

/**
 * The contact channel `recordClientContact` is given when the associate ticks "client was reached".
 *
 * Null for the web form and for a voicemail the desk has NOT returned: a message left on the machine
 * is not a contact, and crediting it as the first response would silence the SLA clock that exists to
 * make somebody call back. `VOICEMAIL_RETURNED` is only reachable when the box is ticked, which is the
 * associate stating they spoke to the client.
 */
export function contactChannelFor(channel: LogCallChannel): ClientContactChannel | null {
  switch (channel) {
    case "PHONE":
      return "PHONE";
    case "VOICEMAIL":
      return "VOICEMAIL_RETURNED";
    case "IN_PERSON":
      return "IN_PERSON";
    case "WEB_FORM":
      return null;
  }
}

/** Whether the channel demands an email address. Only the web form does. */
export function requiresEmail(channel: LogCallChannel): boolean {
  return channel === "WEB_FORM";
}

/** What a channel needs before the form will submit: an address, a phone, or at least one of them. */
export function contactRequirementFor(channel: LogCallChannel): "email" | "email-or-phone" {
  return requiresEmail(channel) ? "email" : "email-or-phone";
}

export type LogCallInput = {
  channel: LogCallChannel;
  subject: string;
  description: string;
  category: TicketCategory;
  priority?: TicketPriority;
  queueKey?: QueueKey;
  requesterName: string;
  requesterEmail?: string | null;
  requesterPhone?: string | null;
  clientReference?: string | null;
  /**
   * Idempotency key minted by the form, so a double submit (or a retried transition) replays the same
   * ticket instead of creating a second one. `createTicketCore` keys its `IngestReceipt` on it.
   */
  requestId: string;
};

export const LOG_CALL_SUBJECT_MAX = 200;
export const LOG_CALL_DESCRIPTION_MAX = 20_000;
export const LOG_CALL_NAME_MAX = 120;
export const LOG_CALL_REFERENCE_MAX = 200;

/**
 * The contact policy, as one pure function the BROWSER and the SERVER both call.
 *
 * Returns the field errors for the requester's contact details, keyed exactly as the form's field-error
 * map is. Two rules, and the second one is the DB CHECK `ticket_requester_contact_present` restated
 * where a person can read it:
 *
 *  1. a web-form ticket needs an address, because a reply has to have somewhere to go;
 *  2. every other channel needs an address OR a phone — but not neither, because a request the desk
 *     cannot answer is not a ticket, it is a note.
 *
 * `email` and `phone` are what the person typed; emptiness is what this decides on, not validity —
 * the shape of an address and the E.164 form of a number are the schema's business.
 */
export function contactErrorsFor(
  channel: LogCallChannel,
  email: string | null | undefined,
  phone: string | null | undefined,
): Record<string, string[]> {
  const hasEmail = (email ?? "").trim() !== "";
  const hasPhone = (phone ?? "").trim() !== "";
  if (requiresEmail(channel) && !hasEmail) {
    return { requesterEmail: ["A web-form ticket needs the requester's email address"] };
  }
  if (!hasEmail && !hasPhone) {
    return {
      requesterPhone: ["Record at least one way to reach this person: an email address or a phone number"],
    };
  }
  return {};
}
