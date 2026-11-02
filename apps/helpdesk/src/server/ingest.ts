/**
 * Viewer-agnostic machine write path — node, layer L4.
 *
 * These cores are the ONE implementation of "a ticket / a message arrived from something that is not
 * a signed-in human". The ingest routes, the client-app routes and (once it lands) S2's email intake
 * all call them, so the routing defaults, the SLA stamping, the PII pass and the audit shape cannot
 * drift between channels. They take an `IngestCallContext` — an actor the ROUTE resolved from its
 * bearer, a request context and a `via` label — and never a `Viewer`: nothing here consults the RBAC
 * matrix, because a machine caller holds no groups and the route it runs in is what decides what it
 * may do.
 *
 * The rules that hold for every core in this file:
 *  - **Idempotency is a row, not a guess.** `(source, externalId)` is unique on `IngestReceipt` and
 *    the receipt is written in the SAME transaction as the thing it describes. A retry returns the
 *    same ids with `created: false`, and a retry that races its twin loses on the unique index and is
 *    resolved into the same answer rather than a duplicate.
 *  - **Idempotency never crosses a caller or a record.** The stored key is `ingestExternalKey`, which
 *    namespaces the multi-tenant `CLIENT_APP` id space by the requester, and a message core replays a
 *    receipt only when it names the ticket THIS call addressed. A hit that fails either test is a 409
 *    (`IngestExternalIdConflictError`), never an answer about somebody else's ticket.
 *  - **`sanitizePII` runs on every free-text field before any Prisma write**, and the audit rows
 *    record counts, never the redacted values.
 *  - **`writeAuditMany` is the LAST statement of the transaction** (§3 rule 2). Cores that other
 *    slices compose with return their entries rather than writing them twice.
 *  - **`metadata.via` on every row a MACHINE caller writes** (§3 rule 1), from `AUDIT_VIA`, plus the
 *    caller's `source`. A human calling a core (a reviewer releasing held mail) passes `via: null`
 *    and the key is OMITTED, so `metadata->>'via' IS NULL` keeps partitioning the ledger into
 *    "a person did this" and "a system did this".
 *  - **Nothing here transmits anything.** A PUBLIC staff message is persisted exactly as it will be
 *    delivered; the outbound `MessageDelivery` row is S3's, and the hook point is named in
 *    the build record.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  BODY_TRUNCATION_NOTE,
  DISCLAIMER_KEYS,
  INGEST_LIMITS,
  QUEUE_KEYS,
  REQUESTER_AUTHORED_SOURCES,
  TICKET_BRANDS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SOURCES,
} from "@/types/domain";
import type {
  AuditActor,
  AuditEntry,
  CommentVisibility,
  IngestMessageInput,
  IngestResult,
  IngestTicketInput,
  RequestContext,
  TicketCategory,
  TicketExportMessage,
  TicketExportPage,
  TicketExportRow,
  TicketSource,
  TicketStatus,
} from "@/types/domain";
import { writeAuditMany } from "@/lib/audit";
import type { AuditVia } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { prisma, withTx } from "@/lib/db";
import { appendDisclaimer } from "@/lib/disclaimers";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { readBodyWithCap } from "@/lib/http-body";
import { INTEGRATION_ACTOR_ID } from "@/lib/integration-auth";
import { logError } from "@/lib/logger";
import { formatPiiCounts, sanitizeFields, sanitizePII } from "@/lib/pii";
import { routeCategory } from "@/lib/routing";
import { computeDueDates, slaPolicyFor } from "@/lib/sla";
import { enqueueDelivery } from "@/server/outbox";
// --- Wave B call-site hooks (FOUNDATION STUBS with no-op defaults). The
// requester guard is L1 and pure; the other three are L4 cores that run inside this module's own
// transaction and RETURN their audit entries rather than writing them. ---
import { allowedRequesterDomains, env } from "@/lib/env";
import { assertRequesterAllowed } from "@/lib/requester-guard";
import { pickAutoAssignee } from "@/server/auto-assign";
import { notifyFromEvent } from "@/server/notifications";
import { maybeSendAutoAcknowledgement } from "@/server/system-messages";

// ---------------------------------------------------------------------------
// Call context
// ---------------------------------------------------------------------------

/**
 * `via` is `AuditVia | null`, not `AuditVia`: the key stays REQUIRED so every caller has to state
 * which side of §3 rule 1 it is on, and `null` means "a named human did this" — the rows this call
 * writes then carry no `via` at all, exactly like a staff action. The one human caller today is
 * `releaseHeldIntake` (a reviewer releasing held mail); every machine route passes an `AUDIT_VIA`
 * value. Widening recorded in the build record.
 *
 * `tokenId` is WHICH machine consumer did this: the id of the `ClientApiToken` the calling route
 * authenticated, from `machineAuthTokenId` in `src/lib/integration-auth.ts`. Optional and defaulting
 * to absent, because two kinds of caller legitimately have none — a named human, and a machine still
 * on the shared `INTEGRATION_API_TOKEN` env bearer — and their rows must keep saying so. The actor
 * columns are deliberately NOT affected: an ingest call stays attributed to the seeded
 * `svc_integration` identity, because attributing it to the token's creator would put a person's name
 * on a row nobody was present for. the build record makes that
 * argument and names `metadata` as where the id belongs.
 */
export type IngestCallContext = {
  actor: AuditActor;
  ctx: RequestContext;
  via: AuditVia | null;
  tokenId?: string | null;
};

/** Outcome string stored on `IngestReceipt.outcome`. */
export const INGEST_OUTCOMES = { ticket: "ticket", comment: "comment" } as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[keyof typeof INGEST_OUTCOMES];

/** The category a machine caller's ticket lands in when it names none. */
export const DEFAULT_INGEST_CATEGORY: TicketCategory = "OTHER";

/** Cap on a single ingested body BEFORE truncation, so an absurd payload is refused rather than trimmed. */
const BODY_HARD_MAX = 400_000;
/** Cap on a subject BEFORE truncation, same reasoning. */
const SUBJECT_HARD_MAX = 2_000;
const REQUESTER_NAME_MAX = 120;
const CLIENT_REFERENCE_MAX = 200;
const EXTERNAL_ID_MAX = 512;
const EXTERNAL_REF_MAX = 200;

// ---------------------------------------------------------------------------
// Validation (zod 4). Kept in this module rather than src/server/validation.ts: these schemas belong
// to the machine write path and nothing on the session surface parses them.
// ---------------------------------------------------------------------------

/** cuid / cuid2 / seed-style ids — the same shape `src/server/validation.ts` uses. */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

/** Trims before the format check (zod 4 runs the format check before `.trim()`), then lowercases. */
const emailSchema = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.email().toLowerCase());

/** E.164: `+` then 8..15 digits. The DB CHECK demands at least one of email / phone. */
const phoneSchema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164, e.g. +14155550123");

/** An upstream identifier: an RFC 5322 Message-ID, an n8n execution id, a client-app request id. */
const externalIdSchema = z.string().trim().min(1).max(EXTERNAL_ID_MAX);

/** An opaque advisor platform pointer: an id, never an account number and never a name. */
const pointerSchema = z.string().trim().min(1).max(128);

export const ingestTicketSchema: z.ZodType<IngestTicketInput, unknown> = z
  .object({
    // CLIENT-VISIBILITY-BEARING since Decision #117. `source` used to be routing metadata, and the worst
    // a wrong value did was mislabel a channel. It now also decides whether `description` is rendered
    // back to the named requester as THEIR OWN WORDS. This schema is shared by the trusted in-process
    // callers (`ingestInboundEmail`, the client app's own route, `logCall`) and by the HTTP machine
    // surface; the HTTP surface narrows it further with `assertMachineDeclaredSourceAllowed` below.
    source: z.enum(TICKET_SOURCES),
    externalId: externalIdSchema,
    subject: z.string().trim().min(1).max(SUBJECT_HARD_MAX),
    description: z.string().min(1).max(BODY_HARD_MAX),
    category: z.enum(TICKET_CATEGORIES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    queueKey: z.enum(QUEUE_KEYS).optional(),
    brand: z.enum(TICKET_BRANDS).optional(),
    requesterName: z.string().trim().min(1).max(REQUESTER_NAME_MAX),
    requesterEmail: emailSchema.nullable().optional(),
    requesterPhone: phoneSchema.nullable().optional(),
    clientReference: z.string().trim().max(CLIENT_REFERENCE_MAX).nullable().optional(),
    householdId: pointerSchema.nullable().optional(),
    requesterExternalId: pointerSchema.nullable().optional(),
    externalRef: z.string().trim().max(EXTERNAL_REF_MAX).nullable().optional(),
    linkedFromTicketId: idSchema.nullable().optional(),
  })
  // Mirrors the DB CHECK `ticket_requester_contact_present` so the caller gets a 422 naming the field
  // instead of a 500 from a constraint violation.
  .refine((v) => (v.requesterEmail ?? null) !== null || (v.requesterPhone ?? null) !== null, {
    message: "At least one of requesterEmail or requesterPhone is required",
    path: ["requesterEmail"],
  });

export const ingestMessageSchema: z.ZodType<IngestMessageInput, unknown> = z
  .object({
    ticketId: idSchema,
    source: z.enum(TICKET_SOURCES),
    externalId: externalIdSchema,
    authorKind: z.enum(["STAFF", "REQUESTER"]),
    authorEmail: emailSchema.nullable().optional(),
    body: z.string().min(1).max(BODY_HARD_MAX),
    visibility: z.enum(["INTERNAL", "PUBLIC"]).optional(),
    disclaimerKey: z.enum(DISCLAIMER_KEYS).optional(),
    senderAddress: emailSchema.nullable().optional(),
    // CONTRACT §1.2. A Message-ID is an opaque token, not an address: trimmed and length-bounded,
    // never parsed. 400 is the column's own bound; RFC 5322 sets no hard limit and real senders run
    // long. It is NOT validated for the `<...>` shape — a malformed id that still round-trips is more
    // useful for threading than a refused message, and nothing branches on its contents.
    inboundMessageId: z.string().trim().max(400).nullable().optional(),
  })
  .refine((v) => v.authorKind !== "STAFF" || (v.authorEmail ?? null) !== null, {
    message: "authorEmail is required for a STAFF-authored message",
    path: ["authorEmail"],
  })
  // A requester's own words never carry the firm's disclaimer and are never an internal note.
  .refine((v) => v.authorKind !== "REQUESTER" || (v.visibility ?? "PUBLIC") === "PUBLIC", {
    message: "A requester-authored message is always PUBLIC",
    path: ["visibility"],
  })
  .refine((v) => v.authorKind !== "REQUESTER" || (v.disclaimerKey ?? "NONE") === "NONE", {
    message: "A requester-authored message carries no disclaimer",
    path: ["disclaimerKey"],
  })
  // I7: a PUBLIC row is exactly what the client receives, so it must carry a real disclaimer.
  .refine(
    (v) => v.authorKind !== "STAFF" || (v.visibility ?? "INTERNAL") !== "PUBLIC" || (v.disclaimerKey ?? "NONE") !== "NONE",
    { message: "A PUBLIC staff message requires a disclaimer", path: ["disclaimerKey"] },
  );

// ---------------------------------------------------------------------------
// Caps and truncation
// ---------------------------------------------------------------------------

/** Subject cut at `INGEST_LIMITS.subjectMaxChars`. No note: a cut subject is visibly a cut subject. */
export function truncateSubject(raw: string): string {
  return raw.length <= INGEST_LIMITS.subjectMaxChars ? raw : raw.slice(0, INGEST_LIMITS.subjectMaxChars);
}

/**
 * Body cut at `INGEST_LIMITS.bodyMaxChars` with `BODY_TRUNCATION_NOTE` appended VERBATIM. The note is
 * part of the stored record on purpose: a reader can see that the desk truncated, rather than
 * concluding the client stopped mid-sentence.
 */
export function truncateBody(raw: string): { body: string; truncated: boolean } {
  if (raw.length <= INGEST_LIMITS.bodyMaxChars) return { body: raw, truncated: false };
  return { body: `${raw.slice(0, INGEST_LIMITS.bodyMaxChars)}${BODY_TRUNCATION_NOTE}`, truncated: true };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export type IngestReceiptRef = { ticketId: string | null; commentId: string | null; outcome: string };

/**
 * Raised when an `externalId` that has ALREADY been recorded is presented against a DIFFERENT ticket.
 *
 * It is a `ConflictError` subclass, so `toMachineErrorResponse` and `toActionError` map it to 409
 * exactly as before and no caller needs to learn a new code. It exists as its own class for one
 * reason: `addRequesterMessageOrFollowUp` answers a plain `ConflictError` by opening a linked
 * follow-up ticket, and "this id is already spent on another ticket" must never be
 * mistaken for "this ticket is closed" — that would mint a ticket for a message refused for an
 * entirely different reason.
 */
export class IngestExternalIdConflictError extends ConflictError {
  constructor(message = "externalId is already recorded against a different ticket") {
    super(message);
    this.name = "IngestExternalIdConflictError";
  }
}

/**
 * Sources whose `externalId` namespace is chosen by an untrusted, MULTI-TENANT caller.
 *
 * `IngestReceipt` and `Ticket` are both unique on `(source, externalId)` ALONE. For `EMAIL` that key
 * is an RFC 5322 Message-ID and for `API` an n8n execution id: one trusted upstream owns the whole
 * namespace, so a repeat genuinely is a retry of the same upstream event. `CLIENT_APP` is different
 * in kind — the value is the mobile app's own request id and EVERY client of that app shares the
 * namespace. A counter that resets on reinstall, or a fixture id that reaches production, makes two
 * different people present the same string. Keyed globally, the second person is handed the first
 * person's ticket id and WM number and their own message is silently discarded, which on a
 * books-and-records system is both a disclosure and a lost record.
 *
 * So a `CLIENT_APP` receipt is stored under a key that carries the requester's identity. The scope is
 * hashed rather than stored in the clear — the key also lands on `Ticket.externalId`, which the staff
 * `TicketDetailDTO` carries — and the caller's raw id is kept as a readable suffix so an operator can
 * still grep for the id the app reported.
 *
 * NOTE (behaviour change, recorded in the build record): `CLIENT_APP`
 * rows written before this change hold the RAW id, so a replay of one of them creates a new ticket
 * instead of replaying. Nothing is in production, so there is nothing to backfill.
 */
const REQUESTER_SCOPED_SOURCES: ReadonlySet<TicketSource> = new Set<TicketSource>(["CLIENT_APP"]);
const REQUESTER_SCOPE_PREFIX = "capp~";
const REQUESTER_SCOPE_DIGEST_CHARS = 16;

/**
 * The requester identity a scoped key is namespaced by: the email when there is one (normalised the
 * way every comparison on this surface normalises it), else the E.164 phone, else null. Null is only
 * reachable for a row that has neither, which the DB CHECK `ticket_requester_contact_present` forbids.
 */
export function requesterScopeOf(requester: {
  requesterEmail?: string | null;
  requesterPhone?: string | null;
}): string | null {
  const email = (requester.requesterEmail ?? "").trim().toLowerCase();
  if (email.length > 0) return email;
  const phone = (requester.requesterPhone ?? "").trim();
  return phone.length > 0 ? phone : null;
}

/**
 * The value written to BOTH `IngestReceipt.externalId` and `Ticket.externalId`, and the value every
 * idempotency lookup in this module uses. Identity for the single-tenant sources; requester-scoped
 * for `CLIENT_APP`. Deterministic, so the same caller retrying the same request derives the same key
 * and still gets a replay — and the two unique indexes over `(source, externalId)` cannot disagree
 * about which rows collide.
 */
export function ingestExternalKey(source: TicketSource, externalId: string, requesterScope: string | null): string {
  if (!REQUESTER_SCOPED_SOURCES.has(source)) return externalId;
  const digest = createHash("sha256")
    .update(requesterScope ?? "", "utf8")
    .digest("hex")
    .slice(0, REQUESTER_SCOPE_DIGEST_CHARS);
  return `${REQUESTER_SCOPE_PREFIX}${digest}~${externalId}`;
}

/**
 * Idempotency lookup. `externalId` is the KEY `ingestExternalKey` derived, not necessarily the raw
 * value the caller sent. Null when this `(source, key)` has not been seen.
 */
export async function findIngestReceipt(source: TicketSource, externalId: string): Promise<IngestReceiptRef | null> {
  const receipt = await prisma.ingestReceipt.findUnique({
    where: { source_externalId: { source, externalId } },
    select: { ticketId: true, commentId: true, outcome: true },
  });
  return receipt;
}

/** Prisma's unique-constraint violation, detected structurally so this module never value-imports @prisma/client. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

/**
 * Turns a receipt into the `IngestResult` a replay answers with. The ticket number is re-read because
 * the receipt stores ids, not the human reference. A receipt whose ticket has since vanished is
 * impossible (the FK is `onDelete: Restrict` and tickets are never deleted), so a miss is INTERNAL.
 */
async function replayResult(receipt: IngestReceiptRef): Promise<IngestResult> {
  if (receipt.ticketId === null) {
    throw new AppError("INTERNAL", "ingest receipt has no ticket", 500);
  }
  const ticket = await prisma.ticket.findUnique({
    where: { id: receipt.ticketId },
    select: { id: true, number: true },
  });
  if (ticket === null) throw new AppError("INTERNAL", "ingest receipt points at a missing ticket", 500);
  return {
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    commentId: receipt.commentId,
    created: false,
    reopened: false,
    piiRedacted: false,
    piiRedactionCount: 0,
  };
}

/**
 * Resolves a receipt hit on a MESSAGE core. A receipt is a replay of *this* call only when it names
 * the ticket this call addressed. One that names a different ticket is an id collision, and answering
 * it with `replayResult` would return a ticket the caller was never authorized for on this request
 * while silently dropping the message they actually sent. Refuse instead: 409, nothing written.
 */
async function replayForTicket(receipt: IngestReceiptRef, ticketId: string): Promise<IngestResult> {
  if (receipt.ticketId !== ticketId) throw new IngestExternalIdConflictError();
  return replayResult(receipt);
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Every machine-written row carries `via` and the channel that produced it (§3 rule 1). A human
 * caller (`via: null`) gets NO `via` key — not `via: null` — so the ledger partition is a plain
 * `metadata->>'via' IS NULL`. `source` stays either way: the channel a record arrived on is a fact
 * about the record, not a claim about who acted.
 */
function withVia(call: IngestCallContext, source: TicketSource, extra?: Prisma.InputJsonObject): Prisma.InputJsonObject {
  return {
    ...(call.via === null ? {} : { via: call.via }),
    source,
    // Absent — never null, never a placeholder — when the caller named no credential, so
    // `metadata ? 'tokenId'` partitions the ledger into attributed and shared-bearer machine rows
    // the same way `metadata->>'via' IS NULL` partitions it into human and machine ones.
    ...(call.tokenId === undefined || call.tokenId === null ? {} : { tokenId: call.tokenId }),
    ...(extra ?? {}),
  };
}

function piiEntry(
  entityType: "TICKET" | "COMMENT",
  entityId: string,
  ticketId: string,
  fieldChanged: string,
  byKind: Parameters<typeof formatPiiCounts>[0],
  metadata: Prisma.InputJsonObject,
): AuditEntry {
  return {
    action: "PII_REDACTED",
    entityType,
    entityId,
    ticketId,
    fieldChanged,
    oldValue: null,
    newValue: formatPiiCounts(byKind),
    metadata,
  };
}

/**
 * `Ticket.createdById` is a required FK, but not every machine caller has a User row: the client-app
 * path audits as `client:<requesterEmail>` (actorId null), exactly as the existing client GET does.
 * Such a call is still a write BY the desk's integration identity, so that is what creates the row.
 * CONTRACT-GAP: `IngestCallContext` carries only an `AuditActor`, and the contract does not say which
 * User owns a client-app ticket; recorded in the build record.
 */
async function resolveCreatorId(tx: DbTx, actor: AuditActor): Promise<string> {
  if (actor.id !== null) return actor.id;
  const fallback = await tx.user.findUnique({ where: { id: INTEGRATION_ACTOR_ID }, select: { id: true } });
  if (fallback === null) throw new AppError("INTERNAL", "integration actor is not provisioned", 500);
  return fallback.id;
}

// ---------------------------------------------------------------------------
// createTicketCore
// ---------------------------------------------------------------------------

/**
 * Viewer-agnostic ticket creation. `sanitizePII` on every free-text field, `ROUTING_TABLE` defaults
 * for queue and priority, SLA stamping identical to the staff `createTicket` path, and the
 * `IngestReceipt` written in the SAME transaction as the ticket. A replay of `(source, externalId)`
 * returns the existing ids with `created: false` — never a duplicate.
 */
/**
 * Decision #117. Refuses a REQUESTER-AUTHORED source declared by an HTTP machine caller.
 *
 * `POST /api/ingest/tickets` takes `source` straight from the request body and authorises on a single
 * INGEST-scoped credential. Once the opening entry exists, that field is a client-visibility control:
 * a caller who could post `source: "EMAIL"` with any `description` could have arbitrary text rendered
 * to the named requester as the message they sent, first in their thread, labelled "You".
 *
 * Nothing legitimate loses anything. The two channels whose description really is the requester's own
 * words do NOT come through this route: inbound mail is `ingestInboundEmail` calling `createTicketCore`
 * in process, and the client app is `POST /api/client/tickets`, which authenticates the CLIENT and sets
 * `CLIENT_APP` itself rather than accepting it from a body. Every in-tree n8n workflow declares
 * `VOICEMAIL`, `API` or `SLACK`, all excluded — so this refusal is a no-op for them today and the point
 * is that it stays one after somebody edits a workflow in the n8n UI.
 *
 * Thrown as a ValidationError so the route answers 422 with the field named, like any other bad body.
 */
export function assertMachineDeclaredSourceAllowed(source: TicketSource): void {
  if (!(REQUESTER_AUTHORED_SOURCES as readonly TicketSource[]).includes(source)) return;
  throw new ValidationError("this source cannot be declared by a machine caller", {
    source: [
      `${source} means the body is the requester's own words, which this surface cannot vouch for. Inbound mail and the client app have their own paths.`,
    ],
  });
}

export async function createTicketCore(input: IngestTicketInput, call: IngestCallContext): Promise<IngestResult> {
  const data = ingestTicketSchema.parse(input);

  // Wave B, carried from Wave A CONTRACT §14 as a REQUESTED call site. On a dev or
  // local instance with `ALLOWED_REQUESTER_DOMAINS` set, an address outside the list cannot become a
  // ticket at all — which is what stops a seeded fixture that looks like a real client from ever
  // acquiring a real outbound address. Unset (production) is a no-op. Checked BEFORE the receipt
  // lookup so a refused address never even records an idempotency row.
  assertRequesterAllowed(data.requesterEmail ?? null, allowedRequesterDomains(env.ALLOWED_REQUESTER_DOMAINS));

  // Requester-scoped on the multi-tenant surfaces, identity elsewhere. The SAME key is used for the
  // receipt and for `Ticket.externalId`, so the two unique indexes over `(source, externalId)` agree
  // about which rows collide — and one client's request id can never resolve to another's ticket.
  const externalKey = ingestExternalKey(data.source, data.externalId, requesterScopeOf(data));

  const existing = await findIngestReceipt(data.source, externalKey);
  if (existing !== null) return replayResult(existing);

  const category = data.category ?? DEFAULT_INGEST_CATEGORY;
  const routed = routeCategory(category);
  const queueKey = data.queueKey ?? routed.queueKey;
  const priority = data.priority ?? routed.priority;
  const brand = data.brand ?? "CEDAR_RIDGE_WEALTH";

  // Cut to the stored caps BEFORE sanitizing, so the note lands at the end of the stored body and a
  // redaction token can never be cut in half by the truncation that follows it.
  const subjectRaw = truncateSubject(data.subject);
  const bodyRaw = truncateBody(data.description);

  // I4: every persisted free-text field goes through sanitizePII before any Prisma write. Contact
  // data (email, phone) is validated, not redacted — by definition it is not a redaction target.
  const s = sanitizeFields({
    subject: subjectRaw,
    description: bodyRaw.body,
    clientReference: data.clientReference ?? null,
    requesterName: data.requesterName,
    externalRef: data.externalRef ?? null,
  });
  const subject = s.values.subject ?? subjectRaw;
  const description = s.values.description ?? bodyRaw.body;
  const clientReference = emptyToNull(s.values.clientReference);
  const requesterName = s.values.requesterName ?? data.requesterName;
  const externalRef = emptyToNull(s.values.externalRef);

  const now = new Date();

  const run = async (): Promise<IngestResult> =>
    withTx(async (tx) => {
      const queue = await tx.queue.findUnique({ where: { key: queueKey }, select: { id: true } });
      if (queue === null) throw new NotFoundError(`queue ${queueKey} is not provisioned`);

      // A follow-up must point at a ticket that exists; the DB CHECK only stops self-reference.
      if (data.linkedFromTicketId) {
        const parent = await tx.ticket.findUnique({ where: { id: data.linkedFromTicketId }, select: { id: true } });
        if (parent === null) throw new NotFoundError("linkedFromTicketId does not exist");
      }

      const policy = slaPolicyFor(priority, await tx.sLA.findUnique({ where: { priority } }));
      const due = computeDueDates(now, policy);
      const createdById = await resolveCreatorId(tx, call.actor);

      const ticket = await tx.ticket.create({
        data: {
          subject,
          description,
          clientReference,
          requesterName,
          requesterEmail: data.requesterEmail ?? null,
          requesterPhone: data.requesterPhone ?? null,
          brand,
          source: data.source,
          externalId: externalKey,
          householdId: data.householdId ?? null,
          requesterExternalId: data.requesterExternalId ?? null,
          externalRef,
          linkedFromTicketId: data.linkedFromTicketId ?? null,
          category,
          priority,
          status: "NEW",
          queueId: queue.id,
          createdById,
          assigneeId: null,
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

      await tx.ingestReceipt.create({
        data: {
          source: data.source,
          externalId: externalKey,
          ticketId: ticket.id,
          commentId: null,
          outcome: INGEST_OUTCOMES.ticket,
        },
      });

      // --- Wave B call-site hooks. All three are FOUNDATION STUBS with no-op defaults, and all three
      // run INSIDE this transaction so a ticket, its assignment and its acknowledgement cannot exist
      // in three different states. Each returns what the caller must audit rather than auditing
      // itself, so the trailing `writeAuditMany` stays the last statement (CONTRACT §3 rule 2). ---
      const autoAssigneeId = await pickAutoAssignee(tx, {
        queueKey,
        queueId: queue.id,
        ticketId: ticket.id,
      });

      // The audit records the id the CALLER sent, plus the derived key when the two differ, so a
      // reader can reconcile a client-reported request id with the row that was actually written.
      const metadata = withVia(call, data.source, {
        externalId: data.externalId,
        ...(externalKey === data.externalId ? {} : { externalKey, requesterScoped: true }),
      });
      const entries: AuditEntry[] = [
        {
          action: "TICKET_INGESTED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          oldValue: null,
          newValue: JSON.stringify({
            source: data.source,
            externalId: data.externalId,
            category,
            priority,
            queueKey,
            brand,
          }),
          metadata: { ...metadata, truncated: bodyRaw.truncated },
        },
      ];
      if (data.linkedFromTicketId) {
        entries.push({
          action: "TICKET_LINKED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "linkedFromTicketId",
          oldValue: null,
          newValue: data.linkedFromTicketId,
          metadata,
        });
      }
      if (s.redacted) {
        entries.push(piiEntry("TICKET", ticket.id, ticket.id, s.redactedFields.join(","), s.byKind, metadata));
      }

      // the auto-assignment decided above is applied here, with its own audit row, so
      // "who assigned this" answers "the desk did, by rule" rather than naming an innocent person.
      if (autoAssigneeId !== null) {
        await tx.ticket.update({ where: { id: ticket.id }, data: { assigneeId: autoAssigneeId } });
        entries.push({
          action: "TICKET_ASSIGNED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "assigneeId",
          oldValue: null,
          newValue: autoAssigneeId,
          metadata: { ...metadata, reason: "auto" },
        });
        const assignedNotice = await notifyFromEvent(tx, {
          kind: "ASSIGNED",
          ticketId: ticket.id,
          preview: `Assigned to you: HD-${ticket.number}`,
          actorId: null,
          recipientIds: [autoAssigneeId],
        });
        entries.push(...assignedNotice.auditEntries);
      }

      // the auto-acknowledgement. SYSTEM-authored, never stamps firstRespondedAt, enqueued
      // through the outbox in THIS transaction, and a no-op unless AUTO_ACK_ENABLED is set.
      const ack = await maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number });
      if (ack) entries.push(...ack.auditEntries);

      await writeAuditMany(tx, call.actor, call.ctx, entries);

      return {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        commentId: null,
        created: true,
        reopened: false,
        piiRedacted: s.redacted,
        piiRedactionCount: s.count,
      };
    });

  try {
    return await run();
  } catch (e) {
    // Two identical calls in flight at once: one wins the `(source, externalId)` unique index and the
    // other lands here. Resolve it into the winner's answer rather than a duplicate or a 500.
    if (!isUniqueViolation(e)) throw e;
    const raced = await findIngestReceipt(data.source, externalKey);
    if (raced === null) throw e;
    return replayResult(raced);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type TicketForMessage = {
  id: string;
  number: number;
  status: TicketStatus;
  queueId: string;
  subject: string;
  category: TicketCategory;
  brand: (typeof TICKET_BRANDS)[number];
  requesterName: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  householdId: string | null;
  requesterExternalId: string | null;
  resolvedAt: Date | null;
};

const TICKET_FOR_MESSAGE_SELECT = {
  id: true,
  number: true,
  status: true,
  queueId: true,
  subject: true,
  category: true,
  brand: true,
  requesterName: true,
  requesterEmail: true,
  requesterPhone: true,
  householdId: true,
  requesterExternalId: true,
  resolvedAt: true,
} as const;

/** Loads the ticket a machine-authored message targets. NotFoundError (404) when it does not exist. */
export async function loadTicketForIngest(ticketId: string): Promise<TicketForMessage> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: TICKET_FOR_MESSAGE_SELECT });
  if (ticket === null) throw new NotFoundError("ticket not found");
  return ticket;
}

/**
 * A requester-authored PUBLIC message. `authorKind` REQUESTER, `authorId` null, `disclaimerKey` NONE
 * (a client's own words never carry the firm's disclaimer), and it NEVER stamps `firstRespondedAt` —
 * a client writing to us is not the desk responding, and letting it satisfy the SLA would make the
 * first-response number a lie.
 *
 * Status rule (S2 relies on it): `PENDING_CLIENT → OPEN`; `RESOLVED → OPEN` **and** a
 * `TICKET_REOPENED_BY_REQUESTER` row; `NEW` and `OPEN` unchanged; `PENDING_INTERNAL` unchanged (the
 * desk is waiting on itself, not the client); `CLOSED` REFUSES with a ConflictError — the caller opens
 * a NEW ticket with `linkedFromTicketId` set. `addRequesterMessageOrFollowUp` below is
 * that composition, and is what the routes call.
 *
 * Both status moves are CONDITIONAL `updateMany` writes (no read-then-write); their audit rows
 * are emitted only when `count === 1`.
 */
export async function addRequesterMessageCore(
  input: IngestMessageInput,
  call: IngestCallContext,
): Promise<IngestResult> {
  const data = ingestMessageSchema.parse(input);
  if (data.authorKind !== "REQUESTER") {
    throw new ValidationError("addRequesterMessageCore requires authorKind REQUESTER", {
      authorKind: ["Expected REQUESTER"],
    });
  }

  // The addressed ticket is loaded BEFORE the idempotency lookup, because the lookup is only
  // meaningful relative to it: the receipt key is namespaced by this ticket's requester on the
  // multi-tenant surfaces, and a receipt naming a DIFFERENT ticket is a collision, not a replay.
  // Replaying it would answer with a ticket this caller was never authorized for and drop the message
  // they actually sent — the route's own requester-equality check is on the PATH ticket and cannot see
  // past a core that short-circuits on a globally-keyed receipt.
  const ticket = await loadTicketForIngest(data.ticketId);
  const externalKey = ingestExternalKey(data.source, data.externalId, requesterScopeOf(ticket));

  const existing = await findIngestReceipt(data.source, externalKey);
  if (existing !== null) return replayForTicket(existing, ticket.id);

  // a reply to a CLOSED ticket never reopens it. CLOSED is terminal and a closed record
  // is a closed record; the continuation is a new, linked ticket. Checked AFTER the replay lookup so a
  // retry of a message that landed before the ticket closed still answers with what it wrote.
  if (ticket.status === "CLOSED") {
    throw new ConflictError("ticket is closed; open a linked follow-up instead");
  }

  const bodyRaw = truncateBody(data.body);
  const sanitized = sanitizePII(bodyRaw.body);
  const metadata = withVia(call, data.source, {
    externalId: data.externalId,
    truncated: bodyRaw.truncated,
    // The actor on COMMENT_ADDED_REQUESTER is the machine identity, so the sending address is the
    // only thing on the row that says where the client's words came in from.
    senderAddress: data.senderAddress ?? null,
    ...(externalKey === data.externalId ? {} : { externalKey, requesterScoped: true }),
  });

  const run = async (): Promise<IngestResult> =>
    withTx(async (tx) => {
      // Atomic CLOSED re-check and the single version bump. Under READ COMMITTED this is
      // evaluated at write time and holds the row lock until commit, so a concurrent close cannot let
      // a client message land on a closed record. count 0 → the ticket changed → refuse.
      const guard = await tx.ticket.updateMany({
        where: { id: ticket.id, status: { not: "CLOSED" } },
        data: {
          version: { increment: 1 },
          ...(sanitized.redacted ? { piiRedacted: true, piiRedactionCount: { increment: sanitized.count } } : {}),
        },
      });
      if (guard.count === 0) throw new ConflictError("ticket is closed; open a linked follow-up instead");

      const comment = await tx.comment.create({
        data: {
          ticketId: ticket.id,
          authorId: null,
          authorKind: "REQUESTER",
          visibility: "PUBLIC",
          body: sanitized.text,
          disclaimerKey: "NONE",
          macroId: null,
          piiRedacted: sanitized.redacted,
          piiRedactionCount: sanitized.count,
          // CONTRACT §1.2: the inbound Message-ID, written at creation because a comment is immutable
          // and G5 leaves no later moment. `threadHeadersFor` reads this column FIRST and falls
          // back to the EMAIL `IngestReceipt.externalId`, which is the same value for every row
          // written before this line existed — so threading is correct for the whole history, not
          // only from here on.
          inboundMessageId: data.inboundMessageId ?? null,
        },
        select: { id: true, createdAt: true },
      });

      // PENDING_CLIENT → OPEN: the desk was waiting on the client and the client answered. Not a
      // reopen — the ticket was never resolved — so it audits as an ordinary status change.
      const unblocked = await tx.ticket.updateMany({
        where: { id: ticket.id, status: "PENDING_CLIENT" },
        data: { status: "OPEN" },
      });
      // RESOLVED → OPEN: a genuine reopen. `resolvedAt` is cleared for the same reason the staff path
      // clears it — a ticket with `resolvedAt` set reads as COMPLETE to computeSlaStatus.
      const reopened = await tx.ticket.updateMany({
        where: { id: ticket.id, status: "RESOLVED" },
        data: { status: "OPEN", resolvedAt: null },
      });

      await tx.ingestReceipt.create({
        data: {
          source: data.source,
          externalId: externalKey,
          ticketId: ticket.id,
          commentId: comment.id,
          outcome: INGEST_OUTCOMES.comment,
        },
      });

      const entries: AuditEntry[] = [
        {
          action: "COMMENT_ADDED_REQUESTER",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: sanitized.text,
          metadata,
        },
      ];
      if (sanitized.redacted) {
        entries.push(piiEntry("COMMENT", comment.id, ticket.id, "body", sanitized.byKind, metadata));
      }
      if (unblocked.count === 1) {
        entries.push({
          action: "TICKET_STATUS_CHANGED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "status",
          oldValue: "PENDING_CLIENT",
          newValue: "OPEN",
          metadata,
        });
      }
      if (reopened.count === 1) {
        entries.push({
          action: "TICKET_REOPENED_BY_REQUESTER",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "status",
          oldValue: "RESOLVED",
          newValue: "OPEN",
          metadata,
        });
        entries.push({
          action: "TICKET_FIELD_CHANGED",
          entityType: "TICKET",
          entityId: ticket.id,
          ticketId: ticket.id,
          fieldChanged: "resolvedAt",
          oldValue: ticket.resolvedAt === null ? null : ticket.resolvedAt.toISOString(),
          newValue: null,
          metadata,
        });
      }

      // the client answered. This is the notification the desk most needs and the one a Slack
      // channel does worst — it belongs to the ticket's assignee and followers, not to a room. Inside
      // the transaction, returning its entries, no-op until B1 lands.
      const replyNotice = await notifyFromEvent(tx, {
        kind: "REQUESTER_REPLY",
        ticketId: ticket.id,
        commentId: comment.id,
        preview: `Client replied on HD-${ticket.number}`,
        actorId: null,
      });
      entries.push(...replyNotice.auditEntries);

      await writeAuditMany(tx, call.actor, call.ctx, entries);

      return {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        commentId: comment.id,
        created: true,
        reopened: unblocked.count === 1 || reopened.count === 1,
        piiRedacted: sanitized.redacted,
        piiRedactionCount: sanitized.count,
      };
    });

  try {
    return await run();
  } catch (e) {
    // The twin that lost the `(source, externalId)` race. Resolve it into the winner's answer — but
    // only when the winner is THIS ticket; otherwise it is the same collision, reached concurrently.
    if (!isUniqueViolation(e)) throw e;
    const raced = await findIngestReceipt(data.source, externalKey);
    if (raced === null) throw e;
    return replayForTicket(raced, ticket.id);
  }
}

export type RequesterMessageOutcome = {
  result: IngestResult;
  /** Set when the reply landed on a CLOSED ticket and opened a NEW ticket pointing back at it. */
  linkedFromTicketId: string | null;
};

/**
 * The composition every route uses: reply on the ticket when it can take one, and open the linked
 * follow-up when it cannot. Kept here rather than in each route so the two client
 * channels and S2's email intake cannot implement Decision #70 three different ways.
 *
 * The follow-up inherits the closed ticket's subject, requester, brand, category and the advisor platform pointers —
 * everything except its status and its history. `externalId` is consumed by the follow-up's receipt,
 * so a retry of the same upstream message still returns the same (new) ticket.
 */
export async function addRequesterMessageOrFollowUp(
  input: IngestMessageInput,
  call: IngestCallContext,
): Promise<RequesterMessageOutcome> {
  try {
    return { result: await addRequesterMessageCore(input, call), linkedFromTicketId: null };
  } catch (e) {
    // An id collision is NOT "the ticket is closed". Opening a follow-up for it would mint a ticket
    // for a message that was refused for an entirely different reason, under an externalId already
    // spent — so it is rethrown as the 409 it is, before the CLOSED branch can claim it.
    if (e instanceof IngestExternalIdConflictError) throw e;
    if (!(e instanceof ConflictError)) throw e;
    const closed = await loadTicketForIngest(input.ticketId);
    if (closed.status !== "CLOSED") throw e;
    const followUp: IngestTicketInput = {
      source: input.source,
      externalId: input.externalId,
      subject: closed.subject,
      description: input.body,
      category: closed.category,
      brand: closed.brand,
      requesterName: closed.requesterName,
      requesterEmail: closed.requesterEmail,
      requesterPhone: closed.requesterPhone,
      householdId: closed.householdId,
      requesterExternalId: closed.requesterExternalId,
      linkedFromTicketId: closed.id,
    };
    return { result: await createTicketCore(followUp, call), linkedFromTicketId: closed.id };
  }
}

/**
 * A staff-authored message from a machine caller — a CS agent replying through an integration rather
 * than through the app. `authorEmail` must resolve to an ACTIVE User: a message attributed to a named
 * person has to be attributable to a real, current one, and the DB CHECK `comment_staff_has_author`
 * refuses a STAFF row without an author anyway.
 *
 * INTERNAL is the default, and INTERNAL is allowed on a CLOSED ticket (§b.9: a closed record stays
 * annotatable). PUBLIC requires a non-NONE disclaimer, whose text is appended so the stored row is
 * exactly what the client receives, refuses on a CLOSED ticket, and stamps `firstRespondedAt`
 * through the same conditional write the staff `addPublicReply` uses.
 *
 * A PUBLIC row on a ticket that HAS a deliverable address also enqueues its outbound delivery through
 * S3's `enqueueDelivery`, inside the same transaction, taking its returned `AuditEntry` so the single
 * trailing `writeAuditMany` is still the last statement (§3 rule 2). Nothing is sent here: the row
 * sits QUEUED until a poller leases it. A phone-only ticket gets the comment and no delivery — there
 * is nowhere to deliver it — and that is recorded in the audit metadata rather than guessed at.
 */
export async function addStaffMessageCore(input: IngestMessageInput, call: IngestCallContext): Promise<IngestResult> {
  const data = ingestMessageSchema.parse(input);
  if (data.authorKind !== "STAFF") {
    throw new ValidationError("addStaffMessageCore requires authorKind STAFF", { authorKind: ["Expected STAFF"] });
  }
  const authorEmail = data.authorEmail ?? null;
  if (authorEmail === null) {
    throw new ValidationError("authorEmail is required for a STAFF-authored message", {
      authorEmail: ["Required for a STAFF-authored message"],
    });
  }

  const visibility: CommentVisibility = data.visibility ?? "INTERNAL";
  const disclaimerKey = data.disclaimerKey ?? "NONE";
  if (visibility === "PUBLIC" && disclaimerKey === "NONE") {
    throw new ValidationError("A PUBLIC staff message requires a disclaimer", {
      disclaimerKey: ["Select a disclaimer; a public reply is what the client receives"],
    });
  }

  // Same ordering rule as the requester core: the ticket first, then an idempotency lookup that is
  // scoped to it. A receipt naming another ticket is a collision, not a replay, and must never be
  // answered with that other ticket's ids. The author lookup stays BEHIND the replay check so a
  // genuine retry is not refused because the agent was deactivated in the meantime.
  const ticket = await loadTicketForIngest(data.ticketId);
  const externalKey = ingestExternalKey(data.source, data.externalId, requesterScopeOf(ticket));

  const existing = await findIngestReceipt(data.source, externalKey);
  if (existing !== null) return replayForTicket(existing, ticket.id);

  const author = await prisma.user.findUnique({
    where: { email: authorEmail },
    select: { id: true, isActive: true },
  });
  if (author === null || !author.isActive) {
    throw new ValidationError("authorEmail does not resolve to an active user", {
      authorEmail: ["Unknown or deactivated user"],
    });
  }

  if (visibility === "PUBLIC" && ticket.status === "CLOSED") {
    throw new ConflictError("ticket is closed");
  }

  const bodyRaw = truncateBody(data.body);
  // Sanitize BEFORE appending the disclaimer: the disclaimer text is code, never a redaction target.
  const sanitized = sanitizePII(bodyRaw.body);
  const stored = visibility === "PUBLIC" ? appendDisclaimer(sanitized.text, disclaimerKey) : sanitized.text;
  const metadata = withVia(call, data.source, {
    externalId: data.externalId,
    truncated: bodyRaw.truncated,
    ...(visibility === "PUBLIC" ? { disclaimerKey } : {}),
    ...(externalKey === data.externalId ? {} : { externalKey, requesterScoped: true }),
  });

  const run = async (): Promise<IngestResult> =>
    withTx(async (tx) => {
      const guard = await tx.ticket.updateMany({
        where: { id: ticket.id, ...(visibility === "PUBLIC" ? { status: { not: "CLOSED" as const } } : {}) },
        data: {
          version: { increment: 1 },
          ...(sanitized.redacted ? { piiRedacted: true, piiRedactionCount: { increment: sanitized.count } } : {}),
        },
      });
      if (guard.count === 0) throw new ConflictError("ticket is closed");

      // The guard above is an UPDATE, so it holds this ticket's row lock until commit. Re-read the
      // delivery fields from BEHIND that lock rather than from the pre-transaction snapshot:
      // `updateTicketFields` can change `requesterEmail` concurrently and the guard does not pin it,
      // so a snapshot read can queue a client-facing reply to a superseded address — precisely the
      // failure an address-change or fraud ticket is about.
      const pinned = await tx.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
        select: { requesterEmail: true, brand: true, subject: true, number: true },
      });

      const comment = await tx.comment.create({
        data: {
          ticketId: ticket.id,
          authorId: author.id,
          authorKind: "STAFF",
          visibility,
          body: stored,
          disclaimerKey,
          macroId: null,
          piiRedacted: sanitized.redacted,
          piiRedactionCount: sanitized.count,
        },
        select: { id: true, createdAt: true },
      });

      // S3's outbox row, in THIS transaction, returning its entry rather than writing it (§3 rule 2).
      let deliveryEntry: AuditEntry | null = null;
      if (visibility === "PUBLIC" && pinned.requesterEmail !== null) {
        const queued = await enqueueDelivery(tx, {
          ticketId: ticket.id,
          ticketNumber: pinned.number,
          brand: pinned.brand,
          toAddress: pinned.requesterEmail,
          subject: pinned.subject,
          commentId: comment.id,
          body: stored,
          // §3 rule 1: the delivery's MESSAGE_QUEUED row carries the same `via`/`source` as the
          // COMMENT_ADDED_PUBLIC row it is written beside, so `metadata->>'via' IS NULL` still
          // partitions the ledger into human and machine rows. A human caller (`via: null`) passes
          // nothing, which is what `enqueueDelivery` already does for the staff composer.
          via: call.via ?? undefined,
          source: data.source,
        });
        deliveryEntry = queued.auditEntry;
      }

      let firstResponseStamped = false;
      let autoOpened = false;
      if (visibility === "PUBLIC") {
        const stamp = await tx.ticket.updateMany({
          where: { id: ticket.id, firstRespondedAt: null, status: { not: "CLOSED" } },
          data: { firstRespondedAt: comment.createdAt },
        });
        firstResponseStamped = stamp.count === 1;
        const opened = await tx.ticket.updateMany({ where: { id: ticket.id, status: "NEW" }, data: { status: "OPEN" } });
        autoOpened = opened.count === 1;
      }

      await tx.ingestReceipt.create({
        data: {
          source: data.source,
          externalId: externalKey,
          ticketId: ticket.id,
          commentId: comment.id,
          outcome: INGEST_OUTCOMES.comment,
        },
      });

      const entries: AuditEntry[] = [
        {
          action: visibility === "PUBLIC" ? "COMMENT_ADDED_PUBLIC" : "COMMENT_ADDED_INTERNAL",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: stored,
          metadata: { ...metadata, delivered: deliveryEntry !== null },
        },
      ];
      if (deliveryEntry !== null) entries.push(deliveryEntry);
      if (sanitized.redacted) {
        entries.push(piiEntry("COMMENT", comment.id, ticket.id, "body", sanitized.byKind, metadata));
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
          metadata,
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
          metadata,
        });
      }

      await writeAuditMany(tx, call.actor, call.ctx, entries);

      return {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        commentId: comment.id,
        created: true,
        reopened: false,
        piiRedacted: sanitized.redacted,
        piiRedactionCount: sanitized.count,
      };
    });

  try {
    return await run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const raced = await findIngestReceipt(data.source, externalKey);
    if (raced === null) throw e;
    return replayForTicket(raced, ticket.id);
  }
}

// ---------------------------------------------------------------------------
// The advisor platform mirror export (GET /api/export/tickets)
// ---------------------------------------------------------------------------

export const EXPORT_DEFAULT_LIMIT = 100;
export const EXPORT_MAX_LIMIT = 500;

export type TicketExportQuery = { updatedSince?: Date; cursor?: ExportCursor; limit: number };
export type ExportCursor = { updatedAt: Date; id: string };

/** `<updatedAt ISO>|<id>`, base64url. Opaque to the caller, and cheap to validate when it comes back. */
export function encodeExportCursor(cursor: ExportCursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/** Null for anything that is not a cursor this module minted. A bad cursor is a 400, never a silent restart. */
export function decodeExportCursor(raw: string): ExportCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;
  const updatedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(updatedAt.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { updatedAt, id };
}

const exportQuerySchema = z.object({
  updatedSince: z.string().trim().optional(),
  cursor: z.string().trim().optional(),
  limit: z.string().trim().optional(),
});

/** Parses the URL query. Throws ValidationError (400/422) rather than silently exporting the whole book. */
export function parseTicketExportQuery(params: URLSearchParams): TicketExportQuery {
  const raw = exportQuerySchema.parse({
    updatedSince: params.get("updatedSince") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });

  let updatedSince: Date | undefined;
  if (raw.updatedSince !== undefined) {
    const parsed = new Date(raw.updatedSince);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("updatedSince must be an ISO-8601 timestamp", { updatedSince: ["Invalid timestamp"] });
    }
    updatedSince = parsed;
  }

  let cursor: ExportCursor | undefined;
  if (raw.cursor !== undefined) {
    const parsed = decodeExportCursor(raw.cursor);
    if (parsed === null) throw new ValidationError("cursor is not valid", { cursor: ["Invalid cursor"] });
    cursor = parsed;
  }

  let limit = EXPORT_DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    const parsed = Number(raw.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > EXPORT_MAX_LIMIT) {
      throw new ValidationError(`limit must be an integer between 1 and ${EXPORT_MAX_LIMIT}`, {
        limit: [`Between 1 and ${EXPORT_MAX_LIMIT}`],
      });
    }
    limit = parsed;
  }

  return { updatedSince, cursor, limit };
}

const EXPORT_TICKET_SELECT = {
  id: true,
  number: true,
  subject: true,
  status: true,
  priority: true,
  category: true,
  brand: true,
  source: true,
  requesterName: true,
  requesterEmail: true,
  householdId: true,
  requesterExternalId: true,
  externalRef: true,
  isComplaint: true,
  createdAt: true,
  updatedAt: true,
  firstRespondedAt: true,
  resolvedAt: true,
  closedAt: true,
  queue: { select: { key: true } },
} as const;

/**
 * One page of the advisor platform mirror. PUBLIC channel only, sanitized bodies, stable `(updatedAt, id)` keyset
 * cursor over the matching index.
 *
 * Three structural guarantees, not three filters that happen to be applied:
 *  - Comments are read with `visibility: "PUBLIC"` in the WHERE clause and the returned visibility is
 *    re-asserted before it is mapped, so an INTERNAL note cannot reach the mirror even if the query
 *    were edited.
 *  - `SuspendedIntake` is not joined at all — held inbound mail has no Ticket and is structurally
 *    absent from this shape.
 *  - Bodies go through `sanitizePII` again on the way out. They were sanitized on the way in, and
 *    sanitizePII is idempotent, so this costs nothing and closes the case of a row written before a
 *    redaction rule existed.
 */
export async function exportTicketsPage(query: TicketExportQuery): Promise<TicketExportPage> {
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (query.updatedSince !== undefined) and.push({ updatedAt: { gte: query.updatedSince } });
  if (query.cursor !== undefined) {
    and.push({
      OR: [
        { updatedAt: { gt: query.cursor.updatedAt } },
        { updatedAt: query.cursor.updatedAt, id: { gt: query.cursor.id } },
      ],
    });
  }
  if (and.length > 0) where.AND = and;

  const tickets = await prisma.ticket.findMany({
    where,
    select: EXPORT_TICKET_SELECT,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: query.limit + 1,
  });

  const hasMore = tickets.length > query.limit;
  const page = hasMore ? tickets.slice(0, query.limit) : tickets;
  const ids = page.map((t) => t.id);

  const comments =
    ids.length === 0
      ? []
      : await prisma.comment.findMany({
          where: { ticketId: { in: ids }, visibility: "PUBLIC" },
          select: { id: true, ticketId: true, authorKind: true, visibility: true, body: true, createdAt: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });

  const byTicket = new Map<string, TicketExportMessage[]>();
  for (const c of comments) {
    // Defense in depth behind the WHERE clause: a body only leaves through the PUBLIC channel.
    if (c.visibility !== "PUBLIC") continue;
    const list = byTicket.get(c.ticketId) ?? [];
    list.push({
      id: c.id,
      authorKind: c.authorKind,
      body: sanitizePII(c.body).text,
      createdAt: c.createdAt.toISOString(),
    });
    byTicket.set(c.ticketId, list);
  }

  const rows: TicketExportRow[] = page.map((t) => ({
    id: t.id,
    reference: `HD-${t.number}`,
    subject: sanitizePII(t.subject).text,
    status: t.status,
    priority: t.priority,
    category: t.category,
    queueKey: t.queue.key,
    brand: t.brand,
    source: t.source,
    requesterName: sanitizePII(t.requesterName).text,
    requesterEmail: t.requesterEmail,
    householdId: t.householdId,
    requesterExternalId: t.requesterExternalId,
    externalRef: t.externalRef,
    isComplaint: t.isComplaint,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    firstRespondedAt: t.firstRespondedAt === null ? null : t.firstRespondedAt.toISOString(),
    resolvedAt: t.resolvedAt === null ? null : t.resolvedAt.toISOString(),
    closedAt: t.closedAt === null ? null : t.closedAt.toISOString(),
    messages: byTicket.get(t.id) ?? [],
  }));

  const last = page.length === 0 ? null : page[page.length - 1];
  return {
    rows,
    nextCursor: hasMore && last !== null ? encodeExportCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// Request body reading, shared by every POST route in this slice
// ---------------------------------------------------------------------------

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: "oversize" | "malformed" };

/**
 * Reads a JSON request body under a hard byte cap (§7.3: `INGEST_LIMITS.requestMaxBytes`, 1 MiB).
 *
 * The cap is enforced ON THE STREAM, by `readBodyWithCap` (src/lib/http-body.ts), not on the result:
 * `await req.text()` materialises the WHOLE body before any code can measure it, so a check on what
 * came back is not a cap at all — the allocation has already happened by the time it runs. Peak
 * memory here is bounded by `maxBytes + one chunk` regardless of what the sender framed or claimed.
 *
 * The declared `content-length` is still checked first, but only as the cheap early refusal it can
 * be: it is absent on a chunked request and attacker-controlled when present, so it can never be the
 * enforcement. Neither the body nor the parse error is echoed: a parse error message can quote the
 * payload, and I14 keeps ticket text out of responses and logs.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number = INGEST_LIMITS.requestMaxBytes,
): Promise<JsonBodyResult> {
  // A bad cap is a programming error, not a bad request; surface it rather than answering "malformed".
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative integer");
  }

  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: "oversize" };
  }

  let bytes: Uint8Array | null;
  try {
    // `req.body` is `null` for a request with no body at all; a duck-typed Request may omit it.
    bytes = await readBodyWithCap(req.body ?? null, maxBytes);
  } catch {
    // The stream errored or was aborted mid-flight — the caller never sent a usable body.
    return { ok: false, reason: "malformed" };
  }
  // `null` means the running total passed the cap and the stream was cancelled.
  if (bytes === null) return { ok: false, reason: "oversize" };

  let text: string;
  try {
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** The 400 a bad body answers with. Never carries the parse error. */
export function badBodyResponse(reason: "oversize" | "malformed"): MachineErrorResponse {
  return reason === "oversize"
    ? { status: 400, body: { error: "payload_too_large", message: "Request body exceeds the 1 MiB limit" } }
    : { status: 400, body: { error: "malformed_json", message: "Request body is not valid JSON" } };
}

// ---------------------------------------------------------------------------
// Error → HTTP mapping, shared by every route in this slice
// ---------------------------------------------------------------------------

export type MachineErrorResponse = {
  status: number;
  body: { error: string; message?: string; fieldErrors?: Record<string, string[]> };
};

/**
 * The status codes §8 pins: 400 malformed / oversize · 401 bearer · 403 not allowed · 404 unknown
 * ticket · 409 conflicting state · 422 zod failure with `fieldErrors`. An unknown error becomes a
 * bare 500 with no message — a Prisma error message can carry a body fragment, and I14 says no ticket
 * text in logs or responses.
 */
export function toMachineErrorResponse(name: string, e: unknown): MachineErrorResponse {
  if (e instanceof z.ZodError) {
    const flat = z.flattenError(e);
    const fieldErrors: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(flat.fieldErrors as Record<string, string[] | undefined>)) {
      if (messages && messages.length > 0) fieldErrors[field] = messages;
    }
    if (flat.formErrors.length > 0) fieldErrors._form = flat.formErrors;
    return { status: 422, body: { error: "validation", message: "Invalid input", fieldErrors } };
  }
  if (e instanceof ValidationError) {
    return {
      status: 422,
      body: { error: "validation", message: e.message, ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}) },
    };
  }
  if (e instanceof NotFoundError) return { status: 404, body: { error: "not_found" } };
  if (e instanceof ConflictError) return { status: 409, body: { error: "conflict", message: e.message } };
  if (e instanceof AppError && e.code === "UNAUTHORIZED") return { status: 401, body: { error: "unauthorized" } };
  if (e instanceof AppError && e.code === "FORBIDDEN") return { status: 403, body: { error: "forbidden" } };

  // The error is handed over, never read: `logError` records `errorLabel(e)` — the class name plus an
  // AppError code — and nothing else. Reading `e.name` here to build the same label is itself the
  // CWE-209 taint (security scanner), and the response body stays the bare `internal` above.
  logError(`ingest:${name}`, e);
  return { status: 500, body: { error: "internal" } };
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  return v.length === 0 ? null : v;
}
