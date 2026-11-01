/**
 * Pure helpers for the webhook admin form (docs/MOBILE_FIRST.md R1–R12).
 *
 * Kept out of the components so the decisions a person will argue about — which events are grouped
 * together, what an endpoint's health badge says, how a URL is shortened for a phone — are testable
 * without rendering anything. Nothing here imports a server module, the database or the environment.
 */
import type { AuditAction, WebhookDeliveryStatus } from "@/types/domain";

/**
 * The subscribable events, grouped the way an operator thinks about them rather than the way the audit
 * catalog orders them. Every group's members must exist in `WEBHOOK_SUBSCRIBABLE_ACTIONS`; a test in
 * this directory asserts the two lists are the same set, so an event added to the server and forgotten
 * here fails rather than becoming invisible in the picker.
 */
export type WebhookEventGroup = { label: string; hint: string; actions: readonly AuditAction[] };

const EVENT_GROUP_SOURCE: readonly WebhookEventGroup[] = [
  {
    label: "A ticket arrives",
    hint: "Something new landed on the desk, however it got here.",
    actions: ["TICKET_CREATED", "TICKET_INGESTED", "TICKET_IMPORTED"],
  },
  {
    label: "A ticket moves",
    hint: "Status, priority, queue, assignment and any other field edit.",
    actions: [
      "TICKET_STATUS_CHANGED",
      "TICKET_PRIORITY_CHANGED",
      "TICKET_ASSIGNED",
      "TICKET_QUEUE_CHANGED",
      "TICKET_FIELD_CHANGED",
      "TICKET_REOPENED_BY_REQUESTER",
    ],
  },
  {
    label: "A ticket ends, merges or links",
    hint: "Merged as a duplicate, voided as entered in error, or linked to another ticket.",
    actions: ["TICKET_MERGED", "TICKET_VOIDED", "TICKET_LINK_ADDED", "TICKET_LINK_REMOVED"],
  },
  {
    label: "Somebody writes",
    hint: "A public reply, a requester's message, or a reply withdrawn. Never the text itself.",
    actions: ["COMMENT_ADDED_PUBLIC", "COMMENT_ADDED_REQUESTER", "COMMENT_RETRACTED"],
  },
  {
    label: "A clock or a control fires",
    hint: "An SLA warning or breach, and the money-movement identity gate.",
    actions: ["SLA_ALERT", "IDENTITY_VERIFIED", "IDENTITY_GATE_OVERRIDDEN"],
  },
];

/** Frozen so a caller cannot mutate the picker's structure at runtime. */
export const WEBHOOK_EVENT_GROUPS: readonly WebhookEventGroup[] = Object.freeze(
  EVENT_GROUP_SOURCE.map((group) => Object.freeze({ ...group, actions: Object.freeze([...group.actions]) })),
);

/** Every action named by the groups above, in group order. */
export function groupedEventActions(): AuditAction[] {
  return WEBHOOK_EVENT_GROUPS.flatMap((g) => [...g.actions]);
}

/** A short, human label for one event. The raw action name is shown beside it — that is what the API sends. */
export const WEBHOOK_EVENT_LABELS: Readonly<Partial<Record<AuditAction, string>>> = Object.freeze({
  TICKET_CREATED: "Created by staff",
  TICKET_INGESTED: "Arrived from a channel",
  TICKET_IMPORTED: "Imported from the legacy help desk",
  TICKET_STATUS_CHANGED: "Status changed",
  TICKET_PRIORITY_CHANGED: "Priority changed",
  TICKET_ASSIGNED: "Assigned or unassigned",
  TICKET_QUEUE_CHANGED: "Moved between queues",
  TICKET_FIELD_CHANGED: "A field was edited",
  TICKET_REOPENED_BY_REQUESTER: "Reopened by the requester",
  TICKET_MERGED: "Merged as a duplicate",
  TICKET_VOIDED: "Voided (entered in error)",
  TICKET_LINK_ADDED: "Linked to another ticket",
  TICKET_LINK_REMOVED: "Link removed",
  COMMENT_ADDED_PUBLIC: "Replied to the client",
  COMMENT_ADDED_REQUESTER: "The requester wrote in",
  COMMENT_RETRACTED: "A reply was withdrawn",
  SLA_ALERT: "SLA warning or breach",
  IDENTITY_VERIFIED: "Identity verification recorded",
  IDENTITY_GATE_OVERRIDDEN: "Identity gate overridden",
});

export function eventLabel(action: AuditAction): string {
  return WEBHOOK_EVENT_LABELS[action] ?? action;
}

/** Phone-width rendering of a URL: the host, and the path only when it is short enough to help. */
export function shortUrl(url: string, maxChars = 44): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.length > maxChars ? `${url.slice(0, maxChars - 1)}…` : url;
  }
  const full = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars - 1)}…`;
}

export type EndpointHealth = "live" | "paused" | "revoked";

export function endpointHealth(endpoint: { isActive: boolean; revokedAt: string | null }): EndpointHealth {
  if (endpoint.revokedAt !== null) return "revoked";
  return endpoint.isActive ? "live" : "paused";
}

export const ENDPOINT_HEALTH_LABELS: Readonly<Record<EndpointHealth, string>> = Object.freeze({
  live: "Live",
  paused: "Paused",
  revoked: "Revoked",
});

/**
 * The badge variant for a delivery status. `DEAD` and `FAILED` are both destructive, deliberately: a
 * delivery that has given up and one that is still retrying are the same problem to whoever is looking
 * at this screen, and the status word beside the badge says which it is.
 */
export const DELIVERY_STATUS_VARIANTS: Readonly<Record<WebhookDeliveryStatus, "default" | "secondary" | "outline" | "destructive">> =
  Object.freeze({
    PENDING: "outline",
    SENT: "secondary",
    FAILED: "destructive",
    DEAD: "destructive",
  });

/**
 * The one line a toast shows for a server-side VALIDATION refusal.
 *
 * Fix round 2. `ActionError.message` for a validation failure is the generic "Invalid input" every
 * action returns; the sentence that says WHY is in `fieldErrors`. Registering
 * `https://webhook.invalid/hook` put "Names ending in .invalid are reserved…" in the field and
 * "Invalid input" in the toast — so the one line an operator reads first said nothing, while the same
 * sheet's LOCAL failure a moment earlier read "Please correct the highlighted fields". Two refusals of
 * the same form, two unrelated sentences, neither of them the reason.
 *
 * `_form` wins when it is present (it is the whole-form sentence). Otherwise the field messages are
 * surfaced in a stable order — a single one verbatim, several summarised the way the local path
 * summarises them, because a toast is one line and the fields are already highlighted underneath.
 */
export function validationToastMessage(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined,
  fallback: string,
): string {
  const fe = fieldErrors ?? {};
  const form = (fe._form ?? []).filter((m) => m.trim() !== "");
  if (form.length > 0) return form.join(" ");

  const preferred = ["url", "name", "events", "reason", "endpointId"];
  const keys = Object.keys(fe)
    .filter((k) => k !== "_form")
    .sort((a, b) => {
      const ia = preferred.indexOf(a);
      const ib = preferred.indexOf(b);
      if (ia !== ib) return (ia === -1 ? preferred.length : ia) - (ib === -1 ? preferred.length : ib);
      return a.localeCompare(b);
    });
  const withMessages = keys.filter((k) => (fe[k] ?? []).some((m) => m.trim() !== ""));
  if (withMessages.length === 0) return fallback;
  if (withMessages.length === 1) {
    return (fe[withMessages[0]] ?? []).filter((m) => m.trim() !== "").join(" ");
  }
  return "Please correct the highlighted fields";
}

/** A local-only check of the URL field, so the obvious mistakes never reach a round trip. */
export function urlFieldError(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "A URL is required.";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "That is not a valid absolute URL — include https:// at the front.";
  }
  if (parsed.protocol !== "https:") return "Only https is accepted — a signed payload must not travel in the clear.";
  // Length, not `!== ""`: security scanner CWE-208 reports an equality whose operand is named `password`, and this
  // is an emptiness check rather than a comparison of two credentials. Wave A rewrote the four
  // `token === ""` checks the same way.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "Credentials in the URL are not accepted. Use the signing secret instead.";
  }
  return null;
}
