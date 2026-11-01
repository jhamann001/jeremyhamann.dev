/**
 * Pure wording for the ticket activity feed (`ActivityRow`).
 *
 * Kept free of JSX so the sentences are unit-testable under vitest's `src/**\/*.test.ts` include;
 * `ActivityRow` renders from these helpers. Layer L1-safe: imports only `@/types/domain` and `@/lib/format`.
 */
import {
  BRAND_LABELS,
  ESCALATION_TARGET_LABELS,
  QUEUE_LABELS,
  SOURCE_LABELS,
  TICKET_LINK_KIND_LABELS,
} from "@/types/domain";
import type {
  EscalationTarget,
  QueueKey,
  TicketBrand,
  TicketLinkKind,
  TicketPriority,
  TicketSource,
  TicketStatus,
} from "@/types/domain";
import { PRIORITY_LABELS, STATUS_LABELS, formatDateTime, labelize } from "@/lib/format";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Long free-text values (subject, description) are cut here so a row stays one line. */
export const ACTIVITY_VALUE_MAX_CHARS = 120;

/**
 * Human labels for the audited Ticket columns (§e: TICKET_FIELD_CHANGED, TICKET_STATUS_CHANGED,
 * TICKET_PRIORITY_CHANGED, TICKET_QUEUE_CHANGED, TICKET_ASSIGNED). Raw column names never reach the UI:
 * an unlisted field falls back to `labelize(field).toLowerCase()`.
 *
 * Fix round 2. That fallback is a safety net for a column nobody expected, not a home for expected ones.
 * Wave A added ten diffed `Ticket` columns (`TICKET_DIFFED_COLUMNS`, src/server/tickets.actions.ts) and
 * every one of them landed in it, so the timeline read "changed is complaint false -> true" while the
 * audit-log screen — exhaustive over the same actions via `ACTION_LABELS` — read it correctly. These are
 * the rows a compliance reviewer reconstructs a complaint or an escalation from, so the two surfaces now
 * agree. `householdId` and `requesterExternalId` are not diffed today; they are listed because they are
 * writable `Ticket` columns and the cost of listing them is one line.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  status: "status",
  priority: "priority",
  queueKey: "queue",
  assigneeId: "assignee",
  subject: "subject",
  description: "description",
  category: "category",
  clientReference: "client reference",
  firstRespondedAt: "first response",
  resolvedAt: "resolved at",
  closedAt: "closed at",
  firstResponseDueAt: "first response due",
  resolutionDueAt: "resolution due",
  slaFirstResponseMinutes: "first-response SLA (min)",
  slaResolutionMinutes: "resolution SLA (min)",
  // --- Wave A Ticket columns ---
  isComplaint: "complaint flag",
  complaintFiledAt: "complaint filed",
  escalationTarget: "escalation",
  followUpAt: "follow-up",
  externalRef: "external reference",
  requesterName: "requester name",
  requesterEmail: "requester email",
  requesterPhone: "requester phone",
  brand: "brand",
  householdId: "household",
  requesterExternalId: "client record id",
  // --- Wave B ---
  // `TicketLink.kind` (TICKET_LINK_ADDED / TICKET_LINK_REMOVED, src/server/ticket-links.actions.ts).
  kind: "link type",
  // The names `applyMacroActions` pushes into MACRO_ACTIONS_APPLIED's comma list
  // (src/server/macros-apply.ts). `assignee`, `status` and `priority` already land correctly; these
  // three did not, and the row printed the raw column name.
  resolution: "resolution",
  assignee: "assignee",
  followUpInDays: "follow-up",
};

/**
 * Columns whose stored audit value is a Postgres boolean rendered as "true" / "false". Gated by column
 * rather than by the value so a free-text field that happens to contain the word "true" is still shown
 * verbatim.
 */
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["isComplaint"]);

function isStatus(v: string): v is TicketStatus {
  return v in STATUS_LABELS;
}

function isPriority(v: string): v is TicketPriority {
  return v in PRIORITY_LABELS;
}

function isQueueKey(v: string): v is QueueKey {
  return v in QUEUE_LABELS;
}

function isEscalationTarget(v: string): v is EscalationTarget {
  return v in ESCALATION_TARGET_LABELS;
}

function isBrand(v: string): v is TicketBrand {
  return v in BRAND_LABELS;
}

function isTicketLinkKind(v: string): v is TicketLinkKind {
  return v in TICKET_LINK_KIND_LABELS;
}

/** "firstRespondedAt" → "first response"; unlisted "someNewColumn" → "some new column"; null/blank → "a field". */
export function fieldLabel(field: string | null): string {
  if (field === null || field.trim().length === 0) return "a field";
  return FIELD_LABELS[field] ?? labelize(field.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).toLowerCase();
}

/**
 * Human form of a stored audit value, or null when the value is empty: enums → their labels, ISO
 * timestamps → `formatDateTime`, long free text truncated with an ellipsis.
 */
export function displayValue(field: string | null, v: string | null): string | null {
  if (v === null || v === "") return null;
  if (field === "status" && isStatus(v)) return STATUS_LABELS[v];
  if (field === "priority" && isPriority(v)) return PRIORITY_LABELS[v];
  if (field === "queueKey" && isQueueKey(v)) return QUEUE_LABELS[v];
  if (field === "category") return labelize(v);
  if (field === "escalationTarget" && isEscalationTarget(v)) return ESCALATION_TARGET_LABELS[v];
  if (field === "brand" && isBrand(v)) return BRAND_LABELS[v];
  // Fix round 2. `TICKET_LINK_ADDED` / `TICKET_LINK_REMOVED` store the raw `TicketLinkKind` under
  // `fieldChanged: "kind"`, and with no branch here the feed read "linked this ticket DUPLICATE_OF"
  // while the links panel beside it read "Duplicate of" off the same enum. The OUTBOUND map is the
  // right one and not a guess: `linkEntry` writes exactly one row, always on `from`/`loser`
  // (src/server/ticket-links.actions.ts:246, :301, :438), so a timeline row is never the inbound end.
  // `TICKET_LINK_INVERSE_LABELS` is what the panel applies to the other ticket, where there is no row.
  if (field === "kind" && isTicketLinkKind(v)) return TICKET_LINK_KIND_LABELS[v];
  if (field !== null && BOOLEAN_FIELDS.has(field) && (v === "true" || v === "false")) return v === "true" ? "Yes" : "No";
  if (ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))) return formatDateTime(v);
  return v.length > ACTIVITY_VALUE_MAX_CHARS ? `${v.slice(0, ACTIVITY_VALUE_MAX_CHARS)}…` : v;
}

export type FieldChange =
  /** old empty, new present — "set first response to Sep 16, 2026 23:21" */
  | { kind: "set"; field: string; to: string }
  /** both present — "changed status New → Open" */
  | { kind: "changed"; field: string; from: string; to: string }
  /** new empty — "cleared resolved at" (`from` is the previous value, when there was one) */
  | { kind: "cleared"; field: string; from: string | null };

/** Classifies one audited column change into set / changed / cleared with humanized label and values. */
export function describeFieldChange(field: string | null, oldValue: string | null, newValue: string | null): FieldChange {
  const label = fieldLabel(field);
  const from = displayValue(field, oldValue);
  const to = displayValue(field, newValue);
  if (to === null) return { kind: "cleared", field: label, from };
  if (from === null) return { kind: "set", field: label, to };
  return { kind: "changed", field: label, from, to };
}

/**
 * `MACRO_ACTIONS_APPLIED`'s stored value is `applied.join(",")` — a list of the COLUMN NAMES a macro
 * touched (src/server/macros-apply.ts). Rendered raw the row read "applied macro actions
 * queueKey,status,followUpInDays", which is the exact defect this module exists to prevent, on the row
 * a reviewer reconstructs a macro-driven status change from. Each name goes through `fieldLabel`, so an
 * action added later degrades to "follow up in days" rather than to a column name.
 *
 * Returns null when there is nothing to list, so the caller can fall back rather than print an empty
 * sentence.
 */
export function macroActionsSentence(newValue: string | null): string | null {
  if (newValue === null) return null;
  const parts = newValue
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => fieldLabel(p));
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * The sources a PERSON at this desk typed into a form, as against a channel that delivered a ticket.
 * B11 routes the /tickets/new Phone, Voicemail and In-person forms through the ingest core (the staff
 * `createTicket` path requires an email address), so their `TICKET_INGESTED` rows are staff-entered.
 */
const STAFF_ENTERED_SOURCES: ReadonlySet<string> = new Set<TicketSource>(["STAFF_FORM", "PHONE", "VOICEMAIL"]);

export type IngestDescription = {
  /** "logged this ticket" when a person typed it, "received this ticket" when a channel delivered it. */
  verb: string;
  /** The human source name, when the stored summary carries a recognised one. */
  source: string | null;
};

/**
 * Wording for `TICKET_INGESTED`.
 *
 * The row used to fall through to `labelize(action).toLowerCase()` and read "Olivia Ops / ticket
 * ingested", which tells a reader a channel delivered a ticket a colleague typed at their desk while
 * every other staff-created ticket reads "created the ticket". The audit row was right; the verb was
 * not. `newValue` is the JSON summary `ingestTicket` stores, and it is parsed DEFENSIVELY — an
 * unreadable or unrecognised summary degrades to the neutral "received this ticket" rather than to a
 * claim about how the ticket arrived.
 */
export function describeIngest(newValue: string | null): IngestDescription {
  const source = ingestSource(newValue);
  if (source === null) return { verb: "received this ticket", source: null };
  return {
    verb: STAFF_ENTERED_SOURCES.has(source) ? "logged this ticket" : "received this ticket",
    source: SOURCE_LABELS[source],
  };
}

function ingestSource(newValue: string | null): TicketSource | null {
  if (newValue === null || newValue === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(newValue);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { source } = parsed as { source?: unknown };
  return typeof source === "string" && source in SOURCE_LABELS ? (source as TicketSource) : null;
}

/** Plain-text form of a change (the JSX in `ActivityRow` renders the same words with emphasis on the values). */
export function fieldChangeSentence(change: FieldChange): string {
  switch (change.kind) {
    case "set":
      return `set ${change.field} to ${change.to}`;
    case "changed":
      return `changed ${change.field} ${change.from} → ${change.to}`;
    case "cleared":
      return `cleared ${change.field}`;
  }
}
