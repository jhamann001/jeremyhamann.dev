/**
 * Transactional outbox for client-facing replies — node only, layer L4
 *.
 *
 * The desk never talks to a mail provider. A public reply writes a `MessageDelivery` row in the SAME
 * transaction as the comment and its audit row; a poller outside this repo leases queued rows over
 * `/api/integrations/outbox`, sends them, and reports the outcome back. That is what makes the app
 * transport-agnostic: swapping Workspace-via-n8n for a dedicated ESP changes the poller and nothing here.
 *
 * Nothing in this module transmits. With no poller configured, deliveries simply accumulate as QUEUED
 * rows and the UI says "Queued" — it never says "Sent" without a reported delivery result.
 *
 * Audit discipline (§3 rule 2): `enqueueDelivery` RETURNS its `MESSAGE_QUEUED` entry instead of writing
 * it, so `addPublicReply`'s single trailing `writeAuditMany` stays the last statement of its transaction.
 * `leaseQueuedDeliveries` and `reportDeliveryOutcome` own their transactions and write audit last themselves.
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  AuditActor,
  AuditEntry,
  MessageDeliveryStatus,
  RequestContext,
  SuppressionReason,
  TicketBrand,
  TicketSource,
} from "@/types/domain";
import { AUDIT_VIA, writeAuditMany } from "@/lib/audit";
import type { AuditVia } from "@/lib/audit";
import { identityFor, messageIdFor, replyToFor } from "@/lib/brand";
import { withTx } from "@/lib/db";
import type { DbTx } from "@/lib/db";
import { renderOutbound } from "@/lib/email/render-outbound";
import { formatReplyToken } from "@/lib/email/reply-token";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";

/** How long a leased delivery is reserved for one poller before it returns to the queue. */
export const OUTBOX_LEASE_MS: number = 5 * 60_000;
/** Attempts after which a delivery stays FAILED and stops being handed out. */
export const MESSAGE_MAX_ATTEMPTS = 5;
/** Largest page the outbox route will hand out in one call. */
export const OUTBOX_MAX_LIMIT = 50;
/** Page size when the caller does not ask for one. */
export const OUTBOX_DEFAULT_LIMIT = 25;
/** `lastError` is a reason, never a provider payload. */
export const DELIVERY_ERROR_MAX_CHARS = 1_000;
/** A provider's own message id: an opaque token, bounded before it reaches the ledger. */
export const PROVIDER_MESSAGE_ID_MAX_CHARS = 200;
/**
 * `lastError` for a row whose poller took its FINAL attempt and never reported. The lease expiring is
 * the only evidence the desk will ever get about that attempt, so it is what the ledger records.
 */
export const LEASE_EXPIRED_AT_CAP_ERROR = "lease expired at the attempt cap";

/** Characters a local part may not hold: whitespace, a second `@`, and the address-list punctuation. */
const LOCAL_PART_FORBIDDEN = /[\s@<>,;"]/;

/** One domain label. A single quantifier over one class, anchored — linear, with nothing to nest. */
const DOMAIN_LABEL = /^[A-Za-z0-9-]+$/;

/**
 * True for an address a delivery may be queued to: `local@domain`, one `@`, no whitespace — the same
 * strictness `src/lib/brand.ts` applies to our own.
 *
 * Exported because three call sites need the SAME answer and were each carrying their own copy of the
 * pattern — see the build record, where B5 asked for exactly
 * this. It is the only answer in the module: `enqueueDelivery` calls it too, so a caller and the
 * enqueue it feeds can never disagree about whether an address is deliverable.
 *
 * The body replaces `/^[^\s@<>,;"]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/`, whose `(?:…+)+` is the
 * nested quantifier security scanner reports under CWE-1333 (it is the finding raised against this line on the
 * Wave B PR). Splitting on `.` and checking each label is the same acceptance test written linearly:
 * the regex required two or more non-empty `[A-Za-z0-9-]` labels, and a stray `@` in the domain fails
 * `DOMAIN_LABEL` here exactly as it failed the character class there. **Do not restore the
 * `DELIVERABLE_ADDRESS` constant** — `src/server/validation.ts` and
 * `src/components/admin/macros/macro-form-support.ts` both cite this function as the copy whose shape
 * their own CWE-1333 fix follows, and re-adding it brings the finding back to all three.
 *
 * `null`/`undefined` answer `false` rather than throwing: the call sites read a nullable column.
 * The trim and the lower-case live here, so every caller is normalised identically.
 */
export function isDeliverableAddress(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  const at = value.indexOf("@");
  if (at < 1) return false;
  if (LOCAL_PART_FORBIDDEN.test(value.slice(0, at))) return false;
  const labels = value.slice(at + 1).split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!DOMAIN_LABEL.test(label)) return false;
  }
  return true;
}

/**
 * `lastError` on a delivery that was never attempted because the address is suppressed.
 *
 * Duplicated byte for byte from `src/server/system-messages.ts` rather than imported: that module
 * imports `enqueueDelivery` from this one, and importing back would close a cycle. The two are pinned
 * together by `outbox.test.ts`; see the build record
 */
export const SUPPRESSED_DELIVERY_ERROR = "recipient is on the suppression list" as const;

// ---------------------------------------------------------------------------
// Suppression — the outbox's own refusal
// ---------------------------------------------------------------------------

/** A live suppression: the row exists and has not been removed. */
export type LiveSuppression = { id: string; email: string; reason: SuppressionReason };

/**
 * The live suppression for one address, or null.
 *
 * "Live" is `removedAt IS NULL` — the same rule the DTO and `/admin/suppression` use, stated once here
 * so a write path and a read surface can never disagree about whether an address is stopped. The
 * address is lower-cased before the lookup because `RequesterSuppression.email` is unique on the
 * lower-cased form and `Ticket.requesterEmail` is not guaranteed to be.
 *
 * Takes a `DbTx` rather than the global client on purpose: every caller is inside the transaction that
 * is about to write the delivery row, and a suppression read outside it could be answered from before
 * an administrator's `addSuppression` committed.
 */
export async function findLiveSuppression(tx: DbTx, email: string): Promise<LiveSuppression | null> {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (address.length === 0) return null;
  const row = await tx.requesterSuppression.findUnique({
    where: { email: address },
    select: { id: true, email: true, reason: true, removedAt: true },
  });
  if (row === null || row.removedAt !== null) return null;
  return { id: row.id, email: row.email, reason: row.reason };
}

/** `findLiveSuppression` as a predicate, for a caller that only needs the yes/no. */
export async function isRequesterSuppressed(tx: DbTx, email: string): Promise<boolean> {
  return (await findLiveSuppression(tx, email)) !== null;
}

/**
 * Every live suppression among a set of addresses, keyed by the lower-cased address.
 *
 * One query for a whole lease page. `leaseQueuedDeliveries` hands out up to fifty rows and would
 * otherwise make fifty round trips to answer a question that is almost always "no".
 */
async function liveSuppressionsFor(
  tx: DbTx,
  addresses: readonly string[],
): Promise<Map<string, LiveSuppression>> {
  const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await tx.requesterSuppression.findMany({
    where: { email: { in: unique }, removedAt: null },
    select: { id: true, email: true, reason: true },
  });
  return new Map(rows.map((r) => [r.email, { id: r.id, email: r.email, reason: r.reason }]));
}

// ---------------------------------------------------------------------------
// Enqueue — runs INSIDE addPublicReply's transaction
// ---------------------------------------------------------------------------

export type EnqueueDeliveryInput = {
  ticketId: string;
  ticketNumber: number;
  brand: TicketBrand;
  /** The requester's address. A ticket with no deliverable address never reaches this function. */
  toAddress: string;
  /** The ticket subject, unprefixed; `renderOutbound` adds `[HD-<number>] `. */
  subject: string;
  commentId: string;
  /** The STORED comment body — the disclaimer is already appended. */
  body: string;
  /**
   * Set ONLY when a machine caller is the one replying (§3 rule 1). The staff composer leaves it
   * undefined, so `metadata->>'via' IS NULL` still partitions the ledger into human and machine rows;
   * an ingest-authored public reply passes its `IngestCallContext.via` and the delivery's
   * `MESSAGE_QUEUED` row matches the `COMMENT_ADDED_PUBLIC` row it was written beside.
   */
  via?: AuditVia;
  /** The machine caller's own identifier, carried alongside `via`. Meaningless without it. */
  source?: TicketSource;
};

export type EnqueueDeliveryResult = {
  deliveryId: string;
  messageId: string;
  auditEntry: AuditEntry;
  /**
   * The state the row was BORN in. `"QUEUED"` for an ordinary reply; `"FAILED_SUPPRESSED"` when the
   * destination is on the suppression list, in which case nothing will ever be handed out for it.
   * Additive to the §10 shape so a caller can render the right chip without a second read.
   */
  status: MessageDeliveryStatus;
  /** The suppression that stopped it, for the composer's explanation. Null on the ordinary path. */
  suppression: LiveSuppression | null;
};

// ---------------------------------------------------------------------------
// Threading headers (CONTRACT §1.2 `MessageDelivery.inReplyTo` / `references`)
// ---------------------------------------------------------------------------

/**
 * How many Message-IDs the `References` header carries, and how long it may get.
 *
 * RFC 5322 puts no ceiling on `References`, and a long thread's header genuinely grows without bound —
 * which is how a header that exists to keep a conversation together ends up being the reason an MTA
 * rejects the message. The trim keeps the FIRST id (the thread root, which is what every mail client
 * groups on) and the most recent ones, which is what the RFC's own guidance amounts to.
 */
export const REFERENCES_MAX_IDS = 20;
export const REFERENCES_MAX_CHARS = 2_000;

/** `<id>` — the header form. Our stored delivery ids already carry brackets; inbound ids do not. */
function bracketed(id: string): string {
  const bare = id.trim();
  return bare.startsWith("<") && bare.endsWith(">") ? bare : `<${bare}>`;
}

/**
 * A value that can honestly be a Message-ID.
 *
 * `externalIdFor` in `src/server/email-intake.ts` synthesises `synthetic.<sha256>` for a message that
 * arrived without one, and that string is a receipt key, not a header the sender's mail client will
 * recognise. Putting it in `In-Reply-To` would thread nothing and would leak a hash of the message body
 * into a header the client can read.
 */
function isRealMessageId(id: string | null | undefined): id is string {
  if (typeof id !== "string") return false;
  const bare = id.trim().replace(/^<|>$/g, "");
  return bare.length > 0 && bare.length <= 400 && bare.includes("@") && !bare.startsWith("synthetic.") && !/\s/.test(bare);
}

/** The threading headers for the next outbound message on a ticket. */
export type ThreadHeaders = { inReplyTo: string | null; references: string | null };

/**
 * Builds `In-Reply-To` and `References` for the reply about to be queued.
 *
 * WHY THIS EXISTS. Without them, every reply the desk sends starts a NEW conversation in the client's
 * mail client. They see five unrelated messages with the same subject instead of one thread, they reply
 * to whichever one they scroll to, and the thread the desk has been keeping in one ticket is
 * reassembled by the client by hand — or not at all.
 *
 * `In-Reply-To` is the single message this reply answers: the client's most recent inbound message on
 * this ticket. `References` is the chain that precedes it, oldest first, so a client that supports
 * threading can place the message even if it never received the one immediately before.
 *
 * WHERE THE INBOUND IDS COME FROM, in order:
 *   1. `Comment.inboundMessageId` — the column Wave B added for exactly this. It is the
 *      right source and it is read first.
 *   2. `IngestReceipt.externalId` for an EMAIL-sourced receipt that names a comment. For an inbound
 *      email the receipt key IS the RFC 5322 Message-ID (`externalIdFor`), so the receipt table already
 *      holds every inbound id this ticket has ever had, keyed to the comment it produced.
 *
 * Source 1 answers first as of integration round 1: `ingestMessageSchema` now carries an optional
 * `inboundMessageId` and `src/server/ingest.ts` writes it on the requester-authored comment at
 * creation (a comment is immutable, so there is no later moment). Source 2 is NOT dead code and
 * must not be removed — it is what makes threading correct for every row written BEFORE that column
 * was populated, which a column alone never would be, and for an inbound email the receipt key IS the
 * RFC 5322 Message-ID, so the two sources agree by construction rather than by coincidence.
 *
 * With no inbound id at all — a phone-origin ticket the desk is emailing, or a first reply to a ticket
 * raised in the app — the chain is our OWN previous deliveries, so at least the desk's side of the
 * conversation groups. A ticket with no history at all gets `{ null, null }`, which is correct: there
 * is nothing to thread to.
 */
export async function threadHeadersFor(tx: DbTx, ticketId: string): Promise<ThreadHeaders> {
  type Dated = { id: string; at: number };
  const collected: Dated[] = [];

  // 1. Inbound ids carried on the comments themselves.
  const comments = await tx.comment.findMany({
    where: { ticketId, inboundMessageId: { not: null } },
    select: { inboundMessageId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: REFERENCES_MAX_IDS * 2,
  });
  for (const c of comments) {
    if (isRealMessageId(c.inboundMessageId)) collected.push({ id: c.inboundMessageId, at: c.createdAt.getTime() });
  }

  // 2. Inbound ids recorded as receipts. `receivedAt` is the inbound instant.
  const receipts = await tx.ingestReceipt.findMany({
    where: { ticketId, source: "EMAIL" },
    select: { externalId: true, receivedAt: true },
    orderBy: { receivedAt: "asc" },
    take: REFERENCES_MAX_IDS * 2,
  });
  for (const r of receipts) {
    if (isRealMessageId(r.externalId)) collected.push({ id: r.externalId, at: r.receivedAt.getTime() });
  }

  const inboundIds = new Set(collected.map((c) => c.id.trim().replace(/^<|>$/g, "").toLowerCase()));

  // 3. Our own previous outbound ids. A CANCELLED or suppressed delivery is included deliberately: the
  //    header describes the CONVERSATION, and a message the client did receive earlier in it is a
  //    reference point whether or not the desk later withdrew a different one.
  const deliveries = await tx.messageDelivery.findMany({
    where: { ticketId },
    select: { messageId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: REFERENCES_MAX_IDS * 2,
  });
  for (const d of deliveries) {
    if (isRealMessageId(d.messageId)) collected.push({ id: d.messageId, at: d.createdAt.getTime() });
  }

  if (collected.length === 0) return { inReplyTo: null, references: null };

  // Oldest first, de-duplicated on the bare form so a bracketed and a bare spelling of one id collapse.
  collected.sort((a, b) => a.at - b.at);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const entry of collected) {
    const key = entry.id.trim().replace(/^<|>$/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(bracketed(entry.id));
  }

  // `In-Reply-To` is the most recent INBOUND id — the client's own last message — and only falls back
  // to our last outbound one when the client has never written on this thread.
  const lastInbound = [...ordered]
    .reverse()
    .find((id) => inboundIds.has(id.replace(/^<|>$/g, "").toLowerCase()));
  const inReplyTo = lastInbound ?? ordered[ordered.length - 1];

  return { inReplyTo, references: trimReferences(ordered) };
}

/** The `References` value: oldest first, root kept, trimmed to the id and character ceilings. */
export function trimReferences(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  let kept = [...ids];
  if (kept.length > REFERENCES_MAX_IDS) {
    kept = [kept[0], ...kept.slice(kept.length - (REFERENCES_MAX_IDS - 1))];
  }
  let value = kept.join(" ");
  while (value.length > REFERENCES_MAX_CHARS && kept.length > 1) {
    // Drop from just after the root: the root is what clients group on, the tail is what they match.
    kept = [kept[0], ...kept.slice(2)];
    value = kept.join(" ");
  }
  return value.length > REFERENCES_MAX_CHARS ? value.slice(0, REFERENCES_MAX_CHARS) : value;
}

/**
 * Inserts the `MessageDelivery` row for one public reply and returns the audit entry for it.
 *
 * Refuses (AppError) when the brand has no resolvable identity, or when the address is not deliverable —
 * the desk never sends from a guessed address and never queues mail to a value that cannot be one. The
 * throw propagates out of the caller's transaction, so the comment rolls back with it: there is no state
 * in which a reply exists that was supposed to be delivered and silently was not.
 *
 * The Message-ID is generated here and stored, because S2 threads an inbound reply by matching
 * `In-Reply-To` / `References` against this column — that is the PRIMARY matcher. The row also
 * carries the OUTBOUND threading headers (`threadHeadersFor`), so the client's mail client keeps one
 * conversation instead of one message per reply.
 *
 * SUPPRESSION. A destination on `RequesterSuppression` does NOT throw. The row is
 * created in `FAILED_SUPPRESSED`, with `lastError` naming the reason, and the audit entry is a
 * `MESSAGE_FAILED` recording that terminal state — never a `MESSAGE_QUEUED` for a message that was
 * never queued. Three consequences of that choice, all deliberate:
 *
 *  - **The comment is still written.** A staff reply is the desk's own words and belongs on the record
 *    whether or not it can be delivered. Throwing would roll the comment back and leave
 *    the desk unable to record that it answered.
 *  - **The row is fully rendered.** Subject, text part, HTML part and Message-ID are all produced
 *    exactly as they would have been, so the record of what the desk WOULD have sent is complete and
 *    the only difference from an ordinary delivery is the state it was born in.
 *  - **Nothing retries it.** `FAILED_SUPPRESSED` is not a lease candidate. Removing the suppression
 *    does not resurrect the message; the desk writes a new reply, which is a new comment and a new
 *    delivery, because a comment is immutable.
 */
export async function enqueueDelivery(tx: DbTx, input: EnqueueDeliveryInput): Promise<EnqueueDeliveryResult> {
  const identity = identityFor(input.brand);

  const toAddress = input.toAddress.trim().toLowerCase();
  if (!isDeliverableAddress(toAddress)) {
    throw new ValidationError("ticket has no deliverable email address", {
      requesterEmail: ["This ticket has no email address a reply can be delivered to"],
    });
  }

  const suppression = await findLiveSuppression(tx, toAddress);

  // The id is generated up front so the Message-ID can embed it: a bounce or a threading question is
  // answered by reading the header, with no extra lookup table.
  const deliveryId = `dlv_${randomUUID().replace(/-/g, "")}`;
  const messageId = messageIdFor(input.brand, deliveryId);
  // REPLY_TOKEN_SECRET unset ⇒ null ⇒ the bare mailbox; inbound threading falls back to the Message-ID.
  const replyTo = replyToFor(input.brand, formatReplyToken(input.ticketId, env.REPLY_TOKEN_SECRET));
  const rendered = renderOutbound({
    ticketNumber: input.ticketNumber,
    subject: input.subject,
    body: input.body,
    identity,
  });
  const thread = await threadHeadersFor(tx, input.ticketId);

  // The row is ALWAYS created QUEUED, even when the destination is suppressed, and is refused by the
  // statement immediately below it inside this same transaction. Two reasons for the extra statement:
  //
  //  - the ledger tells the truth. `MESSAGE_FAILED` is tabulated as a TRANSITION, and
  //    `oldValue: "QUEUED"` is only honest if the row really was queued. It was — for one statement,
  //    inside a transaction nothing outside ever observed.
  //  - it is the same two-step `src/server/system-messages.ts` performs, so a suppressed staff reply
  //    and a suppressed SYSTEM message produce the same pair of states and the same audit shape.
  await tx.messageDelivery.create({
    data: {
      id: deliveryId,
      commentId: input.commentId,
      ticketId: input.ticketId,
      brand: input.brand,
      fromAddress: identity.fromAddress,
      fromName: identity.fromName,
      replyTo,
      toAddress,
      subject: rendered.subject,
      textBody: rendered.textBody,
      htmlBody: rendered.htmlBody,
      messageId,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      status: "QUEUED",
      attempts: 0,
    },
    select: { id: true },
  });

  /** Metadata every entry below carries, whichever way this enqueue ended. */
  const baseMetadata = {
    brand: input.brand,
    to: toAddress,
    messageId,
    ...(thread.inReplyTo === null ? {} : { inReplyTo: thread.inReplyTo }),
    ...(input.via === undefined ? {} : { via: input.via }),
    ...(input.via === undefined || input.source === undefined ? {} : { source: input.source }),
  };

  if (suppression !== null) {
    await tx.messageDelivery.update({
      where: { id: deliveryId },
      data: { status: "FAILED_SUPPRESSED", lastError: SUPPRESSED_DELIVERY_ERROR },
    });

    const refusal: AuditEntry = {
      action: "MESSAGE_FAILED",
      entityType: "MESSAGE_DELIVERY",
      entityId: deliveryId,
      ticketId: input.ticketId,
      fieldChanged: "status",
      oldValue: "QUEUED",
      newValue: "FAILED_SUPPRESSED",
      metadata: {
        ...baseMetadata,
        suppressed: true,
        suppressionId: suppression.id,
        reason: suppression.reason,
        terminal: true,
        error: SUPPRESSED_DELIVERY_ERROR,
      },
    };
    return {
      deliveryId,
      messageId,
      auditEntry: refusal,
      status: "FAILED_SUPPRESSED",
      suppression,
    };
  }

  const auditEntry: AuditEntry = {
    action: "MESSAGE_QUEUED",
    entityType: "MESSAGE_DELIVERY",
    entityId: deliveryId,
    ticketId: input.ticketId,
    fieldChanged: "status",
    oldValue: null,
    newValue: "QUEUED",
    // CONTRACT-GAP: §3 tabulates this metadata as `{brand, to, messageId}` only. `enqueueDelivery` is
    // called from the staff composer AND from the machine path (`addStaffMessageCore`), and §3 rule 1
    // requires every row a machine caller writes to carry `via` — without it, machine-originated mail
    // would read as human-originated in `metadata->>'via' IS NULL`. The human path passes nothing and
    // is unchanged. See the build record Wave B adds `inReplyTo` when the
    // reply threads onto something, so the ledger says which message it answers.
    metadata: baseMetadata,
  };

  return { deliveryId, messageId, auditEntry, status: "QUEUED", suppression: null };
}

// ---------------------------------------------------------------------------
// Lease — GET /api/integrations/outbox
// ---------------------------------------------------------------------------

/** Everything a sender needs, and nothing it does not. No internal notes, no ticket metadata. */
export type OutboxLease = {
  id: string;
  ticketNumber: number;
  brand: TicketBrand;
  from: string;
  fromName: string;
  replyTo: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  messageId: string;
  /**
   * RFC 5322 threading headers, already bracketed and ready to write verbatim
   * (§10 B9 "the outbox lease returns them").
   *
   * Null means "omit the header". A poller must NOT substitute its own value: the desk decides what a
   * reply answers, and a sender that guessed would thread client correspondence by subject line.
   */
  inReplyTo: string | null;
  references: string | null;
  attempts: number;
  /** ISO-8601. After this instant another poller may take the row. */
  leaseExpiresAt: string;
};

const LEASE_SELECT = {
  id: true,
  brand: true,
  fromAddress: true,
  fromName: true,
  replyTo: true,
  toAddress: true,
  subject: true,
  textBody: true,
  htmlBody: true,
  messageId: true,
  inReplyTo: true,
  references: true,
  attempts: true,
  status: true,
  ticketId: true,
  ticket: { select: { number: true } },
} as const;

/** 1..OUTBOX_MAX_LIMIT; anything else (NaN, 0, negative, oversized) collapses to a sane page. */
export function clampOutboxLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return OUTBOX_DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > OUTBOX_MAX_LIMIT) return OUTBOX_MAX_LIMIT;
  return n;
}

/**
 * Hands out up to `limit` deliveries, oldest first, and marks each LEASED with an expiry so two pollers
 * cannot double-send the same message.
 *
 * Eligible rows: QUEUED, or LEASED with an expired lease (a poller that died mid-send returns its work
 * to the pool). Terminal rows — SENT, and FAILED at `MESSAGE_MAX_ATTEMPTS` — are never handed out.
 *
 * `attempts` is incremented AT LEASE, not at report: a poller that crashes after the SMTP handshake but
 * before reporting has still spent an attempt, so a message that reliably kills the sender cannot loop
 * forever. Each row is claimed by its OWN conditional `updateMany` on (id, status, lease window), so two
 * concurrent pollers cannot both win the same row; one row per `MESSAGE_LEASED` audit entry, written in
 * a single trailing `writeAuditMany`.
 *
 * Because the attempt is spent at lease, this sweep is also where a row that spent its LAST attempt and
 * was never reported on reaches its terminal state. A candidate already at `MESSAGE_MAX_ATTEMPTS` is not
 * handed out again — that would exceed the cap — and it is not left alone either: it is transitioned to
 * FAILED with `MESSAGE_FAILED` (`terminal: true`, `lastError` = `LEASE_EXPIRED_AT_CAP_ERROR`) in this
 * same transaction. Nothing else in the app would ever move it: `reportDeliveryOutcome` runs only when a
 * caller reports, and no job touches `messageDelivery`. Left LEASED it would sit there forever and the
 * comment chip would read "Sending" for a message no sender still holds and no sender will take again.
 * Such a row occupies one slot of `take`, so a sweep may return fewer leases than asked for while it
 * clears them; each row is cleared at most once, because FAILED at the cap is never a candidate.
 *
 * `tokenId` is WHICH poller took this work: the id of the `ClientApiToken` the calling route
 * authenticated (`machineAuthTokenId` in `src/lib/integration-auth.ts`), recorded in `metadata` on
 * every row this sweep writes. Optional and trailing, so the contract's three-argument call is
 * unchanged; `null` or omitted means the caller is still on the shared `OUTBOX_API_TOKEN` /
 * `INTEGRATION_API_TOKEN` env bearer, and the rows then carry no `tokenId` key at all — the absence
 * IS the signal. The `actor` stays the seeded `svc_integration` identity either way.
 */
export async function leaseQueuedDeliveries(
  actor: AuditActor,
  ctx: RequestContext,
  limit: number,
  tokenId: string | null = null,
): Promise<OutboxLease[]> {
  const take = clampOutboxLimit(limit);
  const consumer = tokenId === null ? {} : { tokenId };

  return withTx(async (tx) => {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + OUTBOX_LEASE_MS);

    // Rows at or beyond the cap are DELIBERATELY still candidates: they are not leasable, but they are
    // the rows that need to be retired here (see the function comment). The cap is enforced per row
    // below, not by this filter, so nothing above it can be handed out.
    const candidates = await tx.messageDelivery.findMany({
      where: {
        OR: [{ status: "QUEUED" }, { status: "LEASED", leaseExpiresAt: { lte: now } }],
      },
      select: LEASE_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
    });

    const leases: OutboxLease[] = [];
    const entries: AuditEntry[] = [];

    // Suppression is re-checked HERE as well as at enqueue, and the second check is the one that
    // matters. An address is suppressed by an administrator at some instant; every reply queued before
    // that instant is still sitting in this table waiting to be handed out, and handing one out is the
    // desk continuing to write to somebody it has just decided to stop writing to. One grouped query
    // for the whole page — the answer is almost always "none".
    const suppressed = await liveSuppressionsFor(tx, candidates.map((c) => c.toAddress));

    for (const row of candidates) {
      const previous: MessageDeliveryStatus = row.status;

      const stop = suppressed.get(row.toAddress.trim().toLowerCase());
      if (stop !== undefined) {
        const halted = await tx.messageDelivery.updateMany({
          where:
            previous === "QUEUED"
              ? { id: row.id, status: "QUEUED" }
              : { id: row.id, status: "LEASED", leaseExpiresAt: { lte: now } },
          data: {
            status: "FAILED_SUPPRESSED",
            lastError: SUPPRESSED_DELIVERY_ERROR,
            leaseExpiresAt: null,
            leasedAt: null,
          },
        });
        if (halted.count === 0) continue;
        entries.push({
          action: "MESSAGE_FAILED",
          entityType: "MESSAGE_DELIVERY",
          entityId: row.id,
          ticketId: row.ticketId,
          fieldChanged: "status",
          oldValue: previous,
          newValue: "FAILED_SUPPRESSED",
          metadata: {
            via: AUDIT_VIA.api,
            attempts: row.attempts,
            terminal: true,
            error: SUPPRESSED_DELIVERY_ERROR,
            suppressed: true,
            suppressionId: stop.id,
            reason: stop.reason,
            ...consumer,
          },
        });
        continue;
      }
      // One conditional guard, used for whichever transition this row gets: the row must still be in
      // the state it was read in, or another poller got there first and this one does nothing.
      const claimWhere: Prisma.MessageDeliveryWhereInput =
        previous === "QUEUED"
          ? { id: row.id, status: "QUEUED" }
          : { id: row.id, status: "LEASED", leaseExpiresAt: { lte: now } };

      // Spent its last attempt and was never reported on: retire it instead of handing it out. A cap
      // that only stops re-leasing would leave the row LEASED forever, which reads as "Sending" on a
      // client-facing surface for a reply that will never be delivered.
      if (row.attempts >= MESSAGE_MAX_ATTEMPTS) {
        const retired = await tx.messageDelivery.updateMany({
          where: claimWhere,
          data: {
            status: "FAILED",
            lastError: LEASE_EXPIRED_AT_CAP_ERROR,
            leaseExpiresAt: null,
            leasedAt: null,
          },
        });
        if (retired.count === 0) continue;
        entries.push({
          action: "MESSAGE_FAILED",
          entityType: "MESSAGE_DELIVERY",
          entityId: row.id,
          ticketId: row.ticketId,
          fieldChanged: "status",
          oldValue: previous,
          // §3: newValue carries the TERMINAL state. The attempts are spent, so this is the end.
          newValue: "FAILED",
          metadata: {
            via: AUDIT_VIA.api,
            attempts: row.attempts,
            terminal: true,
            error: LEASE_EXPIRED_AT_CAP_ERROR,
            // Distinguishes this row from the `MESSAGE_FAILED` a poller reports: no sender said
            // anything, the lease simply ran out with the attempts already spent.
            reclaimed: true,
            // The poller whose sweep retired it. It did not cause the failure, but "who was holding
            // the queue when this message died" is the first question an operator asks.
            ...consumer,
          },
        });
        continue;
      }

      const claimed = await tx.messageDelivery.updateMany({
        where: claimWhere,
        data: {
          status: "LEASED",
          leasedAt: now,
          leaseExpiresAt,
          attempts: { increment: 1 },
        },
      });
      // count 0 = another poller took it between the read and the claim. Skip it; it is not ours.
      if (claimed.count === 0) continue;

      const attempts = row.attempts + 1;
      leases.push({
        id: row.id,
        ticketNumber: row.ticket.number,
        brand: row.brand,
        from: row.fromAddress,
        fromName: row.fromName,
        replyTo: row.replyTo,
        to: row.toAddress,
        subject: row.subject,
        textBody: row.textBody,
        htmlBody: row.htmlBody,
        messageId: row.messageId,
        inReplyTo: row.inReplyTo,
        references: row.references,
        attempts,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      });
      entries.push({
        action: "MESSAGE_LEASED",
        entityType: "MESSAGE_DELIVERY",
        entityId: row.id,
        ticketId: row.ticketId,
        fieldChanged: "status",
        // CONTRACT-GAP: §3 tabulates oldValue as "QUEUED". A reclaimed expired lease was LEASED, and
        // recording the status the row actually held is the honest ledger entry; `reclaimed` says which.
        oldValue: previous,
        newValue: "LEASED",
        metadata: {
          via: AUDIT_VIA.api,
          attempts,
          reclaimed: previous === "LEASED",
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          // WHICH poller holds this lease. Without it a double-send investigation can see that two
          // leases were handed out and not which consumer took either one.
          ...consumer,
        },
      });
    }

    await writeAuditMany(tx, actor, ctx, entries);
    return leases;
  });
}

// ---------------------------------------------------------------------------
// Bounces — a DSN naming one of our own deliveries (CONTRACT §3.2 `MESSAGE_BOUNCED`)
// ---------------------------------------------------------------------------

/** What `recordBounce` did, or null when the DSN named no delivery of ours. */
export type BounceRecord = {
  deliveryId: string;
  ticketId: string;
  /** The address that bounced, lower-cased. What a suppression candidate would be keyed on. */
  toAddress: string;
  bounceType: "hard" | "soft";
  /** True when the row was already BOUNCED — a replayed DSN writes no second ledger row. */
  alreadyBounced: boolean;
  /** True when this is a HARD bounce with no live suppression: an administrator may confirm one. */
  suppressionCandidate: boolean;
};

/** Both spellings of a Message-ID, because `MessageDelivery.messageId` is stored bracketed. */
function messageIdSpellings(bare: string): string[] {
  const id = bare.trim().replace(/^<|>$/g, "");
  return [id, `<${id}>`, id.toLowerCase(), `<${id.toLowerCase()}>`];
}

/**
 * Records that one of our deliveries bounced.
 *
 * Called from the inbound path when `parseDsn` recognised a Delivery Status Notification AND that
 * notification names a Message-ID this desk generated. Returns null — writing nothing — when the id
 * matches no delivery, which is the ordinary outcome for a bounce of somebody else's mail that
 * happened to reach one of our mailboxes.
 *
 * ONE TRANSACTION: the status change, `bouncedAt`, `bounceType` and the `MESSAGE_BOUNCED` row, audit
 * last (§3 rule 2). The transition is a conditional `updateMany` pinned to the status the row was read
 * in, so two deliveries of the same DSN produce one transition and one ledger row.
 *
 * **WHICH PRIOR STATES MAY BOUNCE.** `SENT` is the ordinary one and the one §3.2 tabulates. `LEASED` is
 * accepted too: a DSN that has already come back is proof the send happened, and the poller simply has
 * not reported yet — the later report then gets a `ConflictError` naming BOUNCED, which is the honest
 * answer. Every other state is refused by the pin, silently: a bounce for a message that was never
 * handed out is either a confused MTA or somebody who read our Message-ID off a forwarded copy.
 *
 * **A HARD BOUNCE SUPPRESSES NOTHING**. It sets `suppressionCandidate`, which is what
 * `/admin/suppression` offers an administrator. One DSN is not a policy decision, and an address that
 * stopped being written to without anybody deciding is how a desk stops answering a client and never
 * finds out. The forgery argument runs the same way: anyone holding a copy of one of our replies holds
 * its Message-ID and could post a fabricated DSN at an intake mailbox. The worst that buys them is a
 * "Bounced" chip and a candidate row a human must confirm — which is precisely why the confirmation is
 * not automated away. The audit row records whether the DSN itself passed sender authentication, so the
 * person confirming can see it.
 */
export async function recordBounce(
  actor: AuditActor,
  ctx: RequestContext,
  input: {
    /** OUR Message-ID as the DSN echoed it back, bare or bracketed. */
    originalMessageId: string;
    bounceType: "hard" | "soft";
    /** The RFC 3463 enhanced status code, verbatim. */
    dsnCode: string | null;
    /** Whether the DSN itself passed sender authentication. Recorded, never used as a gate. */
    dsnSenderAuthenticated: boolean;
    /** `AUDIT_VIA` value of the caller. The inbound path is a machine caller (§3 rule 1). */
    via: AuditVia;
  },
): Promise<BounceRecord | null> {
  const spellings = messageIdSpellings(input.originalMessageId);
  if (spellings[0].length === 0) return null;

  return withTx(async (tx) => {
    const row = await tx.messageDelivery.findFirst({
      where: { messageId: { in: spellings } },
      select: { id: true, ticketId: true, toAddress: true, status: true, attempts: true, bounceType: true },
    });
    if (row === null) return null;

    const suppressionCandidateFor = async (type: string | null): Promise<boolean> =>
      type === "hard" && (await findLiveSuppression(tx, row.toAddress)) === null;

    // Replay: the row already carries this verdict. No second transition, no second ledger row.
    if (row.status === "BOUNCED") {
      return {
        deliveryId: row.id,
        ticketId: row.ticketId,
        toAddress: row.toAddress,
        bounceType: (row.bounceType === "hard" ? "hard" : "soft") as "hard" | "soft",
        alreadyBounced: true,
        suppressionCandidate: await suppressionCandidateFor(row.bounceType),
      };
    }

    if (row.status !== "SENT" && row.status !== "LEASED") return null;

    const now = new Date();
    const moved = await tx.messageDelivery.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: "BOUNCED",
        bouncedAt: now,
        bounceType: input.bounceType,
        leaseExpiresAt: null,
        leasedAt: null,
        lastError: input.dsnCode === null ? "bounced" : `bounced (${input.dsnCode})`,
      },
    });
    if (moved.count === 0) return null;

    await writeAuditMany(tx, actor, ctx, [
      {
        action: "MESSAGE_BOUNCED",
        entityType: "MESSAGE_DELIVERY",
        entityId: row.id,
        ticketId: row.ticketId,
        fieldChanged: "status",
        oldValue: row.status,
        newValue: "BOUNCED",
        metadata: {
          via: input.via,
          bounceType: input.bounceType,
          dsnCode: input.dsnCode,
          attempts: row.attempts,
          // Whether the notification itself was authenticated. A DSN is machine mail and frequently
          // arrives with no DMARC verdict at all, so this is evidence for the human who decides
          // whether to suppress — never a gate that would silently drop genuine bounces.
          dsnSenderAuthenticated: input.dsnSenderAuthenticated,
        },
      },
    ]);

    return {
      deliveryId: row.id,
      ticketId: row.ticketId,
      toAddress: row.toAddress,
      bounceType: input.bounceType,
      alreadyBounced: false,
      suppressionCandidate: await suppressionCandidateFor(input.bounceType),
    };
  });
}

// ---------------------------------------------------------------------------
// Report — POST /api/integrations/outbox/[id]
// ---------------------------------------------------------------------------

export type DeliveryOutcomeInput = {
  deliveryId: string;
  outcome: "SENT" | "FAILED";
  providerMessageId?: string;
  error?: string;
  /**
   * WHICH consumer reported this outcome — the id of the `ClientApiToken` the calling route
   * authenticated. Optional; absent (or null) means the shared env bearer, and the rows then carry no
   * `tokenId` key, which is how the ledger says "this sender has not been issued a credential yet".
   * Never affects the actor columns: the report is still `svc_integration`'s row.
   */
  tokenId?: string | null;
};

export type DeliveryOutcomeResult = { status: MessageDeliveryStatus; attempts: number };

/** A failure reason: PII-sanitized and bounded before it reaches an append-only ledger. */
function prepareErrorText(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = sanitizePII(raw).text.trim();
  if (text.length === 0) return null;
  return text.length > DELIVERY_ERROR_MAX_CHARS ? `${text.slice(0, DELIVERY_ERROR_MAX_CHARS - 1)}…` : text;
}

function prepareProviderMessageId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = sanitizePII(raw).text.trim();
  if (text.length === 0) return null;
  return text.slice(0, PROVIDER_MESSAGE_ID_MAX_CHARS);
}

/**
 * Records what the sender did with one leased delivery.
 *
 * SENT is terminal. FAILED below `MESSAGE_MAX_ATTEMPTS` returns the row to QUEUED with its lease
 * cleared, so the next poll retries it; at the cap it stays FAILED, stops being handed out, and shows
 * as Failed on the comment chip until a human writes a new reply (a comment is immutable, so a resend
 * is a new comment and a new delivery). A poller that takes the final attempt and never reports at all
 * reaches the same terminal FAILED state from `leaseQueuedDeliveries`, when its lease expires; a report
 * that arrives after that is answered like any other report against a terminal row — an idempotent
 * FAILED, or a ConflictError for a SENT that contradicts it.
 *
 * Replays are idempotent: reporting the outcome a terminal row already holds returns the current state
 * and writes NO second audit row. Contradicting a terminal row (SENT reported FAILED, or the reverse)
 * is a ConflictError — the ledger is not rewritten to match a confused sender.
 *
 * Only a LEASED row can be reported on. A report against a row no poller holds — QUEUED because it was
 * never handed out, or QUEUED again after an earlier FAILED report — is a ConflictError ("delivery was
 * not leased"), so client mail can never be recorded as delivered without the lease that is the whole
 * evidence of a send attempt.
 */
export async function reportDeliveryOutcome(
  actor: AuditActor,
  ctx: RequestContext,
  input: DeliveryOutcomeInput,
): Promise<DeliveryOutcomeResult> {
  const consumer = input.tokenId === undefined || input.tokenId === null ? {} : { tokenId: input.tokenId };
  return withTx(async (tx) => {
    const row = await tx.messageDelivery.findUnique({
      where: { id: input.deliveryId },
      select: { id: true, ticketId: true, status: true, attempts: true },
    });
    if (!row) throw new NotFoundError("delivery not found");

    // Wave B added three terminal states that no poller ever held a lease on: the desk withdrew the
    // message (CANCELLED), refused to send it (FAILED_SUPPRESSED), or a DSN came back for it after it
    // was sent (BOUNCED). A report against one of them is answered by NAME rather than falling through
    // to "delivery was not leased", which would send an operator looking for a lease that never
    // existed. None of them is re-leasable and none of them is rewritten by a sender's opinion.
    if (row.status === "CANCELLED" || row.status === "FAILED_SUPPRESSED" || row.status === "BOUNCED") {
      throw new ConflictError(`delivery is already ${row.status.toLowerCase().replace(/_/g, " ")}`);
    }

    const terminalFailed = row.status === "FAILED" && row.attempts >= MESSAGE_MAX_ATTEMPTS;

    // Idempotent replay of a terminal outcome: no state change, no second ledger row.
    if (row.status === "SENT" && input.outcome === "SENT") {
      return { status: row.status, attempts: row.attempts };
    }
    if (terminalFailed && input.outcome === "FAILED") {
      return { status: row.status, attempts: row.attempts };
    }
    if (row.status === "SENT" || terminalFailed) {
      throw new ConflictError(`delivery is already ${row.status.toLowerCase()}`);
    }

    // Only a LEASED row can be reported on. `attempts` counting and double-send prevention both rest on
    // the lease, and §3 specifies MESSAGE_SENT as "LEASED" → "SENT": accepting SENT for a row no poller
    // ever held would mark client mail delivered with no evidence it was ever handed out, and would put
    // a prior state in the ledger that the catalog says cannot occur. The terminal cases were answered
    // above, so what reaches here is QUEUED (never leased, or already returned to the queue by an
    // earlier FAILED report) or a non-terminal FAILED row — neither is a lease this caller holds.
    if (row.status !== "LEASED") {
      throw new ConflictError("delivery was not leased");
    }

    const now = new Date();
    const attempts = row.attempts;
    const entries: AuditEntry[] = [];
    let nextStatus: MessageDeliveryStatus;

    if (input.outcome === "SENT") {
      nextStatus = "SENT";
      const providerMessageId = prepareProviderMessageId(input.providerMessageId);
      const updated = await tx.messageDelivery.updateMany({
        // Pinned to LEASED, not to `row.status`: the guard is the lease, so a row another transaction
        // moved between the read and this write loses rather than silently transitioning from whatever
        // state it happens to hold.
        where: { id: row.id, status: "LEASED" },
        data: { status: "SENT", sentAt: now, providerMessageId, lastError: null, leaseExpiresAt: null },
      });
      if (updated.count === 0) throw new ConflictError("delivery changed while the outcome was being recorded");
      entries.push({
        action: "MESSAGE_SENT",
        entityType: "MESSAGE_DELIVERY",
        entityId: row.id,
        ticketId: row.ticketId,
        fieldChanged: "status",
        oldValue: row.status,
        newValue: "SENT",
        metadata: { via: AUDIT_VIA.api, attempts, providerMessageId, ...consumer },
      });
    } else {
      const exhausted = attempts >= MESSAGE_MAX_ATTEMPTS;
      nextStatus = exhausted ? "FAILED" : "QUEUED";
      const lastError = prepareErrorText(input.error);
      const updated = await tx.messageDelivery.updateMany({
        // Same lease pin as the SENT branch above.
        where: { id: row.id, status: "LEASED" },
        data: {
          status: nextStatus,
          lastError,
          // The lease is released either way: a retryable row must be immediately re-leasable, and a
          // terminal row must never look reserved.
          leaseExpiresAt: null,
          leasedAt: null,
        },
      });
      if (updated.count === 0) throw new ConflictError("delivery changed while the outcome was being recorded");
      entries.push({
        action: "MESSAGE_FAILED",
        entityType: "MESSAGE_DELIVERY",
        entityId: row.id,
        ticketId: row.ticketId,
        fieldChanged: "status",
        oldValue: row.status,
        // §3: newValue carries the TERMINAL state — "FAILED" when the attempts are spent, else "QUEUED".
        newValue: nextStatus,
        metadata: { via: AUDIT_VIA.api, attempts, terminal: exhausted, error: lastError, ...consumer },
      });
    }

    await writeAuditMany(tx, actor, ctx, entries);
    return { status: nextStatus, attempts };
  });
}
