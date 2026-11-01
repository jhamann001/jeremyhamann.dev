/**
 * Every literal word B1 would ever transmit — node-free, PURE, and the only place these strings
 * exist (the build record rule 4). The DRAFT copies for approval are
 * the build record and the build record; this module and those two
 * files are kept word-for-word identical, and the tests assert it.
 *
 * NOTHING HERE SENDS. These functions return strings. The dispatcher decides whether a channel is
 * configured, and no channel is configured anywhere on this branch.
 *
 * PII-LIGHT IS THE WHOLE DESIGN (contract §7.3): a line may carry a ticket number, a kind label, a
 * count and a `/tickets/wm/<number>` deep link. It may never carry a subject, a requester name, a
 * requester address, a staff member's address or any body text. `assertPiiLight` (Wave A's Slack
 * module) is the mechanical backstop and every builder here is run through it in the tests — a
 * notification's own `preview` is deliberately NOT interpolated into any of these lines, because a
 * preview is a sanitized subject line and a subject is client material.
 */
import type { NotificationKind } from "@/types/domain";
import { NOTIFICATION_KIND_LABELS } from "@/types/domain";

/** How a WM number is written in an outbound line. One spelling, everywhere. */
export function wmNumber(ticketNumber: number): string {
  return `HD-${ticketNumber}`;
}

/**
 * One Slack DM about one notification.
 *
 * The kind LABEL is the whole subject of the sentence ("Mentioned you", "Client replied"): it says
 * what happened without saying anything about whom or about what. The actor is omitted on purpose —
 * naming a colleague costs a directory lookup and adds nothing a reader cannot see on the ticket.
 */
export function slackDmLine(input: { kind: NotificationKind; ticketNumber: number | null; link: string | null }): string {
  const label = NOTIFICATION_KIND_LABELS[input.kind];
  if (input.ticketNumber === null) return `WM Help Desk — ${label}.`;
  const ref = input.link === null ? wmNumber(input.ticketNumber) : `<${input.link}|${wmNumber(input.ticketNumber)}>`;
  return `WM Help Desk — ${label} on ${ref}.`;
}

/** The web-push payload for one notification. `body` is a kind label; `url` is the deep link. */
export function pushPayload(input: {
  kind: NotificationKind;
  ticketNumber: number | null;
  path: string;
}): { title: string; body: string; url: string; tag: string } {
  const label = NOTIFICATION_KIND_LABELS[input.kind];
  return {
    title: "WM Help Desk",
    body: input.ticketNumber === null ? label : `${label} — ${wmNumber(input.ticketNumber)}`,
    url: input.path,
    tag: input.ticketNumber === null ? `wmhd-${input.kind}` : `wmhd-${input.kind}-${input.ticketNumber}`,
  };
}

/** One "3 × Mentioned you" line of the digest. */
export function digestKindLine(kind: NotificationKind, count: number): string {
  return `• ${count} × ${NOTIFICATION_KIND_LABELS[kind]}`;
}

/**
 * The whole daily digest for one person: a headline count, a line per kind, and the ticket numbers
 * as links. No subjects and no requesters — a digest is a nudge to open the inbox, not a substitute
 * for reading it, and it arrives on a channel the desk does not control.
 */
export function digestMessage(input: {
  unread: number;
  byKind: ReadonlyArray<{ kind: NotificationKind; count: number }>;
  tickets: ReadonlyArray<{ number: number; link: string | null }>;
  inboxLink: string | null;
}): string {
  const lines: string[] = [];
  lines.push(
    input.unread === 1
      ? "WM Help Desk — 1 unread notification in your inbox."
      : `WM Help Desk — ${input.unread} unread notifications in your inbox.`,
  );
  for (const row of input.byKind) lines.push(digestKindLine(row.kind, row.count));
  if (input.tickets.length > 0) {
    const refs = input.tickets.map((t) => (t.link === null ? wmNumber(t.number) : `<${t.link}|${wmNumber(t.number)}>`));
    lines.push(`Tickets: ${refs.join(", ")}`);
  }
  if (input.inboxLink !== null) lines.push(`Open your inbox: ${input.inboxLink}`);
  return lines.join("\n");
}

/** How many ticket numbers a digest names before it stops listing and lets the inbox do the rest. */
export const DIGEST_MAX_TICKETS = 10;
