/**
 * Inbound email intake — node only, layer L4 (§10 "S2").
 *
 * An n8n Gmail workflow POSTs one parsed message to `/api/ingest/email`; this module decides what
 * that message becomes and, in a single path, does it. Nothing here transmits anything.
 *
 * The order of the gates is the whole design, and it is deliberate:
 *
 *   1. **Mailbox.** An address that is not in `MAILBOX_MAP` has no queue and no brand, so it cannot
 *      become anything: `UNKNOWN_MAILBOX`.
 *
 *   The gates below are ordered and the reason enum holds ONE value, so the first hit wins and the
 *   later facts about the same message would be lost. The one that must not be lost is gate 2's, so
 *   every hold — whichever reason wins — also records the sender-authentication verdict in its
 *   `INTAKE_SUSPENDED` metadata (see {@link SENDER_VERIFIED_METADATA_KEY}). Nothing is mis-filed
 *   either way; what the verdict buys is that the reviewer looking at a held wire instruction is
 *   shown the right reason to be careful, and that releasing it still costs the unproven-sender
 *   acknowledgement.
 *
 *   2. **Sender authentication.** DMARC must say `pass`. A message that fails, or that arrives with
 *      no `Authentication-Results`, is NEVER attributed to a requester, NEVER reopens a ticket and
 *      NEVER becomes a comment: `UNAUTHENTICATED`. Email-originated wire and address-change requests
 *      are the classic BEC vector, and this is the control that answers for them. It sits ahead of
 *      threading — and, since fix round 2, ahead of the replay shortcut as well — on purpose: an
 *      unauthenticated message must not be allowed to look up a ticket, nor to be answered out of a
 *      receipt it did not earn.
 *   3. **Idempotency.** A replay of the same Message-ID returns what the first call produced — an
 *      `IngestReceipt` for a ticket or comment, a `SuspendedIntake` row for a held message. It sits
 *      BEHIND the two gates above, and behind a sender-identity re-check of the receipt's ticket,
 *      because a Message-ID is the SENDER's own text: it rides in the `References` of every reply and
 *      in every forwarded or Cc'd copy of a thread. Answered first, it swallowed a refused message
 *      whole — the earlier outcome returned, no `SuspendedIntake` row, no `INTAKE_SUSPENDED` row and
 *      nothing on `/admin/intake` — which made refusal the one intake outcome with no ledger row of
 *      any kind. Held mail is still exactly-once per Message-ID: that dedupe now lives in `hold()`,
 *      beside the write it guards, so every gate reaches it and not just the top of the function.
 *   4. **Classification.** Bounces, auto-replies, system senders, spam and mail loops are held.
 *   5. **Parse.** No readable body at all is `PARSE_FAILED`; a body past the hard ceiling is
 *      `OVERSIZE` (the ordinary long message is truncated with `BODY_TRUNCATION_NOTE`, not held).
 *   5b. **Forwarded mail**. A `Fwd:` / `FW:` shape carrying a DISTINCT embedded original
 *      sender is held as `FORWARDED` with that sender recorded as a CANDIDATE. It sits ahead of
 *      threading because the forwarded copy carries the original's `References`: matched first, it
 *      would join the right thread and then be refused as a SENDER_MISMATCH, losing both the fact
 *      that it is a forward and the candidate a reviewer needs. Nothing is ever attributed to the
 *      embedded sender automatically — see `resolveForwardedRelease`.
 *   6. **Threading**, in the contract's order: In-Reply-To / References against stored outbound
 *      Message-IDs, then the signed reply token, then `[HD-<n>]` in the subject.
 *   6b. **Sender identity, on EVERY matcher.** A matched thread is only joined when the From address
 *      equals that ticket's `requesterEmail`. DMARC (gate 3) proves the sender is who they say they
 *      are; it does NOT prove they are this client. A Message-ID and a reply token both travel with a
 *      forward or a Cc, so a third party who holds either could otherwise have their words filed as
 *      the client's own PUBLIC message, reopen the ticket, or — on a CLOSED one — open a new ticket
 *      carrying the victim's address, household and external id. A mismatch is held
 *      (`UNAUTHENTICATED`, audit detail `SENDER_MISMATCH`) for a human, never written.
 *   7. **Write**, through S1's viewer-agnostic cores so the audit rows, the PII sanitisation and the
 *      receipt are written exactly once, in the same transaction as the record they describe.
 *
 * Attachments are persisted AFTER the record exists and never block it: a client's words are the
 * record, and an object-store failure must not cost us the message.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, SuspendedIntakeReason, TicketCategory } from "@/types/domain";
import { ATTACHMENT_MIME_ALLOWLIST, INGEST_LIMITS } from "@/types/domain";
import { AUDIT_VIA, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import type { DbTx } from "@/lib/db";
import { parseDsn } from "@/lib/email/bounce";
import { classifyInbound } from "@/lib/email/classify";
import { analyzeForwarded } from "@/lib/email/forwarded";
import { htmlToText } from "@/lib/email/html-to-text";
import { normalizeMailboxAddress, parseFromAddress, parseMailboxMap, routeForMailbox } from "@/lib/email/mailboxes";
import type { MailboxRoute } from "@/lib/email/mailboxes";
import { parseAuthenticationResults } from "@/lib/email/auth-results";
import type { SenderAuthVerdict } from "@/lib/email/auth-results";
import { stripQuotedHistory } from "@/lib/email/quoted-reply";
import { extractReplyToken, verifyReplyTokenWithRotation } from "@/lib/email/reply-token";
import { parseMessageIdList, ticketNumberFromSubject } from "@/lib/email/threading";
import type { ThreadMatch } from "@/lib/email/threading";
import { env, previousReplySecrets, trustedAuthservIds } from "@/lib/env";
import { logError, logWarn } from "@/lib/logger";
import { sanitizePII } from "@/lib/pii";
import { safeEqualEmails } from "@/lib/safe-equal";
import { attachmentObjectKey, isValidObjectKey, objectStore, sanitizeFilename } from "@/lib/storage";
import type { ObjectStore } from "@/lib/storage";
import {
  addRequesterMessageOrFollowUp,
  createTicketCore,
  findIngestReceipt,
} from "@/server/ingest";
import type { IngestCallContext } from "@/server/ingest";
import { recordBounce } from "@/server/outbox";
import type { BounceRecord } from "@/server/outbox";

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Every ticket and comment this module writes carries this source. */
export const EMAIL_SOURCE = "EMAIL" as const;

/**
 * A body past this is held as `OVERSIZE` rather than truncated. It is S1's own `BODY_HARD_MAX`, so
 * the boundary between "truncate with a note" and "hold for a human" is the same number that would
 * otherwise turn into a 422 deep inside `createTicketCore` — a client's message never fails
 * validation, it becomes a reviewable row.
 */
export const INBOUND_BODY_HARD_LIMIT_CHARS = 400_000;

/** Subject fallback when a message carries none. Stored, because `Ticket.subject` cannot be empty. */
export const NO_SUBJECT_PLACEHOLDER = "(no subject)" as const;

/** `Ticket.requesterName` is capped at 120 in S1's schema; the display name is cut to fit. */
const REQUESTER_NAME_MAX = 120;
const SUBJECT_HARD_MAX = 2_000;

/** Headers kept on a SuspendedIntake row: enough for a human verdict, bounded against a hostile block. */
const SUSPENDED_HEADER_KEYS: readonly string[] = [
  "authentication-results",
  "auto-submitted",
  "content-type",
  "date",
  "delivered-to",
  "from",
  "in-reply-to",
  "list-id",
  "list-unsubscribe",
  "message-id",
  "precedence",
  "received-spf",
  "references",
  "reply-to",
  "return-path",
  "subject",
  "to",
  "x-autoreply",
  "x-failed-recipients",
  "x-forefront-antispam-report",
  "x-gm-spam",
  "x-loop",
  "x-spam-flag",
  "x-spam-level",
  "x-spam-status",
];
const SUSPENDED_HEADER_VALUE_MAX = 1_000;

/**
 * The audit detail that distinguishes a held message whose sender is not the thread's requester from
 * one that failed DMARC. Both are `UNAUTHENTICATED` — the reason enum is fixed by the schema and this
 * wave runs no migration — so the ledger carries the distinction in `metadata.detail`.
 */
export const SENDER_MISMATCH_DETAIL = "SENDER_MISMATCH" as const;

/**
 * The audit metadata key that records whether sender authentication passed on a held message —
 * independently of which hold reason won.
 *
 * `SuspendedIntakeReason` is single-valued and frozen for this wave, and the gates in
 * `ingestInboundEmail` are ordered: an unauthenticated message that also arrived on an unmapped
 * address is held as `UNKNOWN_MAILBOX`, because that gate runs first. The second fact — nothing
 * proved this came from the address it claims — was then lost entirely: the review card showed the
 * benign "not in the mailbox map" banner with no sender caution, and releasing the row adopted the
 * unproven address as `Ticket.requesterEmail` without the acknowledgement, the note or the "SENDER
 * NOT VERIFIED" line on the ticket that a row held as `UNAUTHENTICATED` costs.
 *
 * So the verdict travels beside the reason on EVERY hold, as a boolean in the `INTAKE_SUSPENDED`
 * row's metadata. `metadata.detail` is deliberately left alone: it already carries
 * {@link SENDER_MISMATCH_DETAIL}, and the two facts are orthogonal — a SENDER_MISMATCH hold PASSED
 * authentication (DMARC proved the third party is who they say they are; it did not prove they are
 * this client). `heldIntakeSenderVerified` in `@/server/suspended-intake` is the one place the two
 * are combined, fail-closed, for both the review surface and the release gate.
 */
export const SENDER_VERIFIED_METADATA_KEY = "senderVerified" as const;

/**
 * The audit metadata key that carries the parsed original sender of a FORWARDED hold.
 *
 * A CANDIDATE, never an attribution (CONTRACT §1.2: "staff confirm it on release; nothing is ever
 * attributed to it automatically"). It is on the row as `SuspendedIntake.candidateRequesterEmail` for
 * the review card and in the ledger here so the value a reviewer was SHOWN is recorded, not only the
 * value they eventually chose.
 */
export const FORWARD_CANDIDATE_METADATA_KEY = "candidateRequesterEmail" as const;

/**
 * The key a FORWARDED hold keeps the ORIGINAL sender's DISPLAY NAME under, inside the row's stored
 * header block (`SuspendedIntake.headers`).
 *
 * `candidateRequesterEmail` is an address: case-insensitive, so it is stored lower-cased and compared
 * lower-cased. A person's name is neither. Releasing against the candidate had nothing but that
 * lower-cased address to build `Ticket.requesterName` from, so "Marla Whitfield" reached a
 * client-facing ticket as "marla whitfield" — mis-cased from the moment the record was created, on
 * the one path where the correctly-cased name WAS sitting in the forwarded block all along.
 *
 * It lives in the header block rather than in a column of its own because the columns are the
 * foundation's to add and this wave's schema is fixed; the block is where the rest of the parsed
 * original already lives, and the release path reads it back through
 * {@link forwardedCandidateName}. The key is namespaced `x-wm-` and is never copied from an inbound
 * message — `SUSPENDED_HEADER_KEYS` does not list it and `suspendIntake` strips it from whatever the
 * caller passed — so a sender cannot put a name of their choosing on a ticket by inventing a header.
 */
export const FORWARD_CANDIDATE_NAME_HEADER_KEY = "x-wm-original-from-name" as const;

/**
 * The audit detail on a hold that is a bounce for one of OUR deliveries, as opposed to a bounce of
 * somebody else's mail that happened to reach an intake mailbox. Both are held as `BOUNCE`; only one
 * of them moved a `MessageDelivery` row.
 */
export const OWN_BOUNCE_DETAIL = "OWN_DELIVERY_BOUNCED" as const;

/**
 * The ONE namespace an inbound `objectRef` may point into.
 *
 * `objectRef` is caller-supplied, and `ObjectStore.get` validates only the SHAPE of a key
 * (`<segment>/<segment>`) — which is exactly the shape of every stored attachment,
 * `<ticketId>/<attachmentId>`. Without this prefix, a holder of the integration token could name
 * another ticket's attachment and have its bytes — a voided check, a statement, an ID document —
 * copied onto a ticket in a queue of their choosing, with no `ATTACHMENT_VIEWED` row anywhere.
 *
 * `inbound` can never collide with a real attachment key: the first segment of one is a ticket id.
 * `materializeAttachmentBytes` re-checks the prefix AND refuses any key an `Attachment` row already
 * holds, so the guarantee does not rest on that argument alone.
 */
export const INBOUND_STAGING_PREFIX = "inbound" as const;

/** True for a key the workflow may hand us as `objectRef`: `inbound/<id>`, and nothing else. */
export function isInboundStagingKey(key: string): boolean {
  return isValidObjectKey(key) && key.startsWith(`${INBOUND_STAGING_PREFIX}/`);
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** A header value; some forwarders send repeated headers as an array. */
const headerValueSchema = z.union([z.string(), z.array(z.string())]).transform((v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : v,
);

/**
 * One MIME part the workflow forwards. Either the bytes are inline (`contentBase64`, bounded by the
 * 1 MiB request cap) or the workflow has already staged the object under `inbound/<id>` in the
 * attachments bucket and passes that key (`objectRef`).
 *
 * `objectRef` is validated HERE, at the edge, for two reasons. It is an authorization boundary — see
 * `INBOUND_STAGING_PREFIX` — and it is the difference between a workflow getting a 422 that names the
 * field and a silent `skipped` count: an unusable reference (a Gmail attachment id, an n8n execution
 * path, a key with a date prefix or a file extension) fails `ObjectStore.get`'s own key check deep
 * inside the copy, where the only trace left would have been a PENDING row nobody reads.
 */
const attachmentPartSchema = z
  .object({
    filename: z.string().trim().min(1).max(400),
    mime: z.string().trim().min(1).max(200),
    size: z.number().int().min(0).max(INGEST_LIMITS.attachmentMaxBytes).optional(),
    contentBase64: z.string().max(INGEST_LIMITS.requestMaxBytes).optional(),
    objectRef: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(isInboundStagingKey, {
        message: `objectRef must be a staging key of the form ${INBOUND_STAGING_PREFIX}/<id>`,
      })
      .optional(),
  })
  .refine((v) => v.contentBase64 !== undefined || v.objectRef !== undefined, {
    message: "An attachment part needs contentBase64 or objectRef",
    path: ["contentBase64"],
  });

/**
 * The n8n payload. Everything the workflow can reasonably know, nothing it cannot: no ticket id, no
 * queue, no category — those are this module's to decide, so a compromised workflow credential
 * cannot file into a queue of its choosing.
 */
export const inboundEmailSchema = z.object({
  /** The address the message was delivered to, including any `+tag`. The mailbox-map key. */
  mailbox: z.string().trim().min(3).max(320),
  /** RFC 5322 Message-ID. Optional: a malformed message still deserves to reach a human. */
  messageId: z.string().trim().min(1).max(400).optional(),
  /** The From header, display name included. */
  from: z.string().trim().min(3).max(400),
  subject: z.string().max(SUBJECT_HARD_MAX * 4).optional(),
  textBody: z.string().max(INGEST_LIMITS.requestMaxBytes).optional(),
  htmlBody: z.string().max(INGEST_LIMITS.requestMaxBytes).optional(),
  /** The forwarded header block, any casing. */
  headers: z.record(z.string(), headerValueSchema).optional(),
  /** ISO timestamp the MTA stamped. Advisory only — the desk stamps its own `createdAt`. */
  receivedAt: z.string().trim().max(64).optional(),
  /** Opaque pointer to the raw message in the workflow's own store (n8n execution id, Gmail id). */
  rawRef: z.string().trim().max(512).optional(),
  /** The workflow's own spam verdict, when it has one. Additive: header flags are still read. */
  spamFlagged: z.boolean().optional(),
  attachments: z.array(attachmentPartSchema).max(INGEST_LIMITS.attachmentsPerMessage * 4).optional(),
});

export type InboundEmail = z.output<typeof inboundEmailSchema>;

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type IntakeOutcome =
  | { outcome: "ticket"; ticketId: string; ticketNumber: number }
  | { outcome: "comment"; ticketId: string; commentId: string; reopened: boolean }
  | { outcome: "suspended"; suspendedId: string; reason: SuspendedIntakeReason };

/** What `persistAttachmentParts` managed to do, for the caller's log line and the route's response. */
export type AttachmentIntakeSummary = { stored: number; skipped: number };

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string") continue;
    out[key.trim().toLowerCase()] = value;
  }
  return out;
}

/** The display name in `"Okonkwo, Dean" <dean@x.test>`, or the local part when there is none. */
function requesterNameFrom(fromHeader: string, address: string): string {
  const withoutAngle = fromHeader.replace(/<[^<>]*>/g, "").trim();
  const unquoted = withoutAngle.replace(/^["']|["']$/g, "").trim();
  const candidate = unquoted.length > 0 ? unquoted : address.slice(0, address.lastIndexOf("@"));
  const cleaned = candidate.replace(/\s+/g, " ").trim();
  const name = cleaned.length > 0 ? cleaned : address;
  return name.slice(0, REQUESTER_NAME_MAX);
}

/**
 * The DISPLAY NAME in a `From:` line, with its casing untouched — or null when the line carried only
 * an address.
 *
 * Distinct from {@link requesterNameFrom}, which always returns SOMETHING because `Ticket.requesterName`
 * cannot be empty. Here the absence has to be reportable: the caller is the forwarded-block path, and a
 * block whose `From:` is a bare addr-spec has no name to preserve — falling back to the local part
 * there would replace a decent derived name with a worse one.
 */
function displayNameFrom(fromHeader: string): string | null {
  const withoutAngle = fromHeader.replace(/<[^<>]*>/g, "").trim();
  const unquoted = withoutAngle.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
  if (unquoted.length === 0) return null;
  // `From: marla.whitfield@fastmail.test` — an addr-spec with no angle brackets is not a display name.
  if (unquoted.includes("@") && !/\s/.test(unquoted)) return null;
  return unquoted.slice(0, REQUESTER_NAME_MAX);
}

/**
 * The original sender's display name kept on a FORWARDED hold, or null when none was parsed.
 *
 * Reads {@link FORWARD_CANDIDATE_NAME_HEADER_KEY} out of `SuspendedIntake.headers` (a `Json` column,
 * hence `unknown`: a row written before this existed, or one whose block held nothing, is a null — not
 * an error). The value was sanitised and bounded on the way in; it is bounded again on the way out,
 * because the column is Json and nothing in the database enforces what a future writer puts there.
 */
export function forwardedCandidateName(headers: unknown): string | null {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return null;
  const value = (headers as Record<string, unknown>)[FORWARD_CANDIDATE_NAME_HEADER_KEY];
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name.length === 0 ? null : name.slice(0, REQUESTER_NAME_MAX);
}

function normalizeSubject(raw: string | undefined, headers: Record<string, string>): string {
  const candidate = (raw ?? headers["subject"] ?? "").replace(/\s+/g, " ").trim();
  if (candidate.length === 0) return NO_SUBJECT_PLACEHOLDER;
  return candidate.slice(0, SUBJECT_HARD_MAX);
}

/**
 * The external id every receipt and every dedupe key uses. A message with no Message-ID gets a
 * deterministic synthetic id derived from what the message actually is, so a retry of the SAME
 * message is still recognised as a replay while two different messages never collide.
 */
export function externalIdFor(input: InboundEmail, headers: Record<string, string>): string {
  const headerId = input.messageId ?? headers["message-id"];
  if (typeof headerId === "string" && headerId.trim().length > 0) {
    return headerId.trim().replace(/^<|>$/g, "").toLowerCase().slice(0, 400);
  }
  const material = [
    input.mailbox,
    input.from,
    input.subject ?? headers["subject"] ?? "",
    input.receivedAt ?? headers["date"] ?? "",
    (input.textBody ?? input.htmlBody ?? "").slice(0, 4_000),
  ].join("");
  return `synthetic.${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

/** The text body the desk stores, before quoted-history stripping and before truncation. */
export function extractBody(input: InboundEmail): string {
  const text = typeof input.textBody === "string" ? input.textBody : "";
  if (text.trim().length > 0) return text.replace(/\r\n?/g, "\n");
  const html = typeof input.htmlBody === "string" ? input.htmlBody : "";
  return html.trim().length > 0 ? htmlToText(html) : "";
}

// ---------------------------------------------------------------------------
// suspendIntake
// ---------------------------------------------------------------------------

/** Sanitised, bounded copy of the forwarded header block, safe to persist as Json. */
function suspendedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SUSPENDED_HEADER_KEYS) {
    const value = headers[key];
    if (typeof value !== "string" || value.length === 0) continue;
    out[key] = sanitizePII(value).text.slice(0, SUSPENDED_HEADER_VALUE_MAX);
  }
  return out;
}

/** `SuspendedIntake.messageId` mirrors `externalIdFor`'s own cut, so a stored id is never a prefix. */
const SUSPENDED_MESSAGE_ID_MAX = 400;
/** `SuspendedIntake.rawRef` mirrors `inboundEmailSchema.rawRef`'s cap. */
const SUSPENDED_RAW_REF_MAX = 512;

/**
 * Sanitises and bounds one of the two caller-supplied pointers a held message carries.
 *
 * `messageId` and `rawRef` are the columns it is easiest to believe are structural and therefore
 * exempt: one is an RFC 5322 header, the other is documented as "an opaque pointer to the raw message
 * in the workflow's own store". Neither is a value the desk generates. The header is whatever the
 * sender's MUA wrote, and nothing constrains `rawRef` to an execution id — a workflow that puts a
 * subject fragment, a mail-search string or a document identifier in there writes it straight into a
 * table that can never be deleted, and both columns are surfaced to reviewers on `/admin/intake`
 * (`HeldIntakeRow.rawRef` / `.messageId`). So they go through `sanitizePII` like every other free-text
 * field, at the one place that persists them.
 *
 * `sanitizePII` is idempotent and leaves ordinary Message-ID text byte-identical, so threading and the
 * `existingSuspension` dedupe are unaffected — and the dedupe read goes through this same helper, so
 * even a Message-ID that DID contain a redaction target still matches the value that was stored.
 */
function sanitizeIntakePointer(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizePII(value).text.slice(0, max).trim();
  return text.length === 0 ? null : text;
}

/** The stored form of a held message's Message-ID: sanitised, bounded, `null` when there is none. */
export function sanitizedMessageId(value: string | null | undefined): string | null {
  return sanitizeIntakePointer(value, SUSPENDED_MESSAGE_ID_MAX);
}

/** The stored form of a held message's `rawRef`. */
export function sanitizedRawRef(value: string | null | undefined): string | null {
  return sanitizeIntakePointer(value, SUSPENDED_RAW_REF_MAX);
}

/** Prisma's unique-constraint code. Same helper, same reasoning, as `createTicketCore`'s. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

/**
 * Writes the `SuspendedIntake` row and its `INTAKE_SUSPENDED` audit row in ONE transaction, audit
 * last (§3 rule 2). Everything free-text is PII-sanitised first: a held message is still client
 * material, and the reviewer sees a redacted preview rather than an account number in a review queue.
 * *Everything* means all six columns — `mailbox`, `fromAddress`, `subject`, `snippet`, and (fix round
 * 2) `messageId` and `rawRef`, which are caller-supplied too; see `sanitizeIntakePointer`. The audit
 * metadata names the sanitised `messageId`, never the raw one, for the same reason.
 *
 * The row is never a ticket and never a comment. Nothing downstream reads it as one.
 *
 * **Exactly once per Message-ID.** `ingestInboundEmail`'s `existingSuspension` read is the fast path,
 * but a read-then-insert is not a guarantee: n8n retries a slow webhook, two deliveries of the same
 * message overlap, both reads miss and both inserts land — N permanent rows in a table that cannot be
 * deleted and N `INTAKE_SUSPENDED` rows in the hash chain for one message. The insert is therefore
 * wrapped in the SAME P2002-recover-and-return-the-winner pattern `createTicketCore` uses, resolving
 * the loser into the winner's id. That recovery needs `@@unique` on `SuspendedIntake.messageId`,
 * which this wave cannot add (no migrations) — the exact change is written up in
 * the build record Until it lands the recovery is inert and the
 * fast-path read is all there is; after it lands nothing else has to change.
 *
 * `detail` is an optional, non-client-material label — `SENDER_MISMATCH` today — recorded in the
 * audit metadata. Additive to the contract's §10 signature; see the notes.
 *
 * `senderVerified` is the sender-authentication verdict, recorded beside the reason on every hold so
 * that a reason which is not `UNAUTHENTICATED` cannot hide it — see
 * {@link SENDER_VERIFIED_METADATA_KEY}. Omitted (`undefined`) means "not recorded", which readers
 * treat as unknown and fall back to the reason for; it is never silently read as verified.
 */
export async function suspendIntake(
  input: {
    reason: SuspendedIntakeReason;
    mailbox: string;
    fromAddress: string;
    subject: string;
    messageId?: string | null;
    rawRef?: string | null;
    headers?: unknown;
    snippet?: string | null;
    detail?: string | null;
    senderVerified?: boolean | null;
    /**
     * The original sender parsed out of a forwarded block. A CANDIDATE a human confirms on release —
     * never an attribution, and never used as `Ticket.requesterEmail` without
     * {@link resolveForwardedRelease} saying so. See {@link FORWARD_CANDIDATE_METADATA_KEY}.
     */
    candidateRequesterEmail?: string | null;
    /**
     * The display name that stood beside {@link suspendIntake}'s `candidateRequesterEmail` in the
     * forwarded block, casing untouched. Kept in the header block under
     * {@link FORWARD_CANDIDATE_NAME_HEADER_KEY} so a release against the candidate can name the client
     * the way the client's own mail client did, instead of deriving a lower-cased name from the
     * address. Ignored without a candidate address — it is that address's name, not a second one.
     */
    candidateRequesterName?: string | null;
  },
  call: IngestCallContext,
): Promise<{ suspendedId: string }> {
  const mailbox = sanitizePII(input.mailbox).text.slice(0, 320);
  const fromAddress = sanitizePII(input.fromAddress.toLowerCase()).text.slice(0, 320);
  const subject = sanitizePII(input.subject).text.slice(0, SUBJECT_HARD_MAX);
  const snippet =
    typeof input.snippet === "string" && input.snippet.length > 0
      ? sanitizePII(input.snippet).text.slice(0, INGEST_LIMITS.snippetMaxChars)
      : null;
  const messageId = sanitizedMessageId(input.messageId);
  const rawRef = sanitizedRawRef(input.rawRef);
  // The candidate is an addr-spec the forwarded block claimed; it goes through the same sanitiser and
  // the same lower-casing as `fromAddress`, because it is rendered on the review card and may end up
  // as `Ticket.requesterEmail`.
  const candidateRequesterEmail =
    typeof input.candidateRequesterEmail === "string" && input.candidateRequesterEmail.length > 0
      ? sanitizePII(input.candidateRequesterEmail.trim().toLowerCase()).text.slice(0, 320)
      : null;
  // The candidate's display name rides in the header block (see FORWARD_CANDIDATE_NAME_HEADER_KEY).
  // Sanitised and bounded like every other stored string, and kept only when there is a candidate
  // address for it to belong to.
  const candidateRequesterName =
    candidateRequesterEmail !== null &&
    typeof input.candidateRequesterName === "string" &&
    input.candidateRequesterName.trim().length > 0
      ? sanitizePII(input.candidateRequesterName.replace(/\s+/g, " ").trim()).text.slice(0, REQUESTER_NAME_MAX)
      : null;
  const headers = (() => {
    const supplied =
      input.headers !== undefined && input.headers !== null && typeof input.headers === "object"
        ? { ...(input.headers as Record<string, string>) }
        : undefined;
    // The key is OURS. Whatever a caller passed under it — including a header a sender invented — is
    // dropped before ours is written, so the name on a released ticket can only be the parsed one.
    if (supplied !== undefined) delete supplied[FORWARD_CANDIDATE_NAME_HEADER_KEY];
    if (candidateRequesterName === null) return supplied;
    return { ...(supplied ?? {}), [FORWARD_CANDIDATE_NAME_HEADER_KEY]: candidateRequesterName };
  })();

  const insert = async (): Promise<{ suspendedId: string }> =>
    withTx(async (tx: DbTx) => {
      const row = await tx.suspendedIntake.create({
        data: {
          reason: input.reason,
          mailbox,
          fromAddress,
          subject,
          messageId,
          rawRef,
          headers,
          snippet,
          // On the ROW, not only in the ledger. The column exists precisely so the review card and the
          // release gate can read the verdict without reconstructing it from audit metadata
          // (prisma/schema.prisma: "so a reviewer's banner cannot over-claim"). `undefined` — the
          // caller recorded nothing — leaves the schema default of `false`, which is fail-closed.
          senderVerified: input.senderVerified === true,
          candidateRequesterEmail,
        },
        select: { id: true },
      });

      const entries: AuditEntry[] = [
        {
          action: "INTAKE_SUSPENDED",
          entityType: "SUSPENDED_INTAKE",
          entityId: row.id,
          fieldChanged: "reason",
          oldValue: null,
          newValue: input.reason,
          metadata: {
            via: call.via,
            source: EMAIL_SOURCE,
            mailbox,
            messageId,
            detail: input.detail ?? null,
            // The second fact about this message, which the single-valued reason cannot carry.
            [SENDER_VERIFIED_METADATA_KEY]:
              typeof input.senderVerified === "boolean" ? input.senderVerified : null,
            // The third: whose mail this actually is, when the message is a forward. Recorded so the
            // ledger holds the value the reviewer was SHOWN, not only the one they chose.
            [FORWARD_CANDIDATE_METADATA_KEY]: candidateRequesterEmail,
          },
        },
      ];
      await writeAuditMany(tx, call.actor, call.ctx, entries);

      return { suspendedId: row.id };
    });

  try {
    return await insert();
  } catch (e) {
    if (!isUniqueViolation(e) || messageId === null) throw e;
    const winner = await prisma.suspendedIntake.findFirst({
      where: { messageId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (winner === null) throw e;
    return { suspendedId: winner.id };
  }
}

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

/**
 * Both spellings of every echoed Message-ID. `MessageDelivery.messageId` is S3's to format and the
 * contract's `<wm.…@domain>` notation does not say whether the angle brackets are stored, so the
 * lookup asks for the bare AND the bracketed form. One extra array entry; no silent threading loss.
 */
function messageIdCandidates(headers: Record<string, string>): string[] {
  const ids = [
    ...parseMessageIdList(headers["in-reply-to"]),
    ...parseMessageIdList(headers["references"]),
  ];
  const unique = [...new Set(ids)];
  return [...unique, ...unique.map((id) => `<${id}>`)];
}

/** Every place a reply token can ride: the envelope recipient first, then the reply-ish headers. */
function replyTokenCandidates(input: InboundEmail, headers: Record<string, string>): string[] {
  return [input.mailbox, headers["delivered-to"], headers["x-original-to"], headers["to"], headers["reply-to"], headers["cc"]]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Resolves the thread this message belongs to, in the contract's order: stored outbound
 * Message-ID, then the signed reply token, then `[HD-<n>]` in the subject.
 *
 * The subject fallback is gated on identity HERE because a subject line is client-editable text: on
 * its own it is a request to be put into someone else's conversation, and it must not even resolve.
 * The other two matchers are gated by `threadSenderIdentity` in `ingestInboundEmail` instead, where
 * a mismatch becomes a held message a human releases rather than a silent "no match" that would open
 * a second ticket under the third party's name. Every matcher ends up identity-checked; they differ
 * only in what a failure produces. DMARC has already passed by the time any of this runs.
 */
export async function resolveThread(
  input: InboundEmail,
  headers: Record<string, string>,
  fromAddress: string,
): Promise<ThreadMatch> {
  const candidates = messageIdCandidates(headers);
  if (candidates.length > 0) {
    const delivery = await prisma.messageDelivery.findFirst({
      where: { messageId: { in: candidates } },
      select: { ticketId: true },
      orderBy: { createdAt: "desc" },
    });
    if (delivery !== null) return { kind: "message-id", ticketId: delivery.ticketId };
  }

  // A rotation may still be accepting the retired secret (REPLY_TOKEN_PREVIOUS_SECRETS): tokens
  // already in clients' mailboxes outlive the key that signed them, and without the overlap every
  // one of those replies becomes a held message someone has to release by hand.
  const retiredSecrets = previousReplySecrets(env.REPLY_TOKEN_PREVIOUS_SECRETS);
  for (const value of replyTokenCandidates(input, headers)) {
    const token = extractReplyToken(value);
    if (!token) continue;
    const verified = verifyReplyTokenWithRotation(token, env.REPLY_TOKEN_SECRET, retiredSecrets);
    if (verified === null) continue;
    const ticket = await prisma.ticket.findUnique({ where: { id: verified.ticketId }, select: { id: true } });
    if (ticket === null) continue;
    if (verified.generation === "previous") {
      // Operational telemetry, not a compliance record: it carries a ticket id and a key position and
      // no client material. When this line stops appearing, the retired secret can be dropped.
      logWarn("email-intake", "reply-token-verified-by-retired-secret", {
        ticketId: ticket.id,
        secretIndex: verified.secretIndex,
      });
    }
    return { kind: "reply-token", ticketId: ticket.id, generation: verified.generation };
  }

  const number = ticketNumberFromSubject(normalizeSubject(input.subject, headers));
  if (number !== null) {
    const ticket = await prisma.ticket.findUnique({
      where: { number },
      select: { id: true, requesterEmail: true },
    });
    if (ticket !== null && safeEqualEmails(ticket.requesterEmail ?? "", fromAddress)) {
      return { kind: "subject", ticketId: ticket.id };
    }
  }

  return { kind: "none" };
}

/**
 * Whether the message's sender is the matched ticket's requester.
 *
 * `"missing"` means the ticket row has gone (a stored `MessageDelivery` outliving its ticket); the
 * caller treats that as no match at all rather than as a failure, so the message still becomes a
 * ticket. A ticket with NO `requesterEmail` — a phone-origin record — can never be joined by mail:
 * there is nothing to compare against, and "" never equals a real address.
 */
export async function threadSenderIdentity(
  ticketId: string,
  fromAddress: string,
): Promise<"match" | "mismatch" | "missing"> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { requesterEmail: true },
  });
  if (ticket === null) return "missing";
  return safeEqualEmails(ticket.requesterEmail ?? "", fromAddress) ? "match" : "mismatch";
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * The bytes for one part, or `null` when this part cannot become an attachment.
 *
 * Bytes are resolved BEFORE any row exists. The previous order — rows first, bytes second — left a
 * permanent PENDING `Attachment` row behind for every part whose bytes never arrived, in a table
 * that cannot be deleted, invisible to `listAttachments` (which filters `state: "READY"`) and
 * unaudited. Resolving first means a part that cannot be fetched is simply a `skipped` count.
 *
 * Two independent gates stand between a caller-supplied `objectRef` and a copy:
 *   1. the key must sit under `INBOUND_STAGING_PREFIX` (also enforced at the schema edge), and
 *   2. no `Attachment` row may already hold that key — so even if the prefix argument were ever
 *      wrong, another ticket's stored material still cannot be pulled across.
 * Neither gate exists in `ObjectStore.get`, which validates the key's SHAPE only — and that shape is
 * exactly `<ticketId>/<attachmentId>`.
 */
async function materializeAttachmentBytes(
  part: z.output<typeof attachmentPartSchema>,
  store: ObjectStore,
): Promise<{ bytes: Buffer; sourceObjectRef: string | null } | null> {
  const within = (bytes: Buffer): boolean => bytes.length > 0 && bytes.length <= INGEST_LIMITS.attachmentMaxBytes;
  try {
    if (part.contentBase64 !== undefined) {
      const bytes = Buffer.from(part.contentBase64, "base64");
      return within(bytes) ? { bytes, sourceObjectRef: null } : null;
    }
    const ref = part.objectRef;
    if (typeof ref !== "string" || !isInboundStagingKey(ref)) return null;
    const collision = await prisma.attachment.findFirst({ where: { objectKey: ref }, select: { id: true } });
    if (collision !== null) return null;
    const bytes = Buffer.from(await store.get(ref));
    return within(bytes) ? { bytes, sourceObjectRef: ref } : null;
  } catch {
    return null;
  }
}

/**
 * Persists the message's attachment parts against a ticket (and, when the message became a reply,
 * against that comment). Bytes are resolved first, then the rows go in PENDING, then the objects are
 * written, then one transaction flips the successful ones to READY with their `ATTACHMENT_ADDED`
 * rows — the same transition and the same audit shape S4's `finalizeUpload` writes, so an email part
 * and an uploaded file are one kind of record rather than two.
 *
 * CONTRACT-GAP (recorded in the build record): the contract names no
 * machine-callable attachment core — S4's exports are server ACTIONS that require a session Viewer —
 * so this module writes the rows itself against §7.2's `ObjectStore` interface. `objectRef` is read
 * as "a key the workflow staged under `inbound/`", and the part is copied to the canonical
 * `<ticketId>/<attachmentId>` key. The source key is recorded in the `ATTACHMENT_ADDED` metadata:
 * a copied object's provenance has to be in the ledger, because the row itself carries
 * `uploaderId: null` and the integration actor.
 *
 * Never throws: a client's words are the record, and losing an attachment must not lose the message.
 */
export async function persistAttachmentParts(
  parts: readonly z.output<typeof attachmentPartSchema>[],
  target: { ticketId: string; commentId: string | null },
  call: IngestCallContext,
  store: ObjectStore = objectStore(env.ATTACHMENTS_BUCKET),
): Promise<AttachmentIntakeSummary> {
  const accepted = parts
    .filter((p) => (ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(p.mime))
    .slice(0, INGEST_LIMITS.attachmentsPerMessage);
  const skippedUpFront = parts.length - accepted.length;
  if (accepted.length === 0) return { stored: 0, skipped: skippedUpFront };

  type Planned = {
    id: string;
    filename: string;
    mime: string;
    objectKey: string;
    bytes: Buffer;
    sourceObjectRef: string | null;
  };

  const planned: Planned[] = [];
  for (const part of accepted) {
    const material = await materializeAttachmentBytes(part, store);
    if (material === null) continue;
    try {
      const id = randomUUID().replaceAll("-", "");
      planned.push({
        id,
        filename: sanitizeFilename(sanitizePII(part.filename).text),
        mime: part.mime,
        objectKey: attachmentObjectKey(target.ticketId, id),
        bytes: material.bytes,
        sourceObjectRef: material.sourceObjectRef,
      });
    } catch {
      // `attachmentObjectKey` refuses an id that cannot be a key segment. Skip the part, keep the message.
    }
  }
  if (planned.length === 0) return { stored: 0, skipped: parts.length };

  // The reservation rows are AUDITED in the same transaction that creates them, exactly as
  // `createUploadIntent` audits its own (src/server/attachments.actions.ts: `null → PENDING`, metadata
  // `{stage: "intent"}`). An `Attachment` row is permanent — the no-hard-delete trigger refuses DELETE
  // — so a row that appears in a books-and-records table with nothing in the ledger explaining it is
  // the defect, whether or not the object write that follows ever lands.
  try {
    await withTx(async (tx: DbTx) => {
      await tx.attachment.createMany({
        data: planned.map((p) => ({
          id: p.id,
          ticketId: target.ticketId,
          commentId: target.commentId,
          uploaderId: null,
          kind: "EMAIL_PART" as const,
          filename: p.filename,
          mime: p.mime,
          size: p.bytes.length,
          objectKey: p.objectKey,
          state: "PENDING" as const,
        })),
      });
      await writeAuditMany(
        tx,
        call.actor,
        call.ctx,
        planned.map((p) => ({
          action: "ATTACHMENT_ADDED" as const,
          entityType: "ATTACHMENT" as const,
          entityId: p.id,
          ticketId: target.ticketId,
          fieldChanged: "state",
          oldValue: null,
          newValue: "PENDING",
          metadata: {
            stage: "intent",
            via: call.via,
            source: EMAIL_SOURCE,
            filename: p.filename,
            mime: p.mime,
            size: p.bytes.length,
            backend: store.backend,
            sourceObjectRef: p.sourceObjectRef,
          },
        })),
      );
    });
  } catch {
    return { stored: 0, skipped: parts.length };
  }

  const ready: Array<{
    id: string;
    size: number;
    sha256: string;
    filename: string;
    mime: string;
    sourceObjectRef: string | null;
  }> = [];
  for (const p of planned) {
    try {
      const written = await store.put(p.objectKey, p.bytes, p.mime);
      ready.push({
        id: p.id,
        size: written.size,
        sha256: written.sha256,
        filename: p.filename,
        mime: p.mime,
        sourceObjectRef: p.sourceObjectRef,
      });
    } catch {
      // The object write failed after the row existed. The row stays PENDING — invisible to every
      // read surface, and the one case §9 of the notes asks for a sweep over.
    }
  }

  if (ready.length === 0) return { stored: 0, skipped: parts.length };

  try {
    await withTx(async (tx: DbTx) => {
      const readyAt = new Date();
      const entries: AuditEntry[] = [];
      for (const r of ready) {
        const flipped = await tx.attachment.updateMany({
          where: { id: r.id, state: "PENDING" },
          data: { state: "READY", readyAt, size: r.size, sha256: r.sha256 },
        });
        if (flipped.count === 0) continue;
        entries.push({
          action: "ATTACHMENT_ADDED",
          entityType: "ATTACHMENT",
          entityId: r.id,
          ticketId: target.ticketId,
          fieldChanged: "state",
          oldValue: "PENDING",
          newValue: "READY",
          metadata: {
            stage: "ready",
            via: call.via,
            source: EMAIL_SOURCE,
            filename: r.filename,
            mime: r.mime,
            size: r.size,
            backend: store.backend,
            sourceObjectRef: r.sourceObjectRef,
          },
        });
      }
      await writeAuditMany(tx, call.actor, call.ctx, entries);
    });
  } catch {
    return { stored: 0, skipped: parts.length };
  }

  return { stored: ready.length, skipped: parts.length - ready.length };
}

// ---------------------------------------------------------------------------
// ingestInboundEmail
// ---------------------------------------------------------------------------

type Prepared = {
  input: InboundEmail;
  headers: Record<string, string>;
  mailbox: string;
  fromAddress: string | null;
  subject: string;
  externalId: string;
  body: string;
  auth: SenderAuthVerdict;
};

function prepare(raw: unknown): Prepared {
  const input = inboundEmailSchema.parse(raw);
  const headers = lowerHeaders(input.headers);
  const mailbox = normalizeMailboxAddress(input.mailbox) ?? input.mailbox.trim().toLowerCase();
  return {
    input,
    headers,
    mailbox,
    // `parseFromAddress`, NOT `normalizeMailboxAddress`: this value IS the sender's identity (the
    // §7.1 gate, `requesterEmail`, `senderAddress`), so it must be the addr-spec DMARC authenticated
    // and nothing else. A display name may legally contain `<...>`, and a `From` naming several
    // mailboxes cannot be attributed to one person — both resolve to null here and hold as
    // PARSE_FAILED rather than resolving to an address the sender chose. Falling back to the raw
    // header is safe for the same reason: a correct parse of it is what DMARC aligned on.
    fromAddress: parseFromAddress(input.from) ?? parseFromAddress(headers["from"]),
    subject: normalizeSubject(input.subject, headers),
    externalId: externalIdFor(input, headers),
    body: extractBody(input),
    // `undefined` means "the module default" (mx.google.com), never "an empty list": an empty trusted
    // set would authenticate nothing and hold every inbound message. See src/lib/env.ts.
    auth: parseAuthenticationResults(
      headers["authentication-results"],
      trustedAuthservIds(env.EMAIL_TRUSTED_AUTHSERV_IDS),
    ),
  };
}

// ---------------------------------------------------------------------------
// Bounces
// ---------------------------------------------------------------------------

/**
 * Reads one prepared inbound message as a DSN and, when it names a delivery of ours, records the
 * bounce. Returns null for everything else — which is every ordinary message.
 *
 * Never throws. A bounce is evidence ABOUT a previous record; failing to record it must not cost us the
 * held row that is the record of THIS message. A failure here leaves the delivery at SENT and the DSN
 * in the intake queue, which is exactly the state the desk was in before this existed.
 */
async function recordBounceForInbound(p: Prepared, call: IngestCallContext): Promise<BounceRecord | null> {
  try {
    const report = parseDsn(p.headers, p.body);
    if (!report.isBounce || report.originalMessageId === null || report.type === null) return null;
    return await recordBounce(call.actor, call.ctx, {
      originalMessageId: report.originalMessageId,
      bounceType: report.type,
      dsnCode: report.status,
      dsnSenderAuthenticated: p.auth.authenticated,
      // A DSN reaches us through the ingest route, so it is a machine caller (§3 rule 1). `call.via` is
      // `AUDIT_VIA.email` on that path; the fallback keeps the row legible if a caller passes none.
      via: call.via ?? AUDIT_VIA.email,
    });
  } catch (e) {
    logError("email-intake", e, { op: "record_bounce", messageId: p.externalId });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Releasing a FORWARDED hold as the parsed original requester
// ---------------------------------------------------------------------------

/** Why a forwarded hold may not be released against its parsed candidate. */
export type ForwardedReleaseRefusal =
  | "NOT_FORWARDED"
  | "NO_CANDIDATE"
  | "CANDIDATE_MISMATCH"
  | "SENDER_NOT_AUTHENTICATED"
  | "SENDER_NOT_STAFF";

export type ForwardedReleaseDecision =
  | { allowed: true; requesterEmail: string; forwardedBy: string }
  | { allowed: false; refusal: ForwardedReleaseRefusal };

/** One line per refusal, written for the reviewer rather than for a log. */
export const FORWARDED_RELEASE_REFUSAL_MESSAGES: Readonly<Record<ForwardedReleaseRefusal, string>> = {
  NOT_FORWARDED: "This message was not held as a forward, so there is no original sender to release it against.",
  NO_CANDIDATE:
    "No original sender could be read out of the forwarded block. Release it against the sender as usual, or discard it.",
  CANDIDATE_MISMATCH:
    "That address is not the one parsed out of the forwarded message. Release it against the parsed address, then change the requester on the ticket if it is wrong — that change is confirmed and recorded on its own.",
  SENDER_NOT_AUTHENTICATED:
    "The forward itself failed sender authentication, so we cannot prove who forwarded it. Nothing in it may be attributed to anyone else.",
  SENDER_NOT_STAFF:
    "Only a forward from an active member of staff can be released against the address inside it. A forward from outside the firm is that person's own message.",
};

/**
 * Whether a held FORWARDED message may be released with the PARSED original sender as the ticket's
 * requester, rather than with the forwarder.
 *
 * The ordinary release path adopts `SuspendedIntake.fromAddress` as `Ticket.requesterEmail`. For a
 * forward that is the wrong person, and this is the narrow exception — narrow in three ways, each of
 * which is the thing that would otherwise go wrong:
 *
 *  1. **The forward must have passed sender authentication.** If DMARC did not prove who forwarded it,
 *     the whole message is unproven and nothing inside it may be promoted to a requester address that
 *     receives every later reply and opens the thread in the client API.
 *  2. **The forwarder must be an ACTIVE member of staff.** This is the "authenticated staff senders"
 *     restriction. An advisor forwarding a client's mail into the desk is a colleague vouching for its
 *     provenance, and that vouching is what the release rests on. A forward from outside the firm is
 *     that outsider's own message: they wrote to us, and a stranger must not be able to open a ticket
 *     in a client's name by quoting the client's address in a forwarded block.
 *  3. **The address must be the one that was PARSED.** A free-text field here would be an unaudited
 *     way to point a ticket at any address at all — which is exactly what `changeRequesterEmail`
 *     exists to gate, with its own confirmation and recorded reason. Release against the parsed
 *     candidate; correct it afterwards through the path that charges for it.
 *
 * It decides; it writes nothing. The release action is `releaseHeldIntake` in
 * `src/server/suspended-intake.actions.ts`, which this slice does not own — the exact call it needs to
 * add is written up in the build record
 */
export async function resolveForwardedRelease(input: {
  suspendedId: string;
  /** The address the reviewer chose. Must equal the stored candidate. */
  requestedRequesterEmail: string;
}): Promise<ForwardedReleaseDecision> {
  const row = await prisma.suspendedIntake.findUnique({
    where: { id: input.suspendedId },
    select: { reason: true, fromAddress: true, senderVerified: true, candidateRequesterEmail: true },
  });
  if (row === null || row.reason !== "FORWARDED") return { allowed: false, refusal: "NOT_FORWARDED" };
  if (row.candidateRequesterEmail === null || row.candidateRequesterEmail.length === 0) {
    return { allowed: false, refusal: "NO_CANDIDATE" };
  }

  // `safeEqualEmails` (CWE-208): this decides whether a hold may be released AS the parsed original
  // requester, so it is an identity check, not a string check — the same call and the same reason as
  // `src/server/client-view.ts` and the MCP requester binding. It applies the SAME trim + lower-case
  // to both sides that the `!==` here applied inline to each, so the accepted set is unchanged.
  const requested = input.requestedRequesterEmail;
  if (!safeEqualEmails(requested, row.candidateRequesterEmail)) {
    return { allowed: false, refusal: "CANDIDATE_MISMATCH" };
  }
  if (!row.senderVerified) return { allowed: false, refusal: "SENDER_NOT_AUTHENTICATED" };

  const forwarder = parseFromAddress(row.fromAddress);
  if (forwarder === null) return { allowed: false, refusal: "SENDER_NOT_STAFF" };
  const staff = await prisma.user.findFirst({
    where: { email: { equals: forwarder, mode: "insensitive" }, isActive: true },
    select: { id: true },
  });
  if (staff === null) return { allowed: false, refusal: "SENDER_NOT_STAFF" };

  return { allowed: true, requesterEmail: row.candidateRequesterEmail, forwardedBy: forwarder };
}

/**
 * The dedupe read for a held message: `SuspendedIntake` carries no receipt, its `messageId` is the key.
 *
 * The key is read through `sanitizedMessageId` because that is the form `suspendIntake` STORES; a
 * Message-ID carrying a redaction target would otherwise be written redacted and looked up raw, and
 * every delivery of that one message would land its own permanent row.
 */
async function existingSuspension(externalId: string): Promise<IntakeOutcome | null> {
  const messageId = sanitizedMessageId(externalId);
  if (messageId === null) return null;
  const row = await prisma.suspendedIntake.findFirst({
    where: { messageId },
    select: { id: true, reason: true },
    orderBy: { createdAt: "asc" },
  });
  return row === null ? null : { outcome: "suspended", suspendedId: row.id, reason: row.reason };
}

/**
 * Ingests one inbound message. Returns what it became; throws only for a payload that is not a
 * message at all (`ValidationError` → 422) or a genuine infrastructure failure.
 *
 * Every refusal is a `SuspendedIntake` row rather than an error, because the alternative — a 4xx back
 * to the workflow — silently drops client mail into an n8n execution log nobody reviews.
 */
export async function ingestInboundEmail(input: InboundEmail, call: IngestCallContext): Promise<IntakeOutcome> {
  const p = prepare(input);

  const hold = async (
    reason: SuspendedIntakeReason,
    detail?: string,
    extra?: { candidateRequesterEmail?: string | null; candidateRequesterName?: string | null },
  ): Promise<IntakeOutcome> => {
    // A Delivery Status Notification is the one held message that is ABOUT one of our own records, and
    // the transition it triggers must not depend on WHICH gate held it. The gates are ordered and a
    // DSN routinely arrives with no `Authentication-Results` at all, so gate 2 frequently wins and the
    // BOUNCE branch of gate 4 is never reached. Recording the bounce here — beside every hold, before
    // the suspension — is what makes "the client never got our reply" reach the ticket rather than
    // only the intake queue. `recordBounce` is idempotent and returns null unless the DSN names a
    // Message-ID this desk generated, so this is a no-op for every ordinary message.
    const ownBounce = await recordBounceForInbound(p, call);
    const bounceDetail = ownBounce === null ? undefined : OWN_BOUNCE_DETAIL;

    // Exactly-once per Message-ID for held mail. This read lives HERE, beside the write it guards,
    // rather than at the top of the function: the gates below now run BEFORE any replay shortcut, so
    // gates 1 and 2 reach a hold without a top-of-function read ever having happened. On the paths
    // where gate 3 already looked and missed this is a second indexed read of the same key — the
    // price of never writing a duplicate permanent row in a table that cannot be deleted.
    const replayed = await existingSuspension(p.externalId);
    if (replayed !== null) return replayed;

    const { suspendedId } = await suspendIntake(
      {
        reason,
        mailbox: p.mailbox,
        fromAddress: p.fromAddress ?? p.input.from,
        subject: p.subject,
        messageId: p.externalId,
        rawRef: p.input.rawRef ?? null,
        headers: suspendedHeaders(p.headers),
        snippet: p.body.slice(0, INGEST_LIMITS.snippetMaxChars),
        // The caller's detail wins; the bounce detail is what a hold that carries no other detail
        // says instead. Both are non-client-material labels, never a second reason.
        detail: detail ?? bounceDetail ?? null,
        // Recorded on EVERY hold, whichever reason won. The gates are ordered, so an unauthenticated
        // message that also arrived on an unmapped address is held as `UNKNOWN_MAILBOX` and its
        // reason says nothing about the sender — but the reviewer deciding whether to release a wire
        // or address-change instruction needs exactly this, and the release gate reads it too.
        senderVerified: p.auth.authenticated,
        candidateRequesterEmail: extra?.candidateRequesterEmail ?? null,
        candidateRequesterName: extra?.candidateRequesterName ?? null,
      },
      call,
    );
    return { outcome: "suspended", suspendedId, reason };
  };

  // 1. Mailbox — no route, no queue, no brand, nothing this can become.
  const route: MailboxRoute | null = routeForMailbox(p.mailbox, parseMailboxMap(env.MAILBOX_MAP));
  if (route === null) return hold("UNKNOWN_MAILBOX");

  // 2. Sender authentication, BEFORE anything reads a ticket OR a receipt (the BEC control).
  if (p.fromAddress === null) return hold("PARSE_FAILED");
  if (!p.auth.authenticated) return hold("UNAUTHENTICATED");

  // 3. Idempotency. A replayed message never produces a second record of any kind — but a replay is
  //    only a replay when the message is the SAME message, and a Message-ID does not establish that.
  //    It is the sender's own text and it travels in the `References` of every reply and in every
  //    forwarded or Cc'd copy of the thread, so anyone who has ever been on a thread with the desk
  //    holds one. Running this ahead of gates 1 and 2 let such a message be answered with the earlier
  //    outcome while failing DMARC, arriving from an untrusted authserv-id or coming from a different
  //    sender entirely — and it wrote NOTHING: no row, no audit entry, nothing for a reviewer. The
  //    gates therefore run first, and the receipt is re-checked against the ticket it names: a replay
  //    whose sender is not that ticket's requester is not a retry, it is a third party holding a
  //    Message-ID, and it is held for a human exactly as a thread match by that sender would be.
  const receipt = await findIngestReceipt(EMAIL_SOURCE, p.externalId);
  if (receipt !== null && receipt.ticketId !== null) {
    const receiptIdentity = await threadSenderIdentity(receipt.ticketId, p.fromAddress);
    if (receiptIdentity === "mismatch") return hold("UNAUTHENTICATED", SENDER_MISMATCH_DETAIL);
    if (receiptIdentity === "match") {
      const ticket = await prisma.ticket.findUnique({
        where: { id: receipt.ticketId },
        select: { id: true, number: true },
      });
      if (ticket !== null) {
        return receipt.outcome === "comment" && receipt.commentId !== null
          ? { outcome: "comment", ticketId: ticket.id, commentId: receipt.commentId, reopened: false }
          : { outcome: "ticket", ticketId: ticket.id, ticketNumber: ticket.number };
      }
    }
    // `missing` — the receipt names a ticket that is gone. Fall through and let the message become a
    // record of its own, exactly as a vanished thread match does below.
  }
  const replayedSuspension = await existingSuspension(p.externalId);
  if (replayedSuspension !== null) return replayedSuspension;

  // 4. Machine traffic.
  const classified = classifyInbound(p.headers, p.body);
  if (classified !== null) return hold(classified);
  if (p.input.spamFlagged === true) return hold("SPAM");

  // 5. Parse quality.
  if (p.body.trim().length === 0) return hold("PARSE_FAILED");
  if (p.body.length > INBOUND_BODY_HARD_LIMIT_CHARS) return hold("OVERSIZE");

  // 5b. Forwarded mail (`SuspendedIntakeReason += FORWARDED`).
  //
  // This is the one shape where every identity control above PASSES and the answer is still wrong. The
  // forwarder really did send the message — DMARC proves it — but the request inside it is somebody
  // else's. Written as an ordinary message it would take `Ticket.requesterEmail` from the FORWARDER,
  // which is three privileges handed to the wrong person at once: every later staff reply is delivered
  // to them, the client API treats that address as the authorization subject for the thread, and a
  // reply to a closed one opens a new ticket in their name carrying the real client's household.
  //
  // It runs BEFORE threading on purpose. An advisor forwarding a client's reply carries that reply's
  // `References`, so the Message-ID matcher below would find the right ticket and then gate 6b would
  // hold it as a SENDER_MISMATCH — losing both the fact that this is a forward and the parsed original
  // sender a reviewer needs. Held here, the review card says what it is and offers the candidate.
  //
  // The gate is narrower than "looks forwarded", and the narrowing is the recommended default recorded
  // in the build record: a forward only holds when a DISTINCT embedded
  // sender was actually parsed out of the block. A client forwarding their own custodian's receipt to
  // the desk is writing their OWN message with context attached — there is no mis-attribution to
  // prevent, and holding every `Fwd:` would put ordinary client mail in a review queue.
  const forwarded = analyzeForwarded({ ...p.headers, subject: p.subject }, p.body);
  if (
    forwarded.isForwarded &&
    forwarded.candidateFrom !== null &&
    // `!safeEqualEmails` rather than `!==` (CWE-208): the operands are two addresses, and what this
    // gate decides is whether the message may be attributed to its envelope sender — an identity
    // question. `analyzeForwarded` already lower-cases `candidateFrom`, and the call normalises both
    // sides identically, so the gate holds on exactly the messages it held on before.
    !safeEqualEmails(forwarded.candidateFrom, p.fromAddress)
  ) {
    return hold("FORWARDED", undefined, {
      candidateRequesterEmail: forwarded.candidateFrom,
      // The name off the SAME embedded line, verbatim. The address is lower-cased because an address
      // is; the name is not, and this is the only moment it exists — the raw message is never stored
      //, so a name dropped here is a client mis-named on every record the release produces.
      candidateRequesterName:
        typeof forwarded.candidateFromHeader === "string"
          ? displayNameFrom(forwarded.candidateFromHeader)
          : null,
    });
  }

  // 6. Threading.
  const match = await resolveThread(p.input, p.headers, p.fromAddress);

  // 6b. Sender identity, on EVERY matcher — not just the subject fallback.
  //
  // DMARC proved the sender is who they claim to be; it did not prove they are THIS client. Both
  // primary matchers ride on material that travels with a forward or a Cc: the stored Message-ID is
  // in the References of every copy of our reply, and the plus-addressed reply token is in its
  // Reply-To. A spouse, an accountant or an attorney who was forwarded one reply would otherwise
  // have their words written as the client's own PUBLIC comment (authorId null, rendered to the
  // client as "You"), could reopen a RESOLVED ticket, or — on a CLOSED one — open a NEW ticket
  // carrying the victim's requesterEmail, householdId and requesterExternalId, to which every later
  // staff reply would be delivered. A mismatch is therefore held for a human, not written, and it is
  // NOT silently turned into a new ticket either: filing a third party's message under their own
  // name would drop the fact that they were writing about someone else's account.
  const identity = match.kind === "none" ? "missing" : await threadSenderIdentity(match.ticketId, p.fromAddress);
  if (identity === "mismatch") return hold("UNAUTHENTICATED", SENDER_MISMATCH_DETAIL);

  // 7. Write. A reply's quoted history is stripped; a first contact keeps everything it carried,
  //    because on a NEW thread the quoted material below "On … wrote:" is usually the very context
  //    the client forwarded in — and losing it loses the ticket's substance.
  const parts = p.input.attachments ?? [];
  const requesterName = requesterNameFrom(p.input.from, p.fromAddress);

  // `missing` is a match whose ticket row has gone; it becomes a new thread, like no match at all.
  if (match.kind === "none" || identity === "missing") {
    const created = await createTicketCore(
      {
        source: EMAIL_SOURCE,
        externalId: p.externalId,
        subject: p.subject,
        description: p.body,
        category: route.category as TicketCategory | undefined,
        queueKey: route.queueKey,
        brand: route.brand,
        requesterName,
        requesterEmail: p.fromAddress,
      },
      call,
    );
    if (parts.length > 0) {
      await persistAttachmentParts(parts, { ticketId: created.ticketId, commentId: null }, call);
    }
    return { outcome: "ticket", ticketId: created.ticketId, ticketNumber: created.ticketNumber };
  }

  const stripped = stripQuotedHistory(p.body);
  const { result, linkedFromTicketId } = await addRequesterMessageOrFollowUp(
    {
      ticketId: match.ticketId,
      source: EMAIL_SOURCE,
      externalId: p.externalId,
      authorKind: "REQUESTER",
      body: stripped.body,
      // Provably the ticket's own requesterEmail: §10.1's identity gate refused every other sender
      // before this point. Recorded so COMMENT_ADDED_REQUESTER names the mailbox, not just the
      // machine actor that wrote the row.
      senderAddress: p.fromAddress,
      // CONTRACT §1.2. For an EMAIL-source ingest `externalId` IS the RFC 5322 Message-ID
      // (`externalIdFor`), so this persists on the comment the id the next outbound reply threads
      // under. It is the same value the receipt already carries; the column simply makes it reachable
      // without a join, and makes it survive a source whose receipt key is not a Message-ID.
      inboundMessageId: p.externalId,
    },
    call,
  );

  if (parts.length > 0) {
    await persistAttachmentParts(parts, { ticketId: result.ticketId, commentId: result.commentId }, call);
  }

  // a reply to a CLOSED ticket opened a NEW linked ticket; it is a ticket, not a comment.
  if (linkedFromTicketId !== null || result.commentId === null) {
    return { outcome: "ticket", ticketId: result.ticketId, ticketNumber: result.ticketNumber };
  }
  return {
    outcome: "comment",
    ticketId: result.ticketId,
    commentId: result.commentId,
    reopened: result.reopened,
  };
}

/** Parses an unknown body into an `InboundEmail`. Throws `ValidationError`-shaped zod errors (422). */
export function parseInboundEmail(raw: unknown): InboundEmail {
  return inboundEmailSchema.parse(raw);
}
