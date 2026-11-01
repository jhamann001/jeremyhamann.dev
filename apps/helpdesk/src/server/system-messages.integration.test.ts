/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database. The shared test database is permanent and files run concurrently, so EVERY
 * assertion below is scoped to rows this run created, by a per-run marker in every id.
 *
 * Proves live, for the two SYSTEM messages:
 *   - both are no-ops while their env key is unset — the default everywhere, and the wave's acceptance
 *     criterion;
 *   - with the key set, the comment is `authorKind: SYSTEM` with `authorId: null`, PUBLIC, carries the
 *     disclaimer inside its stored body, and the ticket's `firstRespondedAt` is STILL null afterwards;
 *   - the delivery row is written in the same transaction, QUEUED, addressed to the requester;
 *   - a suppressed address produces `FAILED_SUPPRESSED` and a `MESSAGE_FAILED` row, and no send;
 *   - a staff-created ticket and a ticket with no address get nothing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}
// `src/lib/env.ts` parses ONCE at import, so both flags must be set before the dynamic imports below.
// Turning them on here is what makes this file the only place in the repository where a SYSTEM message
// is ever written; nothing is transmitted either way — the outbox has no poller in a test run.
process.env.AUTO_ACK_ENABLED = "true";
process.env.RESOLVED_NOTICE_ENABLED = "true";

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const systemModule = TEST_URL ? await import("@/server/system-messages") : null;
const templatesModule = TEST_URL ? await import("@/lib/email/templates/system") : null;
const disclaimersModule = TEST_URL ? await import("@/lib/disclaimers") : null;

function mods() {
  if (!dbModule || !auditModule || !systemModule || !templatesModule || !disclaimersModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...auditModule, ...systemModule, ...templatesModule, ...disclaimersModule };
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_sysmsg_actor_${RUN}`;
const USER_EMAIL = `sysmsg+${RUN}@wm-helpdesk.local`;

type Fixture = { id: string; number: number; email: string | null };

async function makeTicket(
  suffix: string,
  overrides: { source?: "EMAIL" | "STAFF_FORM" | "CLIENT_APP" | "VOICEMAIL"; requesterEmail?: string | null } = {},
): Promise<Fixture> {
  const { prisma } = mods();
  const id = `it_sysmsg_${suffix}_${RUN}`;
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
  const email = overrides.requesterEmail === undefined ? `client+${suffix}.${RUN}@example.com` : overrides.requesterEmail;
  const ticket = await prisma.ticket.upsert({
    where: { id },
    update: {},
    create: {
      id,
      subject: `System message fixture ${suffix}`,
      description: "Ticket used by system-messages.integration.test.ts",
      requesterName: "Fixture Requester",
      requesterEmail: email,
      // `ticket_requester_contact_present` demands an email OR a phone. A voicemail ticket with no
      // address is exactly the Decision #62 shape this file needs to exercise, so it carries a number.
      requesterPhone: email === null ? "+12125550147" : null,
      source: overrides.source ?? "EMAIL",
      brand: "CEDAR_RIDGE_WEALTH",
      category: "OTHER",
      priority: "STANDARD",
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: USER_ID } },
      slaFirstResponseMinutes: 60,
      slaResolutionMinutes: 480,
      firstResponseDueAt: new Date(Date.now() + 60 * 60_000),
      resolutionDueAt: new Date(Date.now() + 8 * 60 * 60_000),
    },
    select: { id: true, number: true, requesterEmail: true },
  });
  return { id: ticket.id, number: ticket.number, email: ticket.requesterEmail };
}

describe.skipIf(!TEST_URL)("SYSTEM messages (DB-gated)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, email: USER_EMAIL, name: "System message fixture", groups: [], isActive: true },
    });
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("writes a SYSTEM-authored PUBLIC comment and a QUEUED delivery, in one transaction", async () => {
    const { prisma, withTx, maybeSendAutoAcknowledgement, systemMessageTemplate, DISCLAIMERS } = mods();
    const ticket = await makeTicket("ack");

    const result = await withTx((tx) => maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number }));
    expect(result).not.toBeNull();
    if (result === null) return;

    const comment = await prisma.comment.findUniqueOrThrow({
      where: { id: result.commentId },
      select: { ticketId: true, authorId: true, authorKind: true, visibility: true, body: true, disclaimerKey: true },
    });
    expect(comment.ticketId).toBe(ticket.id);
    // A machine is not a person: the DB CHECK `comment_staff_has_author` depends on this pair.
    expect(comment.authorKind).toBe("SYSTEM");
    expect(comment.authorId).toBeNull();
    expect(comment.visibility).toBe("PUBLIC");
    expect(comment.disclaimerKey).toBe("GENERAL_SERVICE");
    // I7: the stored row is exactly what the client receives, disclaimer included.
    expect(comment.body).toContain(
      systemMessageTemplate("CEDAR_RIDGE_WEALTH", "AUTO_ACK").body({ ticketNumber: ticket.number }).trimEnd(),
    );
    expect(comment.body).toContain(DISCLAIMERS.GENERAL_SERVICE.text);
    expect(comment.body).toContain(`HD-${ticket.number}`);

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
      select: { commentId: true, ticketId: true, status: true, toAddress: true, subject: true, attempts: true },
    });
    expect(delivery.commentId).toBe(result.commentId);
    expect(delivery.ticketId).toBe(ticket.id);
    expect(delivery.status).toBe("QUEUED");
    expect(delivery.toAddress).toBe(ticket.email);
    expect(delivery.subject).toBe(`[HD-${ticket.number}] System message fixture ack`);
    expect(delivery.attempts).toBe(0);
  });

  it("never stamps firstRespondedAt — an automatic receipt is not a first response", async () => {
    const { prisma, withTx, maybeSendAutoAcknowledgement } = mods();
    const ticket = await makeTicket("nostamp");

    await withTx((tx) => maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number }));

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { firstRespondedAt: true, status: true },
    });
    expect(after.firstRespondedAt).toBeNull();
    // It does not open the ticket either: arriving is not being worked.
    expect(after.status).toBe("NEW");
  });

  it("returns the audit entries rather than writing them, so the caller's writeAuditMany stays last", async () => {
    const { withTx, maybeSendAutoAcknowledgement, prisma } = mods();
    const ticket = await makeTicket("audit");

    const result = await withTx((tx) => maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number }));
    expect(result).not.toBeNull();
    if (result === null) return;

    // Nothing was written by the module itself.
    const rows = await prisma.auditLog.count({ where: { ticketId: ticket.id } });
    expect(rows).toBe(0);

    expect(result.auditEntries.map((e) => e.action)).toEqual(["COMMENT_ADDED_PUBLIC", "MESSAGE_QUEUED"]);
    const commentEntry = result.auditEntries[0];
    expect(commentEntry.entityId).toBe(result.commentId);
    expect(commentEntry.metadata).toMatchObject({ systemMessage: "AUTO_ACK", authorKind: "SYSTEM", stampsFirstResponse: false });
    // Machine-written row, so §3 rule 1's `via` is present and names the channel.
    expect(commentEntry.metadata).toMatchObject({ via: "email", source: "EMAIL" });
  });

  it("honours the suppression list: FAILED_SUPPRESSED, a MESSAGE_FAILED entry, and no send", async () => {
    const { prisma, withTx, maybeSendAutoAcknowledgement, SUPPRESSED_DELIVERY_ERROR } = mods();
    const ticket = await makeTicket("suppressed");
    const address = (ticket.email ?? "").toLowerCase();
    await prisma.requesterSuppression.upsert({
      where: { email: address },
      update: { removedAt: null, removedById: null },
      create: { email: address, reason: "HARD_BOUNCE", note: `integration fixture ${RUN}` },
    });

    const result = await withTx((tx) => maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number }));
    expect(result).not.toBeNull();
    if (result === null) return;

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
      select: { status: true, lastError: true, sentAt: true, attempts: true },
    });
    expect(delivery.status).toBe("FAILED_SUPPRESSED");
    expect(delivery.lastError).toBe(SUPPRESSED_DELIVERY_ERROR);
    expect(delivery.sentAt).toBeNull();
    expect(delivery.attempts).toBe(0);

    // The comment still exists: the desk's record of what it would have said is not contingent on delivery.
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: result.commentId }, select: { id: true } });
    expect(comment.id).toBe(result.commentId);

    const failure = result.auditEntries.find((e) => e.action === "MESSAGE_FAILED");
    expect(failure).toBeDefined();
    expect(failure?.oldValue).toBe("QUEUED");
    expect(failure?.newValue).toBe("FAILED_SUPPRESSED");
  });

  it("does not remain suppressed once the suppression is lifted", async () => {
    const { prisma, withTx, maybeSendResolvedNotice } = mods();
    const ticket = await makeTicket("unsuppressed");
    const address = (ticket.email ?? "").toLowerCase();
    await prisma.requesterSuppression.upsert({
      where: { email: address },
      update: { removedAt: new Date(), removedById: USER_ID },
      create: { email: address, reason: "MANUAL", removedAt: new Date(), removedById: USER_ID },
    });

    const result = await withTx((tx) => maybeSendResolvedNotice(tx, { ticketId: ticket.id, ticketNumber: ticket.number }));
    expect(result).not.toBeNull();
    if (result === null) return;
    const delivery = await prisma.messageDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
      select: { status: true },
    });
    expect(delivery.status).toBe("QUEUED");
  });

  it("writes nothing for a staff-created ticket or a ticket with no deliverable address", async () => {
    const { prisma, withTx, maybeSendAutoAcknowledgement } = mods();
    const staff = await makeTicket("staff", { source: "STAFF_FORM" });
    const noAddress = await makeTicket("noaddress", { source: "VOICEMAIL", requesterEmail: null });
    const malformed = await makeTicket("malformed", { source: "EMAIL", requesterEmail: "not-an-address" });

    for (const ticket of [staff, noAddress, malformed]) {
      const result = await withTx((tx) =>
        maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number }),
      );
      expect(result, ticket.id).toBeNull();
      expect(await prisma.comment.count({ where: { ticketId: ticket.id } }), ticket.id).toBe(0);
    }
  });

  it("carries no `via` on the resolved notice — a person clicked Resolve", async () => {
    const { withTx, maybeSendResolvedNotice } = mods();
    const ticket = await makeTicket("resolved");

    const result = await withTx((tx) => maybeSendResolvedNotice(tx, { ticketId: ticket.id, ticketNumber: ticket.number }));
    expect(result).not.toBeNull();
    if (result === null) return;
    for (const entry of result.auditEntries) {
      expect(entry.metadata).not.toHaveProperty("via");
    }
    expect(result.auditEntries[0].metadata).toMatchObject({ systemMessage: "RESOLVED_NOTICE" });
  });
});

describe.skipIf(!TEST_URL)("SYSTEM messages are off by default", () => {
  it("returns null for both when the env keys are unset", async () => {
    // `src/lib/env.ts` parses ONCE at import, so observing the default the repository actually ships
    // with means a second module registry. `vi.resetModules()` gives one; the transaction handle still
    // comes from the first registry's client, which is fine — `DbTx` is used structurally.
    const ticket = await makeTicket("disabled");
    const { withTx, prisma } = mods();

    vi.resetModules();
    process.env.AUTO_ACK_ENABLED = "";
    process.env.RESOLVED_NOTICE_ENABLED = "";
    try {
      const fresh = await import("@/server/system-messages");
      const ack = await withTx((tx) =>
        fresh.maybeSendAutoAcknowledgement(tx, { ticketId: ticket.id, ticketNumber: ticket.number }),
      );
      const notice = await withTx((tx) =>
        fresh.maybeSendResolvedNotice(tx, { ticketId: ticket.id, ticketNumber: ticket.number }),
      );
      expect(ack).toBeNull();
      expect(notice).toBeNull();
      expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
      expect(await prisma.messageDelivery.count({ where: { ticketId: ticket.id } })).toBe(0);
    } finally {
      process.env.AUTO_ACK_ENABLED = "true";
      process.env.RESOLVED_NOTICE_ENABLED = "true";
    }
  });
});
