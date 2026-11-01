/**
 * Outbound webhook endpoints — node, layer L4.
 *
 * The reads, the schemas and the payload builder. The mutations live in `webhooks.actions.ts`, the
 * delivery attempt in `src/jobs/webhook-dispatch.ts`; the split is the repository's ordinary one
 * (`macros.ts` / `macros.actions.ts`), and it is what lets the admin PAGE — a server component — load
 * the list without importing a `"use server"` module.
 *
 * THE THREE THINGS THIS MODULE IS CAREFUL ABOUT
 *
 *  1. **The payload is PII-light by construction, not by review**. `buildWebhookPayload` selects
 *     named columns; it never spreads a ticket, never copies `oldValue`/`newValue` except for the three
 *     actions whose values are enum members, and never touches a subject or a body.
 *     `assertPayloadPiiLight` is the mechanical backstop, modelled on `assertPiiLight` in
 *     `src/jobs/slack.ts`: it refuses a payload containing an `@` or anything `sanitizePII` recognises,
 *     and it runs on every payload before it can be signed.
 *  2. **The subscribable event list is an allowlist, not the whole catalog.** A webhook on
 *     `TICKET_VIEWED` would push one request per page render, and `AUTHZ_DENIED` would push the desk's
 *     own denial stream to a third party. The list below is the set of ticket-lifecycle facts an
 *     integration can legitimately react to.
 *  3. **The SSRF guard runs twice.** `assertEndpointUrlAllowed` is called here at registration and again
 *     by the dispatcher immediately before each send, and the second call is the one that matters: DNS
 *     is mutable state owned by whoever registered the hostname.
 *
 * NOTHING HERE TRANSMITS. Registration performs a DNS lookup and nothing else; the dispatcher is inert
 * unless `WEBHOOKS_ENABLED` is set, and it is set nowhere.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { z } from "zod";
import type {
  AuditAction,
  AuditEntityType,
  QueueKey,
  RequestContext,
  TicketBrand,
  TicketCategory,
  TicketPriority,
  TicketStatus,
  Viewer,
  WebhookDeliveryDTO,
  WebhookDeliveryStatus,
  WebhookEndpointDTO,
} from "@/types/domain";
import { AUDIT_ACTIONS, WAVE_B_LIMITS } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { canAdminWebhooks } from "@/lib/rbac";
import { assertPublicHttpsUrl, assertResolvedAddresses } from "@/lib/ssrf-guard";
import type { SsrfVerdict } from "@/lib/ssrf-guard";
import { sha256Hex } from "@/lib/webhook-signing";

// ---------------------------------------------------------------------------
// What may be subscribed to
// ---------------------------------------------------------------------------

/**
 * The audit actions an endpoint may subscribe to.
 *
 * Every entry is a change to a ticket's lifecycle that an outside system could reasonably act on: a
 * ticket appeared, moved, was answered, was finished, or was withdrawn. Deliberately ABSENT:
 *
 *  - the read actions (`TICKET_VIEWED`, `TICKET_PREVIEWED`, `CLIENT_API_READ`, `ATTACHMENT_VIEWED`,
 *    `TICKET_EXPORT_READ`) — a webhook on a read is a surveillance feed of the desk's own staff, and it
 *    would outnumber every other row in the ledger;
 *  - the authorization and session actions (`AUTHZ_DENIED*`, `USER_SIGNED_IN/OUT`) — security telemetry
 *    that belongs in the audit export, not pushed to a third party;
 *  - the administrative actions (`API_TOKEN_*`, `WEBHOOK_*`, `MACRO_*`, `USER_*`, `SUPPRESSION_*`) — a
 *    webhook that fires on its own configuration is a loop with a credential in it;
 *  - `COMMENT_ADDED_INTERNAL` — I1. An internal note never leaves the desk, and an *event* saying one
 *    was written leaks the existence of a note to a system that may not read it.
 *
 * `COMMENT_ADDED_PUBLIC` and `COMMENT_ADDED_REQUESTER` ARE subscribable, because "this ticket was
 * replied to" is the single most useful integration signal there is — but the payload carries no body,
 * only the comment's id. A consumer that needs the text reads it through the client API, with its own
 * token and its own audited read.
 */
export const WEBHOOK_SUBSCRIBABLE_ACTIONS = [
  "TICKET_CREATED",
  "TICKET_INGESTED",
  "TICKET_IMPORTED",
  "TICKET_STATUS_CHANGED",
  "TICKET_PRIORITY_CHANGED",
  "TICKET_ASSIGNED",
  "TICKET_QUEUE_CHANGED",
  "TICKET_FIELD_CHANGED",
  "TICKET_REOPENED_BY_REQUESTER",
  "TICKET_MERGED",
  "TICKET_VOIDED",
  "TICKET_LINK_ADDED",
  "TICKET_LINK_REMOVED",
  "COMMENT_ADDED_PUBLIC",
  "COMMENT_ADDED_REQUESTER",
  "COMMENT_RETRACTED",
  "SLA_ALERT",
  "IDENTITY_VERIFIED",
  "IDENTITY_GATE_OVERRIDDEN",
] as const satisfies readonly AuditAction[];

export type WebhookSubscribableAction = (typeof WEBHOOK_SUBSCRIBABLE_ACTIONS)[number];

export function isSubscribableAction(action: string): action is WebhookSubscribableAction {
  return (WEBHOOK_SUBSCRIBABLE_ACTIONS as readonly string[]).includes(action);
}

/**
 * The three actions whose `oldValue` / `newValue` are ENUM MEMBERS and can therefore travel in a
 * payload. Everything else keeps its field NAME and drops its values: `COMMENT_ADDED_PUBLIC` carries a
 * whole reply body in `newValue`, `TICKET_FIELD_CHANGED` can carry a subject, and `TICKET_ASSIGNED`
 * carries a staff member's user id. None of those is a fact a third party gets from us for free.
 */
export const WEBHOOK_ENUM_VALUED_ACTIONS = [
  "TICKET_STATUS_CHANGED",
  "TICKET_PRIORITY_CHANGED",
  "TICKET_QUEUE_CHANGED",
] as const satisfies readonly AuditAction[];

export function carriesEnumValues(action: AuditAction): boolean {
  return (WEBHOOK_ENUM_VALUED_ACTIONS as readonly string[]).includes(action);
}

// ---------------------------------------------------------------------------
// Limits and shapes
// ---------------------------------------------------------------------------

export const WEBHOOK_NAME_MAX_CHARS = 120;
export const WEBHOOK_URL_MAX_CHARS = 2000;
/** A revoke reason, on the same floor and ceiling as every other recorded reason in this wave. */
export const WEBHOOK_REASON_MIN_CHARS = WAVE_B_LIMITS.reasonMinChars;
export const WEBHOOK_REASON_MAX_CHARS = WAVE_B_LIMITS.reasonMaxChars;
/** Deliveries shown on the admin page, newest first. A page, not a history — the ledger is the history. */
export const WEBHOOK_DELIVERY_PAGE_SIZE = 50;
/**
 * How far back `WebhookEndpointDTO.recentFailures` looks. A TIME window, not a row count: a lifetime
 * total would badge an endpoint that failed a year ago and has been healthy since as permanently
 * failing, and a health indicator nobody believes is worse than none.
 */
export const WEBHOOK_HEALTH_WINDOW_DAYS = 7;

const subscribableActionSchema = z
  .string()
  .refine(isSubscribableAction, { message: "That event is not one an endpoint may subscribe to." });

const eventsSchema = z
  .array(subscribableActionSchema)
  .min(1, "Choose at least one event — an endpoint with no events receives nothing.")
  .max(WEBHOOK_SUBSCRIBABLE_ACTIONS.length)
  .transform((values) => [...new Set(values)] as WebhookSubscribableAction[]);

const nameSchema = z.string().trim().min(1, "A name is required.").max(WEBHOOK_NAME_MAX_CHARS);

const urlSchema = z
  .string()
  .trim()
  .min(1, "A URL is required.")
  .max(WEBHOOK_URL_MAX_CHARS)
  /**
   * Fix round 1. This used to test `.allowed` and attach one generic sentence to every rejection —
   * "That URL is not an https address this desk may send to." — while `assertPublicHttpsUrl` was
   * already computing a precise `reason` and it was thrown away. `https://webhook.invalid/hook` IS
   * https; it is refused because `invalid` is a reserved TLD on `FORBIDDEN_HOST_SUFFIXES`, and the
   * administrator who typed it was sent to check their scheme. The DNS layer beside it surfaces its
   * own reason properly, which is the standard this now meets.
   *
   * The fallback is cause-neutral on purpose, and matches the sentence `webhooks.actions.ts` uses when
   * the DNS verdict arrives without a reason. A `refuse()` always carries one, so this branch is not
   * reachable today — but a default that NAMES a cause is a default that will eventually name the
   * wrong one, which is the whole of the bug being fixed here.
   */
  .superRefine((v, ctx) => {
    const verdict = assertPublicHttpsUrl(v);
    if (verdict.allowed) return;
    ctx.addIssue({
      code: "custom",
      message: verdict.reason ?? "That URL cannot be a webhook destination.",
    });
  });

const reasonSchema = z.string().trim().min(WEBHOOK_REASON_MIN_CHARS).max(WEBHOOK_REASON_MAX_CHARS);

export const createWebhookEndpointSchema = z.object({
  name: nameSchema,
  url: urlSchema,
  events: eventsSchema,
});

export const updateWebhookEndpointSchema = z
  .object({
    endpointId: z.string().min(1),
    name: nameSchema.optional(),
    url: urlSchema.optional(),
    events: eventsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.url !== undefined || v.events !== undefined || v.isActive !== undefined,
    { message: "Nothing to change.", path: ["_form"] },
  );

export const revokeWebhookEndpointSchema = z.object({ endpointId: z.string().min(1), reason: reasonSchema });

export const testWebhookDeliverySchema = z.object({ endpointId: z.string().min(1) });

export type TestWebhookDeliveryInput = z.infer<typeof testWebhookDeliverySchema>;

// ---------------------------------------------------------------------------
// The SSRF guard, with DNS
// ---------------------------------------------------------------------------

/** Injectable for the tests: `node:dns`'s `lookup` with `all: true`, narrowed to what we use. */
export type AddressLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: AddressLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * The full guard for one URL: the syntactic verdict, then every address the hostname resolves to.
 *
 * Runs at registration AND immediately before every send. A registration-time-only guard is a guard an
 * attacker waits out: the hostname passes review pointing at a public address and is re-pointed at
 * `10.0.0.5` afterwards, and nothing would notice.
 *
 * A resolver failure is a REFUSAL, not a pass. "We could not check" and "it is safe" are different
 * answers, and only one of them may let a request leave the VPC.
 */
export async function assertEndpointUrlAllowed(url: string, lookup: AddressLookup = defaultLookup): Promise<SsrfVerdict> {
  const syntactic = assertPublicHttpsUrl(url);
  if (!syntactic.allowed) return syntactic;

  let hostname: string;
  try {
    hostname = new URL(url.trim()).hostname;
  } catch {
    return { allowed: false, reason: "That is not a valid absolute URL." };
  }

  // An IP literal was already judged numerically by `assertPublicHttpsUrl`; there is nothing to resolve.
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return syntactic;

  let addresses: string[];
  try {
    const answers = await lookup(hostname);
    addresses = answers.map((a) => a.address);
  } catch {
    return { allowed: false, reason: "That host name could not be resolved, so it cannot be verified as public." };
  }
  return assertResolvedAddresses(addresses);
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** The ticket facts a payload may carry. Named columns only — there is no subject and no requester here. */
export type WebhookTicketFacts = {
  id: string;
  number: number;
  queue: QueueKey;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  brand: TicketBrand;
  createdAt: string;
  updatedAt: string;
};

export type WebhookPayload = {
  /** The `WebhookDelivery.id`, repeated in the `X-WMHD-Delivery` header, for at-least-once dedupe. */
  id: string;
  event: AuditAction;
  /** `AuditLog.seq` as a decimal string — it is a bigint, and JSON has no such number. */
  auditSeq: string;
  occurredAt: string;
  entity: { type: AuditEntityType; id: string | null };
  /** The NAME of the field that changed, when the action names one. Never its value. */
  field: string | null;
  /** Enum members only, and only for the three actions listed in `WEBHOOK_ENUM_VALUED_ACTIONS`. */
  from: string | null;
  to: string | null;
  ticket: WebhookTicketFacts | null;
  /** Deep link to the ticket, when a base URL is configured. Behind the session, and the read is audited. */
  link: string | null;
};

/** The audit-row facts a payload is built from. */
export type WebhookSourceEvent = {
  seq: bigint;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  fieldChanged: string | null;
  oldValue: string | null;
  newValue: string | null;
  occurredAt: Date;
  ticket: WebhookTicketFacts | null;
};

/** `<base>/tickets/wm/<number>`, or null when no base URL is configured. */
export function ticketDeepLink(ticketNumber: number, base: string | undefined): string | null {
  if (base === undefined || base.trim() === "") return null;
  return `${base.trim().replace(/\/+$/, "")}/tickets/wm/${ticketNumber}`;
}

/**
 * One delivery's payload. Key order is fixed by this literal, which is what makes `JSON.stringify`
 * deterministic and therefore what makes `payloadHash` reproducible.
 */
export function buildWebhookPayload(
  deliveryId: string,
  event: WebhookSourceEvent,
  base: string | undefined,
): WebhookPayload {
  const enumValued = carriesEnumValues(event.action);
  return {
    id: deliveryId,
    event: event.action,
    auditSeq: event.seq.toString(),
    occurredAt: event.occurredAt.toISOString(),
    entity: { type: event.entityType, id: event.entityId },
    field: event.fieldChanged,
    from: enumValued ? event.oldValue : null,
    to: enumValued ? event.newValue : null,
    ticket: event.ticket,
    link: event.ticket === null ? null : ticketDeepLink(event.ticket.number, base),
  };
}

export class WebhookPayloadPiiError extends Error {
  constructor(detail: string) {
    super(`Refusing to send a webhook payload: ${detail}`);
    this.name = "WebhookPayloadPiiError";
  }
}

/**
 * The mechanical backstop for §7.3, modelled on `assertPiiLight` in `src/jobs/slack.ts`.
 *
 * It is not a substitute for building the payload correctly — `buildWebhookPayload` selects named
 * columns for exactly that reason — but it is what turns "we were careful" into something a test can
 * assert and a future field addition cannot quietly get past. An `@` means an address got in; a
 * `sanitizePII` match means an account, card or Social Security number did.
 *
 * Three kinds since Decision #116, not seven. The same narrowing note on `assertPiiLight` in
 * `src/jobs/slack.ts` applies verbatim here: the failure this backstop is for is a future field
 * addition, and a routing number, date of birth, passport or licence number in one would now pass.
 *
 * The deep link is excluded from the scan: it is a URL this application composed out of a ticket
 * number, and a host name containing a hyphen-and-digits run is not client data.
 */
export function assertPayloadPiiLight(payload: WebhookPayload): void {
  const scanned = { ...payload, link: null };
  const text = JSON.stringify(scanned);
  if (text.includes("@")) throw new WebhookPayloadPiiError("it contains an '@'");
  const result = sanitizePII(text);
  if (result.redacted) throw new WebhookPayloadPiiError(`sanitizePII matched ${result.count} value(s)`);
}

/** The exact bytes signed and sent, and their sha256 — the value stored on `WebhookDelivery.payloadHash`. */
export function serializeWebhookPayload(payload: WebhookPayload): { body: string; hash: string } {
  assertPayloadPiiLight(payload);
  const body = JSON.stringify(payload);
  return { body, hash: sha256Hex(body) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ENDPOINT_SELECT = {
  id: true,
  name: true,
  url: true,
  secretPrefix: true,
  events: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  revokedAt: true,
} as const;

const DELIVERY_SELECT = {
  id: true,
  endpointId: true,
  auditSeq: true,
  eventAction: true,
  status: true,
  attempts: true,
  responseStatus: true,
  lastError: true,
  sentAt: true,
  createdAt: true,
} as const;

type EndpointRow = {
  id: string;
  name: string;
  url: string;
  secretPrefix: string;
  events: AuditAction[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

type DeliveryRow = {
  id: string;
  endpointId: string;
  auditSeq: bigint;
  eventAction: AuditAction;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
};

/** The DTO. Note what is NOT on it: `secretHash`, and any route back to the plaintext. */
export function toWebhookEndpointDTO(row: EndpointRow, recentFailures: number): WebhookEndpointDTO {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secretPrefix: row.secretPrefix,
    events: [...row.events],
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    recentFailures,
  };
}

export function toWebhookDeliveryDTO(row: DeliveryRow): WebhookDeliveryDTO {
  return {
    id: row.id,
    endpointId: row.endpointId,
    auditSeq: row.auditSeq.toString(),
    eventAction: row.eventAction,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    lastError: row.lastError,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Third check of `webhooks:admin`, after the middleware and the page: the server is authoritative. */
async function assertWebhookAdmin(viewer: Viewer, ctx: RequestContext, what: string): Promise<void> {
  if (canAdminWebhooks(viewer.groups)) return;
  await recordDenied(actorFromViewer(viewer), ctx, what);
  throw new ForbiddenError(`Forbidden: ${what}`);
}

/**
 * Every endpoint, live and revoked, for the admin page.
 *
 * Not a read of client material (§e "What counts as a view"): an endpoint row is configuration and has
 * never been near a ticket, so no view row is written — the same reasoning `listMacrosAdmin` applies.
 *
 * CONTRACT-GAP: §10 types this as `listWebhookEndpoints(viewer)`, with no `RequestContext`. A denial
 * has to be recorded before the throw, and `recordDenied` needs the context, so the parameter is
 * OPTIONAL here: callers that have a context pass it, and a caller with none still gets the refusal
 * (recorded against a synthesised context) rather than a silent pass. The contract's call shape
 * compiles unchanged.
 */
export async function listWebhookEndpoints(viewer: Viewer, ctx?: RequestContext): Promise<WebhookEndpointDTO[]> {
  await assertWebhookAdmin(viewer, ctx ?? adminReadContext(), "webhooks:admin list");

  const rows = (await prisma.webhookEndpoint.findMany({
    select: ENDPOINT_SELECT,
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
  })) as EndpointRow[];

  if (rows.length === 0) return [];

  // Rolling health, bounded by TIME rather than by a total. A lifetime count would keep an endpoint
  // that failed badly a year ago and has been healthy ever since permanently badged as failing — and
  // "it says 20 failing but it works" is how a health indicator stops being read at all. The window is
  // `WEBHOOK_HEALTH_WINDOW_DAYS`, served by the `[endpointId, createdAt]` index, in ONE grouped query
  // rather than N, and it is deliberately a COUNT: an admin list never carries a response body.
  const since = new Date(Date.now() - WEBHOOK_HEALTH_WINDOW_DAYS * 24 * 60 * 60_000);
  const failures = await prisma.webhookDelivery.groupBy({
    by: ["endpointId"],
    where: { status: { in: ["FAILED", "DEAD"] }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const failureByEndpoint = new Map(failures.map((f) => [f.endpointId, f._count._all]));

  return rows.map((row) => toWebhookEndpointDTO(row, failureByEndpoint.get(row.id) ?? 0));
}

/** A page of delivery history, newest first, optionally for one endpoint. */
export async function listWebhookDeliveries(
  viewer: Viewer,
  query: { endpointId?: string; limit?: number } = {},
  ctx?: RequestContext,
): Promise<WebhookDeliveryDTO[]> {
  await assertWebhookAdmin(viewer, ctx ?? adminReadContext(), "webhooks:admin deliveries");

  const take = Math.min(Math.max(query.limit ?? WEBHOOK_DELIVERY_PAGE_SIZE, 1), WEBHOOK_DELIVERY_PAGE_SIZE);
  const rows = (await prisma.webhookDelivery.findMany({
    where: query.endpointId === undefined ? {} : { endpointId: query.endpointId },
    select: DELIVERY_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  })) as DeliveryRow[];

  return rows.map(toWebhookDeliveryDTO);
}

/**
 * The context a denial is recorded against when a caller supplied none. Not a real request context and
 * does not pretend to be one — it names the surface, so a row written this way is legible rather than
 * blank.
 */
function adminReadContext(): RequestContext {
  return { ipAddress: "unknown", userAgent: "webhooks-admin-read", requestId: `webhooks-admin-${Date.now()}`, isPrefetch: false };
}

/** Guard for the admin UI's event picker: the catalog order, filtered to what may be subscribed to. */
export function subscribableActionsInCatalogOrder(): WebhookSubscribableAction[] {
  return AUDIT_ACTIONS.filter(isSubscribableAction);
}
