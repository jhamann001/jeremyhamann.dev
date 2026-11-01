/**
 * Pure formatting helpers and enum → label maps (layer L1).
 * Edge- and browser-safe: imports only `@/types/domain` and `@/lib/firm-time` (also L1, and itself
 * dependency-free). `date-fns` is no longer used here — Wave B pinned rendered instants to the firm
 * clock, and `Intl.DateTimeFormat` with an explicit zone is the only conversion available without a
 * new dependency (date-fns v4 needs `@date-fns/tz`, which is not installed and may not be added).
 */
import type { AuditAction, OktaGroup, SlaStatus, TicketPriority, TicketStatus } from "@/types/domain";
import { FIRM_TIME_ZONE_LABEL, formatFirmDateTime } from "@/lib/firm-time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function toDateValue(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/** "HD-1042" */
export function formatTicketNumber(n: number): string {
  return `HD-${n}`;
}

/**
 * "Sep 16, 2026 14:05 ET" — one fixed pattern AND one fixed zone.
 *
 * Wave B closes the gap Wave A recorded and deliberately left open: this
 * function used to render in whatever zone the code happened to run in, which is two different zones
 * for one page. A React Server Component runs in the container's zone (UTC on Cloud Run) and a
 * `"use client"` sibling runs in the viewer's, so the same instant printed twice on one screen could
 * disagree by four or five hours, and an operator reading "resolved 09:14" had no way to know which
 * clock that was. `Ticket.followUpAt` was already pinned to the firm clock by the Wave A flag work;
 * everything else — created, updated, SLA due, resolved, closed, every audit row's `occurredAt`, every
 * comment timestamp — was not.
 *
 * It now delegates to `formatFirmDateTime` (America/New_York, `src/lib/firm-time.ts`), which carries
 * the zone label so the reading is self-describing, and which is the SAME helper the follow-up badge
 * and the `<input type="datetime-local">` pair already use. Consequences, accepted deliberately:
 *
 *  - Every rendered timestamp in the app moves to Eastern and gains an " ET" suffix. `suppressHydration
 *    Warning` on the surfaces that print them becomes belt-and-braces rather than load-bearing, because
 *    the server and the browser now compute the same string.
 *  - A reader in Denver sees the desk's clock, not their own. That is the point: the SLA policy, the
 *    custodial cutoffs and the firm's own day are Eastern, and a shared record has to have one clock.
 *  - `formatRelative` is unchanged — "3h ago" is zone-independent by construction.
 *
 * `FIRM_TIME_ZONE = "America/New_York"` remains a *recommended default, pending the owner's confirmation*;
 * it is one constant in one module.
 */
export function formatDateTime(iso: string | Date): string {
  return formatFirmDateTime(iso);
}

/** The zone every `formatDateTime` reading is in, for a legend or a column header. */
export const DISPLAY_TIME_ZONE_LABEL = FIRM_TIME_ZONE_LABEL;

/** "just now" · "2m ago" · "3h ago" · "5d ago" · "in 12m" · "in 2d". */
export function formatRelative(iso: string | Date, now: Date = new Date()): string {
  const d = toDateValue(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = now.getTime() - d.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS) return "just now";
  let unit: string;
  if (abs < HOUR_MS) unit = `${Math.floor(abs / MINUTE_MS)}m`;
  else if (abs < DAY_MS) unit = `${Math.floor(abs / HOUR_MS)}h`;
  else unit = `${Math.floor(abs / DAY_MS)}d`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

/**
 * Compact duration: "1h 12m", "3d 4h", "23m", "<1m"; negative values are prefixed with "-"
 * ("-23m") so an overdue SLA reads as a deficit.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const negative = ms < 0;
  const abs = Math.abs(ms);
  let body: string;
  if (abs < MINUTE_MS) {
    body = "<1m";
  } else if (abs < HOUR_MS) {
    body = `${Math.floor(abs / MINUTE_MS)}m`;
  } else if (abs < DAY_MS) {
    const h = Math.floor(abs / HOUR_MS);
    const m = Math.floor((abs % HOUR_MS) / MINUTE_MS);
    body = m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else {
    const d = Math.floor(abs / DAY_MS);
    const h = Math.floor((abs % DAY_MS) / HOUR_MS);
    body = h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  return negative ? `-${body}` : body;
}

/**
 * A parenthesised or bracketed qualifier — "(machine)", "[bot]", "{svc}". It describes the actor, it
 * is not part of the actor's name, so it never contributes an initial while a real name token remains.
 */
const BRACKETED_QUALIFIER = /^[([{<]/u;

/**
 * Leading characters that are neither letter nor digit: "'Nour" → "Nour", "-Smith" → "Smith". Unicode
 * aware on purpose — `[^a-zA-Z0-9]` would eat the É of "Émile" and initial the wrong letter.
 */
const LEADING_NON_ALNUM = /^[^\p{L}\p{N}]+/u;

/**
 * One upper-case initial from a token: by code point, so an astral letter is not split into half a
 * surrogate pair, and re-trimmed after upper-casing because some letters grow ("ß" → "SS").
 */
function initialOf(token: string | undefined): string {
  const ch = Array.from(token ?? "")[0];
  if (ch === undefined) return "";
  return Array.from(ch.toUpperCase())[0] ?? "";
}

/**
 * Up to two initials from the display name, falling back to the email's local part.
 *
 * Each contributing token gives its first LETTER OR DIGIT, not its first character, and a bracketed
 * qualifier is dropped outright: the machine actors seeded as "Integration (machine)" and "Scheduled
 * jobs (machine)" (prisma/machine-users.ts) read "I" and "SJ" rather than "I(" and "S(". Those rows
 * author every ingested ticket, so the punctuation was showing up in the "Created by" avatar and the
 * audit view — the surfaces a compliance reviewer reads to answer who created a record.
 */
export function initials(name: string | null, email: string): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length > 0) {
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const named = tokens.filter((t) => !BRACKETED_QUALIFIER.test(t));
    const parts = (named.length > 0 ? named : tokens)
      .map((t) => t.replace(LEADING_NON_ALNUM, ""))
      .filter((t) => t.length > 0);
    const first = initialOf(parts[0]);
    const last = parts.length > 1 ? initialOf(parts[parts.length - 1]) : "";
    const out = `${first}${last}`;
    if (out.length > 0) return out;
  }
  const local = email.split("@")[0] ?? "";
  const fallback = local.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
  return fallback.length > 0 ? fallback : "?";
}

/** "PENDING_CLIENT" → "Pending client" */
export function labelize(enumValue: string): string {
  const words = enumValue.trim().toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return "";
  const [head, ...rest] = words;
  return [head!.charAt(0).toUpperCase() + head!.slice(1), ...rest].join(" ");
}

export const STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  NEW: "New",
  OPEN: "Open",
  PENDING_CLIENT: "Pending client",
  PENDING_INTERNAL: "Pending internal",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  VOIDED: "Voided",
};

export const PRIORITY_LABELS: Readonly<Record<TicketPriority, string>> = {
  URGENT: "Urgent",
  HIGH: "High",
  STANDARD: "Standard",
  LOW: "Low",
};

export const GROUP_LABELS: Readonly<Record<OktaGroup, string>> = {
  ops_team: "Operations",
  advisors: "Advisors",
  client_services: "Client Service",
  compliance_officers: "Compliance",
};

/**
 * What the audit ledger calls each action — the surface a compliance reviewer reads to reconstruct what
 * happened to a ticket, so the wording may never claim more than the event proves.
 *
 * Delivery vocabulary is deliberate and matches `MESSAGE_DELIVERY_STATUS_LABELS` / the comment delivery
 * chip (`src/components/tickets/delivery-chip-label.ts`) and the build record P16 ("Queued / Sending /
 * Sent / Failed"):
 *
 * - `MESSAGE_SENT` is written when an external sender reports `outcome: "SENT"` — a mail provider
 *   ACCEPTED the message (`src/server/outbox.ts`). Acceptance is not arrival in a mailbox: an accepted
 *   message can still bounce. So the ledger says "Reply sent", the same word the chip prints, and NOT
 *   "delivered". A truthful "delivered" would need a provider delivery webhook and its own status.
 * - `MESSAGE_FAILED` keeps the word "delivery" because failure IS established: the provider did not
 *   accept it, so nothing was delivered. The asymmetry is the point — we know a failure, not a success.
 * - `COMMENT_ADDED_PUBLIC` says "added", not "sent": saving a public reply only writes the comment and
 *   enqueues a delivery in the same transaction, which is why the composer button reads "Save reply to
 *   ticket" until a sender is switched on. The MESSAGE_* actions are what report on the send itself.
 */
export const ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  TICKET_CREATED: "Ticket created",
  TICKET_VIEWED: "Ticket viewed",
  TICKET_PREVIEWED: "Ticket previewed",
  TICKET_FIELD_CHANGED: "Field changed",
  TICKET_STATUS_CHANGED: "Status changed",
  TICKET_PRIORITY_CHANGED: "Priority changed",
  TICKET_ASSIGNED: "Assignee changed",
  TICKET_QUEUE_CHANGED: "Queue changed",
  COMMENT_ADDED_INTERNAL: "Internal note added",
  COMMENT_ADDED_PUBLIC: "Public reply added",
  MACRO_APPLIED: "Macro applied",
  PII_REDACTED: "PII redacted",
  AUDIT_LOG_VIEWED: "Audit log viewed",
  AUDIT_LOG_EXPORTED: "Audit log exported",
  AUDIT_CHAIN_VERIFIED: "Audit chain verified",
  CLIENT_API_READ: "Client API read",
  USER_SIGNED_IN: "Signed in",
  USER_SIGNED_OUT: "Signed out",
  AUTHZ_DENIED: "Access denied",
  // --- Wave A ---
  COMMENT_ADDED_REQUESTER: "Client message received",
  TICKET_REOPENED_BY_REQUESTER: "Reopened by client",
  TICKET_INGESTED: "Ticket ingested",
  TICKET_LINKED: "Linked to earlier ticket",
  INTAKE_SUSPENDED: "Inbound message held",
  INTAKE_RELEASED: "Held message released",
  MESSAGE_QUEUED: "Reply queued for delivery",
  MESSAGE_LEASED: "Reply handed to sender",
  MESSAGE_SENT: "Reply sent",
  MESSAGE_FAILED: "Reply delivery failed",
  ATTACHMENT_ADDED: "Attachment added",
  ATTACHMENT_VIEWED: "Attachment downloaded",
  ATTACHMENT_REMOVED: "Attachment removed",
  SLA_ALERT: "SLA alert",
  TICKET_LIST_EXPORTED: "Tickets exported",
  TICKET_EXPORT_READ: "Ticket export read",
  CLIENT_CONTACT_RECORDED: "Client contact recorded",
  USER_DEACTIVATED: "User deactivated",
  USER_REACTIVATED: "User reactivated",
  MACRO_CREATED: "Macro created",
  MACRO_UPDATED: "Macro updated",
  MACRO_DEACTIVATED: "Macro deactivated",
  MACRO_REACTIVATED: "Macro reactivated",
  AUTHZ_DENIED_COALESCED: "Access denied (summarised)",
  JOB_RUN: "Scheduled job run",
  // --- Carried from Wave A CONTRACT §14 (each replaces a borrowed action + metadata). ---
  TICKET_REQUESTER_EMAIL_CHANGED: "Requester address changed",
  INTAKE_DISCARDED: "Held message discarded",
  ATTACHMENT_INTENT_CREATED: "Attachment upload started",
  // --- Wave B. Same rule as the delivery vocabulary above: the wording never claims more than the
  // event proves. "Draft requested", not "draft written"; "Webhook sent", not "webhook received". ---
  NOTIFICATION_PREFS_CHANGED: "Notification settings changed",
  TICKET_FOLLOWED: "Followed ticket",
  TICKET_UNFOLLOWED: "Unfollowed ticket",
  TICKET_LINK_ADDED: "Ticket linked",
  TICKET_LINK_REMOVED: "Ticket link removed",
  TICKET_MERGED: "Merged as duplicate",
  TICKET_VOIDED: "Voided (entered in error)",
  BULK_ACTION_APPLIED: "Bulk action applied",
  COMMENT_RETRACTED: "Reply withdrawn",
  MESSAGE_CANCELLED: "Reply delivery cancelled",
  MESSAGE_BOUNCED: "Reply bounced",
  MACRO_ACTIONS_APPLIED: "Macro actions applied",
  AI_DRAFT_REQUESTED: "AI draft requested",
  SLA_POLICY_CHANGED: "SLA policy changed",
  WEBHOOK_ENDPOINT_CREATED: "Webhook created",
  WEBHOOK_ENDPOINT_UPDATED: "Webhook updated",
  WEBHOOK_ENDPOINT_REVOKED: "Webhook revoked",
  WEBHOOK_DELIVERY_SENT: "Webhook sent",
  WEBHOOK_DELIVERY_FAILED: "Webhook delivery failed",
  WEBHOOK_DELIVERY_DEAD: "Webhook delivery given up",
  REVIEW_STAMPED: "Reply reviewed",
  IDENTITY_VERIFIED: "Identity verified",
  IDENTITY_GATE_OVERRIDDEN: "Identity gate overridden",
  REPORT_EXPORTED: "Report exported",
  API_TOKEN_CREATED: "API token created",
  API_TOKEN_REVOKED: "API token revoked",
  API_TOKEN_ROTATED: "API token rotated",
  PUSH_SUBSCRIBED: "Push notifications enabled",
  PUSH_UNSUBSCRIBED: "Push notifications disabled",
  SUPPRESSION_ADDED: "Address suppressed",
  SUPPRESSION_REMOVED: "Address un-suppressed",
  TICKET_IMPORTED: "Ticket imported",
};

export const SLA_LABELS: Readonly<Record<SlaStatus, string>> = {
  ON_TRACK: "On track",
  WARNING: "Warning",
  BREACHED: "Breached",
  MET: "Met",
};
