/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; `TEST_DATABASE_URL` only — never the dev
 * database: the immutability and no-delete triggers make every fixture row permanent).
 *
 * Proves live what only a real transaction can prove (§10 "S2"):
 *
 *   - an authenticated first contact becomes a ticket with source EMAIL, the mailbox's queue, brand
 *     and default category, its `IngestReceipt` and its `TICKET_INGESTED` row carrying `via: "email"`;
 *   - a replay of the same Message-ID returns the SAME ids and writes nothing — for a ticket, for a
 *     comment, and for a held message;
 *   - threading takes the contract's order: In-Reply-To against a stored `MessageDelivery`, then the
 *     signed reply token, then `[HD-<n>]` — and the subject fallback refuses a sender who is not the
 *     ticket's requester, opening a new ticket instead of joining someone else's conversation;
 *   - the status rules: PENDING_CLIENT → OPEN, RESOLVED → OPEN with `TICKET_REOPENED_BY_REQUESTER`,
 *     CLOSED → a NEW linked ticket with `TICKET_LINKED`;
 *   - **the BEC control**: a message that fails DMARC, or that carries no `Authentication-Results`,
 *     is held as UNAUTHENTICATED even when it carries a valid In-Reply-To for a real thread — no
 *     comment, no reopen, no status change;
 *   - every classifier branch lands in `SuspendedIntake` with its reason and an `INTAKE_SUSPENDED`
 *     row, and nothing suspended ever produces a ticket or a comment;
 *   - PII is redacted before persistence, and email attachment parts land as READY `Attachment` rows
 *     with `ATTACHMENT_ADDED`, under the canonical `<ticketId>/<attachmentId>` object key.
 *
 * `MAILBOX_MAP` and `REPLY_TOKEN_SECRET` are set on `process.env` BEFORE `@/lib/env` is first
 * imported, which is how this file exercises the configured path without mocking the env module out
 * from under `@/lib/db`.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuditActor, RequestContext } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const SERVICE_MAILBOX = "service@example.com";
const OPERATIONS_MAILBOX = "operations@example.com";
const REPLY_SECRET = "integration-reply-token-secret-32-chars-plus";

process.env.REPLY_TOKEN_SECRET = REPLY_SECRET;
process.env.MAILBOX_MAP = JSON.stringify({
  [SERVICE_MAILBOX]: { queueKey: "CLIENT_SERVICE", brand: "CEDAR_RIDGE_WEALTH" },
  [OPERATIONS_MAILBOX]: { queueKey: "OPERATIONS", brand: "CEDAR_RIDGE_WEALTH", category: "ACCOUNT_CLOSURE" },
  "*@example.net": { queueKey: "CLIENT_SERVICE", brand: "CEDAR_RIDGE_DIRECT" },
});

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_email_user_${RUN}`;
const ACTOR: AuditActor = { id: USER_ID, email: `email.intake.${RUN}@wm-helpdesk.local`, groups: [] };
const CTX: RequestContext = {
  ipAddress: "203.0.113.44",
  userAgent: `it-email/${RUN}`,
  requestId: `it-email-${RUN}`,
  isPrefetch: false,
};

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const intakeModule = TEST_URL ? await import("@/server/email-intake") : null;
const tokenModule = TEST_URL ? await import("@/lib/email/reply-token") : null;
const storageModule = TEST_URL ? await import("@/lib/storage") : null;
const fixturesModule = await import("@/lib/email/__fixtures__/inbound-corpus");

function mods() {
  if (!dbModule || !intakeModule || !tokenModule || !storageModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...intakeModule, ...tokenModule, ...storageModule };
}

const { fixture, parseRawMessage } = fixturesModule;

type Prisma = typeof import("@/lib/db").prisma;

const CALL = () => ({ actor: ACTOR, ctx: CTX, via: "email" as const });

/**
 * Builds the n8n payload for a corpus fixture. The Message-ID is scoped to this run so the shared
 * test database — whose rows are permanent by design — cannot make one run's receipts answer
 * another's. Delivered-To is forced to the mailbox under test so the loop check sees what it should.
 */
function payloadFor(
  key: string,
  overrides: {
    mailbox?: string;
    messageId?: string | null;
    headers?: Record<string, string>;
    textBody?: string;
    subject?: string;
    attachments?: unknown[];
  } = {},
) {
  const f = fixture(key);
  const { headers, body } = parseRawMessage(f.raw);
  const mailbox = overrides.mailbox ?? f.mailbox;
  const messageId =
    overrides.messageId === null
      ? undefined
      : (overrides.messageId ??
          `${RUN}.${key}@${((headers["message-id"] ?? "x@y.test").replace(/[<>]/g, "").split("@")[1] ?? "y.test")}`);
  return {
    mailbox,
    messageId,
    from: headers["from"],
    subject: overrides.subject ?? headers["subject"],
    textBody: overrides.textBody ?? (f.htmlBody === undefined ? body : undefined),
    htmlBody: f.htmlBody,
    headers: { ...headers, "delivered-to": mailbox, ...(overrides.headers ?? {}) },
    rawRef: `${f.rawRef}/${RUN}`,
    ...(overrides.attachments === undefined ? {} : { attachments: overrides.attachments }),
  };
}

async function ingest(payload: unknown) {
  const { ingestInboundEmail, parseInboundEmail } = mods();
  return ingestInboundEmail(parseInboundEmail(payload), CALL());
}

async function auditFor(prisma: Prisma, action: string, entityId: string) {
  return prisma.auditLog.findMany({
    where: { action: action as never, entityId },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, entityId: true, ticketId: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

/** A ticket plus one PUBLIC staff comment and its outbound `MessageDelivery`, i.e. a real thread. */
async function seedThread(
  prisma: Prisma,
  opts: {
    id: string;
    queueId: string;
    status: "NEW" | "OPEN" | "PENDING_CLIENT" | "PENDING_INTERNAL" | "RESOLVED" | "CLOSED";
    requesterEmail: string;
    deliveryMessageId?: string;
  },
): Promise<{ ticketId: string; number: number; deliveryMessageId: string | null }> {
  const createdAt = new Date("2026-09-10T12:00:00.000Z");
  const ticket = await prisma.ticket.upsert({
    where: { id: opts.id },
    update: {},
    create: {
      id: opts.id,
      subject: `Email intake thread ${RUN}`,
      description: "Seeded thread for the email intake integration test",
      requesterName: "Marla Whitfield",
      requesterEmail: opts.requesterEmail,
      category: "OTHER",
      priority: "STANDARD",
      status: opts.status,
      brand: "CEDAR_RIDGE_WEALTH",
      source: "EMAIL",
      queue: { connect: { id: opts.queueId } },
      createdBy: { connect: { id: USER_ID } },
      slaFirstResponseMinutes: 240,
      slaResolutionMinutes: 1440,
      firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      ...(opts.status === "RESOLVED" ? { resolvedAt: createdAt } : {}),
      ...(opts.status === "CLOSED" ? { resolvedAt: createdAt, closedAt: createdAt } : {}),
    },
    select: { id: true, number: true },
  });

  if (opts.deliveryMessageId === undefined) {
    return { ticketId: ticket.id, number: ticket.number, deliveryMessageId: null };
  }

  const existing = await prisma.messageDelivery.findUnique({ where: { messageId: opts.deliveryMessageId } });
  if (existing !== null) {
    return { ticketId: ticket.id, number: ticket.number, deliveryMessageId: opts.deliveryMessageId };
  }

  const comment = await prisma.comment.create({
    data: {
      ticketId: ticket.id,
      authorId: USER_ID,
      authorKind: "STAFF",
      visibility: "PUBLIC",
      body: "Seeded outbound reply.\n\n---\nDisclaimer text",
      disclaimerKey: "GENERAL_SERVICE",
    },
    select: { id: true },
  });
  await prisma.messageDelivery.create({
    data: {
      commentId: comment.id,
      ticketId: ticket.id,
      brand: "CEDAR_RIDGE_WEALTH",
      fromAddress: SERVICE_MAILBOX,
      fromName: "Cedar Ridge Wealth Client Service",
      replyTo: SERVICE_MAILBOX,
      toAddress: opts.requesterEmail,
      subject: `[HD-${ticket.number}] Email intake thread`,
      textBody: "Seeded outbound reply.",
      htmlBody: "<p>Seeded outbound reply.</p>",
      messageId: opts.deliveryMessageId,
    },
  });
  return { ticketId: ticket.id, number: ticket.number, deliveryMessageId: opts.deliveryMessageId };
}

describe.skipIf(!TEST_URL)("inbound email intake (TEST_DATABASE_URL)", () => {
  let clientServiceQueueId = "";
  let operationsQueueId = "";

  beforeAll(async () => {
    const { prisma } = mods();
    for (const [key, name, sortOrder] of [
      ["CLIENT_SERVICE", "Client Service", 2],
      ["OPERATIONS", "Operations", 1],
    ] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name, description: "email intake fixture", sortOrder },
      });
    }
    clientServiceQueueId = (await prisma.queue.findUniqueOrThrow({ where: { key: "CLIENT_SERVICE" } })).id;
    operationsQueueId = (await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } })).id;
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, email: ACTOR.email, name: "Email Intake Machine", groups: [], isActive: true },
    });
  });

  // -------------------------------------------------------------------------
  // New threads
  // -------------------------------------------------------------------------

  it("turns an authenticated first contact into a ticket with the mailbox's queue and brand", async () => {
    const { prisma } = mods();
    const payload = payloadFor("new-thread-plain");
    const result = await ingest(payload);

    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(ticket.source).toBe("EMAIL");
    expect(ticket.externalId).toBe(payload.messageId);
    expect(ticket.brand).toBe("CEDAR_RIDGE_WEALTH");
    expect(ticket.queueId).toBe(clientServiceQueueId);
    expect(ticket.requesterEmail).toBe("marla.whitfield@fastmail.test");
    expect(ticket.requesterName).toBe("Marla Whitfield");
    expect(ticket.subject).toBe("Statement request for the joint account");
    expect(ticket.description).toContain("Could you send me the August statement for our joint account");
    expect(ticket.status).toBe("NEW");

    const receipt = await prisma.ingestReceipt.findUniqueOrThrow({
      where: { source_externalId: { source: "EMAIL", externalId: payload.messageId as string } },
    });
    expect(receipt.ticketId).toBe(result.ticketId);
    expect(receipt.outcome).toBe("ticket");

    const ingested = await auditFor(prisma, "TICKET_INGESTED", result.ticketId);
    expect(ingested).toHaveLength(1);
    expect(ingested[0].entityType).toBe("TICKET");
    expect(ingested[0].ticketId).toBe(result.ticketId);
    expect((ingested[0].metadata as Record<string, unknown>).via).toBe("email");
    expect((ingested[0].metadata as Record<string, unknown>).source).toBe("EMAIL");
  });

  it("is idempotent on the Message-ID: a replay returns the same ticket and creates nothing", async () => {
    const { prisma } = mods();
    const payload = payloadFor("new-thread-plain", { messageId: `${RUN}.replay@fastmail.test` });

    const first = await ingest(payload);
    const before = await prisma.ticket.count({ where: { source: "EMAIL", externalId: payload.messageId } });
    const second = await ingest(payload);
    const after = await prisma.ticket.count({ where: { source: "EMAIL", externalId: payload.messageId } });

    expect(first).toEqual(second);
    expect(before).toBe(1);
    expect(after).toBe(1);
  });

  it("converts an HTML-only message and applies the mailbox's default category", async () => {
    const { prisma } = mods();
    const result = await ingest(payloadFor("new-thread-html"));
    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(ticket.queueId).toBe(operationsQueueId);
    expect(ticket.category).toBe("ACCOUNT_CLOSURE");
    expect(ticket.description).toContain("ACAT full | Move everything");
    expect(ticket.description).toContain("https://example.com/forms/transfers");
    expect(ticket.description).not.toContain("<p>");
  });

  it("redacts PII out of the body before it is persisted, and records the redaction", async () => {
    const { prisma } = mods();
    const result = await ingest(payloadFor("pii-in-body"));
    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(ticket.description).not.toContain("345-67-8901");
    expect(ticket.description).not.toContain("4471209983");
    // The routing number on the next line survives — and this fixture is the
    // end-to-end proof that it survives on a row whose ACCOUNT number did not, which is the whole
    // basis for withdrawing the rule: the routing+account pair is still broken.
    expect(ticket.description).toContain("Routing 021000021");
    expect(ticket.description).toContain("[REDACTED:ACCOUNT ****9983]");
    expect(ticket.description).toContain("Please set up the monthly distribution.");
    expect(ticket.piiRedacted).toBe(true);
    expect(ticket.piiRedactionCount).toBeGreaterThan(0);

    const redactions = await auditFor(prisma, "PII_REDACTED", result.ticketId);
    expect(redactions.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Threading
  // -------------------------------------------------------------------------

  it("threads a reply by In-Reply-To, strips the quoted history and moves PENDING_CLIENT to OPEN", async () => {
    const { prisma } = mods();
    const deliveryMessageId = `wm.${RUN}.pending@example.com`;
    const thread = await seedThread(prisma, {
      id: `it_email_pending_${RUN}`,
      queueId: clientServiceQueueId,
      status: "PENDING_CLIENT",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });

    const result = await ingest(
      payloadFor("reply-message-id", {
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: `<${deliveryMessageId}>` },
      }),
    );

    expect(result.outcome).toBe("comment");
    if (result.outcome !== "comment") return;
    expect(result.ticketId).toBe(thread.ticketId);
    expect(result.reopened).toBe(true);

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: result.commentId } });
    expect(comment.authorKind).toBe("REQUESTER");
    expect(comment.authorId).toBeNull();
    expect(comment.visibility).toBe("PUBLIC");
    expect(comment.disclaimerKey).toBe("NONE");
    expect(comment.body).toContain("can you also send July again?");
    expect(comment.body).not.toContain("The August statement is attached.");

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: thread.ticketId } });
    expect(ticket.status).toBe("OPEN");
    expect(ticket.firstRespondedAt).toBeNull();

    const added = await auditFor(prisma, "COMMENT_ADDED_REQUESTER", result.commentId);
    expect(added).toHaveLength(1);
    const addedMeta = added[0].metadata as Record<string, unknown>;
    expect(addedMeta.via).toBe("email");
    // The actor on this row is the machine identity, so the sending mailbox is the only thing on the
    // record that says where the client's words came in from. §10.1's identity gate guarantees it
    // equals the ticket's requesterEmail — asserted here so the two cannot drift apart.
    expect(addedMeta.senderAddress).toBe("marla.whitfield@fastmail.test");
  });

  it("threads a reply by the signed reply token on the envelope recipient", async () => {
    const { formatReplyToken, prisma } = mods();
    const thread = await seedThread(prisma, {
      id: `it_email_token_${RUN}`,
      queueId: clientServiceQueueId,
      status: "OPEN",
      requesterEmail: "priya.raghavan@lpl.test",
    });
    const token = formatReplyToken(thread.ticketId, REPLY_SECRET);
    expect(token).not.toBeNull();

    const result = await ingest(
      payloadFor("reply-token-only", {
        mailbox: `service+${token}@example.com`,
        headers: { "in-reply-to": "", references: "" },
      }),
    );

    expect(result.outcome).toBe("comment");
    if (result.outcome !== "comment") return;
    expect(result.ticketId).toBe(thread.ticketId);

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: result.commentId } });
    expect(comment.body).toContain("go ahead with the beneficiary update");
    expect(comment.body).not.toContain("Sent from my iPhone");
  });

  it("refuses a token signed with a different secret and opens a new thread instead", async () => {
    const { formatReplyToken, prisma } = mods();
    const thread = await seedThread(prisma, {
      id: `it_email_badtoken_${RUN}`,
      queueId: clientServiceQueueId,
      status: "OPEN",
      requesterEmail: "priya.raghavan@lpl.test",
    });
    const forged = formatReplyToken(thread.ticketId, "a-completely-different-secret-value-here");

    const result = await ingest(
      payloadFor("reply-token-only", {
        mailbox: `service+${forged}@example.com`,
        messageId: `${RUN}.forged@lpl.test`,
        headers: { "in-reply-to": "", references: "" },
      }),
    );

    expect(result.outcome).toBe("ticket");
    const comments = await prisma.comment.count({ where: { ticketId: thread.ticketId, authorKind: "REQUESTER" } });
    expect(comments).toBe(0);
  });

  it("uses the [HD-n] subject fallback only when the sender IS the requester", async () => {
    const { prisma } = mods();
    const thread = await seedThread(prisma, {
      id: `it_email_subject_${RUN}`,
      queueId: clientServiceQueueId,
      status: "OPEN",
      requesterEmail: "marla.whitfield@fastmail.test",
    });

    const matched = await ingest(
      payloadFor("reply-subject-fallback", { subject: `RE: [HD-${thread.number}] Statement request` }),
    );
    expect(matched.outcome).toBe("comment");
    if (matched.outcome === "comment") expect(matched.ticketId).toBe(thread.ticketId);

    const stranger = await ingest(
      payloadFor("reply-subject-fallback-stranger", { subject: `Re: [HD-${thread.number}] Statement request` }),
    );
    expect(stranger.outcome).toBe("ticket");
    if (stranger.outcome === "ticket") expect(stranger.ticketId).not.toBe(thread.ticketId);

    const requesterComments = await prisma.comment.count({
      where: { ticketId: thread.ticketId, authorKind: "REQUESTER" },
    });
    expect(requesterComments).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Status rules
  // -------------------------------------------------------------------------

  it("reopens a RESOLVED ticket and records TICKET_REOPENED_BY_REQUESTER", async () => {
    const { prisma } = mods();
    const deliveryMessageId = `wm.${RUN}.resolved@example.com`;
    const thread = await seedThread(prisma, {
      id: `it_email_resolved_${RUN}`,
      queueId: clientServiceQueueId,
      status: "RESOLVED",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });

    const result = await ingest(
      payloadFor("reply-message-id", {
        messageId: `${RUN}.resolved-reply@fastmail.test`,
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: "" },
      }),
    );

    expect(result.outcome).toBe("comment");
    if (result.outcome !== "comment") return;
    expect(result.reopened).toBe(true);

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: thread.ticketId } });
    expect(ticket.status).toBe("OPEN");

    const reopened = await auditFor(prisma, "TICKET_REOPENED_BY_REQUESTER", thread.ticketId);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].oldValue).toBe("RESOLVED");
    expect(reopened[0].newValue).toBe("OPEN");
  });

  it("opens a NEW linked ticket when the reply lands on a CLOSED one, and never reopens it", async () => {
    const { prisma } = mods();
    const deliveryMessageId = `wm.${RUN}.closed@example.com`;
    const thread = await seedThread(prisma, {
      id: `it_email_closed_${RUN}`,
      queueId: clientServiceQueueId,
      status: "CLOSED",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });

    const result = await ingest(
      payloadFor("closed-ticket-followup", {
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: "" },
      }),
    );

    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;
    expect(result.ticketId).not.toBe(thread.ticketId);

    const followUp = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(followUp.linkedFromTicketId).toBe(thread.ticketId);
    expect(followUp.source).toBe("EMAIL");

    const closed = await prisma.ticket.findUniqueOrThrow({ where: { id: thread.ticketId } });
    expect(closed.status).toBe("CLOSED");
    expect(await prisma.comment.count({ where: { ticketId: thread.ticketId, authorKind: "REQUESTER" } })).toBe(0);

    const linked = await auditFor(prisma, "TICKET_LINKED", result.ticketId);
    expect(linked).toHaveLength(1);
    expect(linked[0].newValue).toBe(thread.ticketId);
  });

  // -------------------------------------------------------------------------
  // Sender authentication — the BEC control
  // -------------------------------------------------------------------------

  it("holds a DMARC failure as UNAUTHENTICATED and writes INTAKE_SUSPENDED", async () => {
    const { prisma } = mods();
    const payload = payloadFor("unauthenticated-dmarc-fail");
    const result = await ingest(payload);

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("UNAUTHENTICATED");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(row.status).toBe("NEW");
    expect(row.mailbox).toBe(SERVICE_MAILBOX);
    expect(row.fromAddress).toBe("marla.whitfield@fastmail.test");
    expect(row.ticketId).toBeNull();
    expect(row.snippet).not.toBeNull();
    expect((row.snippet ?? "").length).toBeLessThanOrEqual(2_000);
    expect(row.headers).not.toBeNull();

    expect(await prisma.ticket.count({ where: { source: "EMAIL", externalId: payload.messageId } })).toBe(0);
    expect(await prisma.ingestReceipt.count({ where: { source: "EMAIL", externalId: payload.messageId } })).toBe(0);

    const suspended = await auditFor(prisma, "INTAKE_SUSPENDED", result.suspendedId);
    expect(suspended).toHaveLength(1);
    expect(suspended[0].entityType).toBe("SUSPENDED_INTAKE");
    expect(suspended[0].fieldChanged).toBe("reason");
    expect(suspended[0].newValue).toBe("UNAUTHENTICATED");
    expect((suspended[0].metadata as Record<string, unknown>).via).toBe("email");
  });

  it("holds an unauthenticated message EVEN WHEN it carries a valid In-Reply-To for a real thread", async () => {
    const { prisma } = mods();
    const deliveryMessageId = `wm.${RUN}.bec@example.com`;
    const thread = await seedThread(prisma, {
      id: `it_email_bec_${RUN}`,
      queueId: clientServiceQueueId,
      status: "PENDING_CLIENT",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });

    const result = await ingest(
      payloadFor("unauthenticated-dmarc-fail", {
        messageId: `${RUN}.bec-spoof@driftwood.test`,
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: `<${deliveryMessageId}>` },
      }),
    );

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("UNAUTHENTICATED");

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: thread.ticketId } });
    expect(ticket.status).toBe("PENDING_CLIENT");
    expect(await prisma.comment.count({ where: { ticketId: thread.ticketId, authorKind: "REQUESTER" } })).toBe(0);
  });

  it("holds a message with no Authentication-Results at all", async () => {
    const result = await ingest(payloadFor("unauthenticated-no-header"));
    expect(result.outcome).toBe("suspended");
    if (result.outcome === "suspended") expect(result.reason).toBe("UNAUTHENTICATED");
  });

  // -------------------------------------------------------------------------
  // Classifier branches
  // -------------------------------------------------------------------------

  it.each([
    ["auto-reply-out-of-office", "AUTO_REPLY"],
    ["bounce-dsn", "BOUNCE"],
    ["system-sender-noreply", "SYSTEM_SENDER"],
    ["spam-flagged", "SPAM"],
    ["loop-delivered-to-self", "LOOP_DETECTED"],
    ["unknown-mailbox", "UNKNOWN_MAILBOX"],
    ["empty-body", "PARSE_FAILED"],
  ] as const)("holds %s as %s and creates no ticket or comment", async (key, reason) => {
    const { prisma } = mods();
    const payload = payloadFor(key);
    const result = await ingest(payload);

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe(reason);
    expect(await prisma.ticket.count({ where: { source: "EMAIL", externalId: payload.messageId } })).toBe(0);
    expect(await prisma.ingestReceipt.count({ where: { source: "EMAIL", externalId: payload.messageId } })).toBe(0);

    const suspended = await auditFor(prisma, "INTAKE_SUSPENDED", result.suspendedId);
    expect(suspended).toHaveLength(1);
    expect(suspended[0].newValue).toBe(reason);
  });

  it("holds a body past the hard ceiling as OVERSIZE rather than truncating it", async () => {
    const { INBOUND_BODY_HARD_LIMIT_CHARS } = mods();
    const result = await ingest(
      payloadFor("new-thread-plain", {
        messageId: `${RUN}.oversize@fastmail.test`,
        textBody: "x".repeat(INBOUND_BODY_HARD_LIMIT_CHARS + 1),
      }),
    );
    expect(result.outcome).toBe("suspended");
    if (result.outcome === "suspended") expect(result.reason).toBe("OVERSIZE");
  });

  it("truncates an ordinary long body with the contract's note instead of holding it", async () => {
    const { prisma } = mods();
    const result = await ingest(
      payloadFor("new-thread-plain", {
        messageId: `${RUN}.longbody@fastmail.test`,
        textBody: "y".repeat(25_000),
      }),
    );
    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(ticket.description).toContain("[Message truncated by the help desk");
  });

  it("is idempotent for a held message: a replay returns the same SuspendedIntake row", async () => {
    const { prisma } = mods();
    const payload = payloadFor("spam-flagged", { messageId: `${RUN}.spam-replay@win-big-today.test` });

    const first = await ingest(payload);
    const second = await ingest(payload);
    expect(first).toEqual(second);

    const rows = await prisma.suspendedIntake.count({ where: { messageId: payload.messageId } });
    expect(rows).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  it("stores an allowed attachment part as a READY row under the canonical object key", async () => {
    const { attachmentObjectKey, objectStore, prisma } = mods();
    const bytes = Buffer.from("%PDF-1.4\n% integration fixture\n", "utf8");
    const result = await ingest(
      payloadFor("attachment-bearing", {
        attachments: [
          { filename: "../../beneficiary form.pdf", mime: "application/pdf", size: bytes.length, contentBase64: bytes.toString("base64") },
          { filename: "payload.exe", mime: "application/x-msdownload", contentBase64: "AAAA" },
        ],
      }),
    );

    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;

    const attachments = await prisma.attachment.findMany({ where: { ticketId: result.ticketId } });
    expect(attachments).toHaveLength(1);
    const [row] = attachments;
    expect(row.state).toBe("READY");
    expect(row.kind).toBe("EMAIL_PART");
    expect(row.uploaderId).toBeNull();
    expect(row.mime).toBe("application/pdf");
    expect(row.size).toBe(bytes.length);
    expect(row.filename).not.toContain("/");
    expect(row.objectKey).toBe(attachmentObjectKey(result.ticketId, row.id));

    const head = await objectStore(undefined).head(row.objectKey);
    expect(head.exists).toBe(true);
    expect(head.size).toBe(bytes.length);

    // TWO rows, same shape as `createUploadIntent` → `finalizeUpload`: the reservation is audited when
    // the permanent (undeletable) row is created, and the attachment itself when the bytes land. A
    // PENDING row left behind by a failed object write is therefore explained by the ledger rather than
    // being an unattributable row in a books-and-records table.
    const added = await auditFor(prisma, "ATTACHMENT_ADDED", row.id);
    expect(added).toHaveLength(2);
    const byStage = new Map(added.map((a) => [(a.metadata as Record<string, unknown>).stage, a]));
    const intent = byStage.get("intent");
    const ready = byStage.get("ready");
    expect(intent).toBeDefined();
    expect(ready).toBeDefined();
    expect(intent?.oldValue).toBeNull();
    expect(intent?.newValue).toBe("PENDING");
    expect(ready?.oldValue).toBe("PENDING");
    expect(ready?.newValue).toBe("READY");
    expect(ready?.ticketId).toBe(result.ticketId);
    expect((ready?.metadata as Record<string, unknown>).via).toBe("email");
    expect((intent?.metadata as Record<string, unknown>).via).toBe("email");
  });

  // -------------------------------------------------------------------------
  // Sender identity on EVERY matcher (security fix, 2026-09-19)
  // -------------------------------------------------------------------------

  it("holds a Message-ID match whose sender is NOT the ticket's requester, and leaves the ticket alone", async () => {
    const { prisma } = mods();
    const deliveryMessageId = `wm.${RUN}.forwarded@example.com`;
    const thread = await seedThread(prisma, {
      id: `it_email_fwd_mid_${RUN}`,
      queueId: clientServiceQueueId,
      status: "PENDING_CLIENT",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });

    // The realistic path: Marla forwards our reply to her accountant, who replies to it. The
    // accountant's message carries our Message-ID in References and passes DMARC for their own domain.
    const result = await ingest(
      payloadFor("reply-subject-fallback-stranger", {
        messageId: `${RUN}.accountant-reply@driftwood.test`,
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: `<${deliveryMessageId}>` },
      }),
    );

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("UNAUTHENTICATED");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(row.fromAddress).toBe("colin.mabry@driftwood.test");

    const suspended = await auditFor(prisma, "INTAKE_SUSPENDED", result.suspendedId);
    expect(suspended).toHaveLength(1);
    expect((suspended[0].metadata as Record<string, unknown>).detail).toBe("SENDER_MISMATCH");

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: thread.ticketId } });
    expect(ticket.status).toBe("PENDING_CLIENT");
    expect(await prisma.comment.count({ where: { ticketId: thread.ticketId, authorKind: "REQUESTER" } })).toBe(0);
    // And it did NOT quietly become a new ticket either: a third party's words are a human's call.
    expect(
      await prisma.ticket.count({ where: { source: "EMAIL", externalId: `${RUN}.accountant-reply@driftwood.test` } }),
    ).toBe(0);
  });

  it("holds a reply-token match from a Cc'd third party and never reopens the RESOLVED ticket", async () => {
    const { formatReplyToken, prisma } = mods();
    const thread = await seedThread(prisma, {
      id: `it_email_fwd_token_${RUN}`,
      queueId: clientServiceQueueId,
      status: "RESOLVED",
      requesterEmail: "marla.whitfield@fastmail.test",
    });
    const token = formatReplyToken(thread.ticketId, REPLY_SECRET);

    const result = await ingest(
      payloadFor("reply-subject-fallback-stranger", {
        mailbox: `service+${token}@example.com`,
        messageId: `${RUN}.cc-party-reply@driftwood.test`,
        headers: { "in-reply-to": "", references: "" },
      }),
    );

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("UNAUTHENTICATED");

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: thread.ticketId } });
    expect(ticket.status).toBe("RESOLVED");
    expect(await auditFor(prisma, "TICKET_REOPENED_BY_REQUESTER", thread.ticketId)).toHaveLength(0);
    expect(await prisma.comment.count({ where: { ticketId: thread.ticketId, authorKind: "REQUESTER" } })).toBe(0);
  });

  it("still threads the requester's own reply after the identity gate (the gate is not a wall)", async () => {
    const { prisma } = mods();
    const deliveryMessageId = `wm.${RUN}.gate-ok@example.com`;
    const thread = await seedThread(prisma, {
      id: `it_email_gate_ok_${RUN}`,
      queueId: clientServiceQueueId,
      status: "OPEN",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });

    const result = await ingest(
      payloadFor("reply-message-id", {
        messageId: `${RUN}.gate-ok-reply@fastmail.test`,
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: "" },
      }),
    );

    expect(result.outcome).toBe("comment");
    if (result.outcome !== "comment") return;
    expect(result.ticketId).toBe(thread.ticketId);
  });

  // -------------------------------------------------------------------------
  // The replay shortcut sits BEHIND the gates (security fix round 2, 2026-09-19)
  // -------------------------------------------------------------------------

  it("does not answer a DMARC failure out of an earlier receipt — it holds it and writes the ledger row", async () => {
    const { prisma } = mods();
    const messageId = `${RUN}.receipt-then-spoof@fastmail.test`;

    const first = await ingest(payloadFor("new-thread-plain", { messageId }));
    expect(first.outcome).toBe("ticket");
    if (first.outcome !== "ticket") return;

    // The SAME Message-ID, now on a message that fails DMARC. A Message-ID is not a secret: it rides
    // in the References of every reply and in every forwarded or Cc'd copy of the thread. While the
    // replay lookup ran FIRST, this call was answered with `first` verbatim — no SuspendedIntake row,
    // no INTAKE_SUSPENDED row, nothing on /admin/intake: the one intake outcome that left no evidence.
    const second = await ingest(payloadFor("unauthenticated-dmarc-fail", { messageId }));
    expect(second.outcome).toBe("suspended");
    if (second.outcome !== "suspended") return;
    expect(second.reason).toBe("UNAUTHENTICATED");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: second.suspendedId } });
    expect(row.messageId).toBe(messageId);
    expect(row.status).toBe("NEW");
    expect(await auditFor(prisma, "INTAKE_SUSPENDED", second.suspendedId)).toHaveLength(1);

    // The refusal wrote its own row and touched nothing else: one ticket, no comment, no reopen.
    expect(await prisma.ticket.count({ where: { source: "EMAIL", externalId: messageId } })).toBe(1);
    expect(await prisma.comment.count({ where: { ticketId: first.ticketId, authorKind: "REQUESTER" } })).toBe(0);
  });

  it("holds an authenticated stranger who replays a receipt's Message-ID instead of handing back the client's ticket", async () => {
    const { prisma } = mods();
    const messageId = `${RUN}.receipt-then-stranger@fastmail.test`;

    const first = await ingest(payloadFor("new-thread-plain", { messageId }));
    expect(first.outcome).toBe("ticket");
    if (first.outcome !== "ticket") return;

    // DMARC proves the accountant is the accountant; it does not make them this client. A receipt hit
    // is only a retry when the sender is the ticket's own requester.
    const second = await ingest(
      payloadFor("reply-subject-fallback-stranger", {
        messageId,
        headers: { "in-reply-to": "", references: "" },
      }),
    );
    expect(second.outcome).toBe("suspended");
    if (second.outcome !== "suspended") return;
    expect(second.reason).toBe("UNAUTHENTICATED");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: second.suspendedId } });
    expect(row.fromAddress).toBe("colin.mabry@driftwood.test");

    const suspended = await auditFor(prisma, "INTAKE_SUSPENDED", second.suspendedId);
    expect(suspended).toHaveLength(1);
    expect((suspended[0].metadata as Record<string, unknown>).detail).toBe("SENDER_MISMATCH");

    expect(await prisma.ticket.count({ where: { source: "EMAIL", externalId: messageId } })).toBe(1);
    expect(await prisma.comment.count({ where: { ticketId: first.ticketId, authorKind: "REQUESTER" } })).toBe(0);
  });

  it("still writes exactly one row when an UNKNOWN_MAILBOX message is delivered twice", async () => {
    const { prisma } = mods();
    const payload = payloadFor("unknown-mailbox", { messageId: `${RUN}.unknown-replay@driftwood.test` });

    const first = await ingest(payload);
    const second = await ingest(payload);

    // The held-mail dedupe moved out of the top of `ingestInboundEmail` and into `hold()`, which is
    // the only place gates 1 and 2 can reach. Exactly-once per Message-ID has to survive that move.
    expect(first).toEqual(second);
    expect(first.outcome).toBe("suspended");
    if (first.outcome === "suspended") expect(first.reason).toBe("UNKNOWN_MAILBOX");
    expect(await prisma.suspendedIntake.count({ where: { messageId: payload.messageId } })).toBe(1);
    const audits = await prisma.auditLog.count({
      where: { action: "INTAKE_SUSPENDED", entityId: first.outcome === "suspended" ? first.suspendedId : "" },
    });
    expect(audits).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Hold-reason precedence: the verdict travels beside the reason
  // -------------------------------------------------------------------------

  it("records senderVerified:false on a hold whose winning reason is UNKNOWN_MAILBOX", async () => {
    const { prisma } = mods();
    // The gates are ordered — mailbox first, authentication second — so this message is held as
    // UNKNOWN_MAILBOX and its reason says nothing at all about its sender. Before the verdict was
    // carried, the review card showed the benign "not in the mailbox map" banner and no caution,
    // and releasing the row adopted an unproven address with nothing recorded about it.
    const result = await ingest(
      payloadFor("unknown-mailbox", {
        messageId: `${RUN}.unknown-unauth@applicants.test`,
        headers: {
          "authentication-results":
            "mx.google.com; spf=fail smtp.mailfrom=sana.iqbal@applicants.test; dkim=fail; dmarc=fail header.from=applicants.test",
        },
      }),
    );

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("UNKNOWN_MAILBOX");

    const suspended = await auditFor(prisma, "INTAKE_SUSPENDED", result.suspendedId);
    expect(suspended).toHaveLength(1);
    const metadata = suspended[0].metadata as Record<string, unknown>;
    expect(metadata.senderVerified).toBe(false);
    // `detail` is untouched: it carries SENDER_MISMATCH and nothing else, and the two facts are
    // orthogonal — a SENDER_MISMATCH hold PASSED authentication.
    expect(metadata.detail).toBeNull();
  });

  it("records senderVerified:true when the same unmapped mailbox receives an authenticated message", async () => {
    const { prisma } = mods();
    const result = await ingest(
      payloadFor("unknown-mailbox", { messageId: `${RUN}.unknown-authed@applicants.test` }),
    );

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("UNKNOWN_MAILBOX");

    const suspended = await auditFor(prisma, "INTAKE_SUSPENDED", result.suspendedId);
    expect((suspended[0].metadata as Record<string, unknown>).senderVerified).toBe(true);
  });

  it("records senderVerified:false on the UNAUTHENTICATED hold itself, and true on a SENDER_MISMATCH one", async () => {
    const { prisma } = mods();

    const failed = await ingest(
      payloadFor("unauthenticated-no-header", { messageId: `${RUN}.verdict-noheader@fastmail.test` }),
    );
    expect(failed.outcome).toBe("suspended");
    if (failed.outcome !== "suspended") return;
    expect(failed.reason).toBe("UNAUTHENTICATED");
    const failedAudit = await auditFor(prisma, "INTAKE_SUSPENDED", failed.suspendedId);
    expect((failedAudit[0].metadata as Record<string, unknown>).senderVerified).toBe(false);

    // A third party on a forwarded thread DID pass DMARC for their own domain — authentication is
    // not the thing that is wrong with them. The verdict says so, and `heldIntakeSenderVerified`
    // keeps the row unverified anyway on the strength of its reason.
    const deliveryMessageId = `wm.${RUN}.verdict-mismatch@example.com`;
    await seedThread(prisma, {
      id: `it_email_verdict_mismatch_${RUN}`,
      queueId: clientServiceQueueId,
      status: "PENDING_CLIENT",
      requesterEmail: "marla.whitfield@fastmail.test",
      deliveryMessageId,
    });
    const mismatch = await ingest(
      payloadFor("reply-subject-fallback-stranger", {
        messageId: `${RUN}.verdict-mismatch-reply@driftwood.test`,
        headers: { "in-reply-to": `<${deliveryMessageId}>`, references: `<${deliveryMessageId}>` },
      }),
    );
    expect(mismatch.outcome).toBe("suspended");
    if (mismatch.outcome !== "suspended") return;
    const mismatchAudit = await auditFor(prisma, "INTAKE_SUSPENDED", mismatch.suspendedId);
    const mismatchMetadata = mismatchAudit[0].metadata as Record<string, unknown>;
    expect(mismatchMetadata.detail).toBe("SENDER_MISMATCH");
    expect(mismatchMetadata.senderVerified).toBe(true);
  });

  it("stores the two caller-supplied pointers sanitised, and still recognises the replay", async () => {
    const { prisma } = mods();
    const payload = {
      ...payloadFor("spam-flagged", { messageId: `${RUN}.pointer-sanitise@win-big-today.test` }),
      rawRef: `n8n/exec/${RUN}/acct 4021 7788 3310`,
    };

    const first = await ingest(payload);
    expect(first.outcome).toBe("suspended");
    if (first.outcome !== "suspended") return;

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: first.suspendedId } });
    expect(row.rawRef).toBe(`n8n/exec/${RUN}/acct [REDACTED:ACCOUNT ****3310]`);
    expect(row.rawRef).not.toContain("4021 7788 3310");
    // An ordinary Message-ID is not a redaction target, so it is stored byte for byte — which is what
    // the dedupe read matches on.
    expect(row.messageId).toBe(payload.messageId);

    const second = await ingest(payload);
    expect(second).toEqual(first);
    expect(await prisma.suspendedIntake.count({ where: { messageId: payload.messageId } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Attachment staging namespace (security fix, 2026-09-19)
  // -------------------------------------------------------------------------

  it("copies a STAGED inbound object and records the source key on the ATTACHMENT_ADDED row", async () => {
    const { attachmentObjectKey, objectStore, prisma } = mods();
    const store = objectStore(undefined);
    const stagedKey = `inbound/staged_${RUN}`;
    const bytes = Buffer.from("%PDF-1.4\n% staged inbound fixture\n", "utf8");
    await store.put(stagedKey, bytes, "application/pdf");

    const result = await ingest(
      payloadFor("attachment-bearing", {
        messageId: `${RUN}.staged-attachment@lpl.test`,
        attachments: [{ filename: "statement.pdf", mime: "application/pdf", objectRef: stagedKey }],
      }),
    );

    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;

    const rows = await prisma.attachment.findMany({ where: { ticketId: result.ticketId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("READY");
    expect(rows[0].objectKey).toBe(attachmentObjectKey(result.ticketId, rows[0].id));
    expect(rows[0].size).toBe(bytes.length);

    // Both stages carry the staging key the bytes were copied from, so provenance survives even if the
    // object write never completed and the row stayed PENDING.
    const added = await auditFor(prisma, "ATTACHMENT_ADDED", rows[0].id);
    expect(added).toHaveLength(2);
    for (const row of added) {
      expect((row.metadata as Record<string, unknown>).sourceObjectRef).toBe(stagedKey);
    }
  });

  it("refuses an objectRef that names another ticket's attachment, and copies nothing", async () => {
    const { objectStore, persistAttachmentParts, prisma } = mods();
    const store = objectStore(undefined);

    // A real attachment on a "victim" ticket, exactly as the upload path would leave it.
    const victim = await ingest(payloadFor("new-thread-plain", { messageId: `${RUN}.victim-ticket@fastmail.test` }));
    expect(victim.outcome).toBe("ticket");
    if (victim.outcome !== "ticket") return;
    const victimAttachmentId = `vict${RUN.replaceAll("-", "")}att`;
    const victimKey = `${victim.ticketId}/${victimAttachmentId}`;
    await store.put(victimKey, Buffer.from("VOIDED CHECK IMAGE", "utf8"), "application/pdf");
    await prisma.attachment.create({
      data: {
        id: victimAttachmentId,
        ticketId: victim.ticketId,
        uploaderId: USER_ID,
        kind: "UPLOAD",
        filename: "voided-check.pdf",
        mime: "application/pdf",
        size: 18,
        objectKey: victimKey,
        state: "READY",
        readyAt: new Date(),
      },
    });

    const attacker = await ingest(payloadFor("new-thread-html", { messageId: `${RUN}.attacker-ticket@brightline.test` }));
    expect(attacker.outcome).toBe("ticket");
    if (attacker.outcome !== "ticket") return;

    // The schema refuses this key at the edge; call the writer directly to prove the second gate too.
    const summary = await persistAttachmentParts(
      [{ filename: "harvest.pdf", mime: "application/pdf", objectRef: victimKey }] as never,
      { ticketId: attacker.ticketId, commentId: null },
      CALL(),
      store,
    );

    expect(summary.stored).toBe(0);
    expect(await prisma.attachment.count({ where: { ticketId: attacker.ticketId } })).toBe(0);
  });

  it("leaves NO Attachment row at all when a staged object cannot be fetched", async () => {
    const { prisma } = mods();
    const result = await ingest(
      payloadFor("attachment-bearing", {
        messageId: `${RUN}.missing-staged@lpl.test`,
        attachments: [{ filename: "gone.pdf", mime: "application/pdf", objectRef: `inbound/missing_${RUN}` }],
      }),
    );

    expect(result.outcome).toBe("ticket");
    if (result.outcome !== "ticket") return;
    // The old order wrote a PENDING row first and could never take it back: the table forbids deletes.
    expect(await prisma.attachment.count({ where: { ticketId: result.ticketId } })).toBe(0);
  });
});
