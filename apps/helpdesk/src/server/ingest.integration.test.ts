/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database — the immutability triggers make every AuditLog and Comment row permanent, so this
 * must never point at the dev database. Every fixture is run-scoped or find-or-create, so repeated runs
 * accumulate rows without colliding.
 *
 * What only a live database can prove, and therefore what this file is for
 * (#65, #70, #71):
 *  - `(source, externalId)` idempotency is a ROW, not a guess: a replay returns the same ticket id with
 *    `created: false` and the database still holds exactly one ticket.
 *  - The ticket, its `IngestReceipt` and its `TICKET_INGESTED` row are written in ONE transaction, with
 *    `metadata.via` on every machine-written row.
 *  - A requester message is `authorKind` REQUESTER with a NULL `authorId` (the DB CHECK
 *    `comment_staff_has_author` enforces the pairing in both directions) and NEVER stamps
 *    `firstRespondedAt`.
 *  - The status rules: `PENDING_CLIENT → OPEN`, `RESOLVED → OPEN` with `TICKET_REOPENED_BY_REQUESTER`
 *    and a cleared `resolvedAt`, `PENDING_INTERNAL` untouched, and `CLOSED` refusing in favour of a new
 *    linked ticket.
 *  - The Ops Portal mirror export never carries an INTERNAL body, and its cursor pages without gaps or repeats.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditActor, RequestContext } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}
const dbModule = TEST_URL ? await import("@/lib/db") : null;
const ingestModule = TEST_URL ? await import("@/server/ingest") : null;
const errorsModule = TEST_URL ? await import("@/lib/errors") : null;

function mods() {
  if (!dbModule || !ingestModule || !errorsModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...ingestModule, ...errorsModule };
}

const RUN = randomUUID().slice(0, 8);
const QUEUE_KEY = "OPERATIONS" as const;
const MACHINE_USER_ID = "svc_integration";
const STAFF_USER_ID = `it_ing_staff_${RUN}`;
const STAFF_EMAIL = `it.ingest.staff.${RUN}@wm-helpdesk.local`;

const ACTOR: AuditActor = { id: MACHINE_USER_ID, email: "integration@wm-helpdesk.local", groups: [] };

const CTX: RequestContext = {
  ipAddress: "203.0.113.42",
  userAgent: "n8n/1.0 ingest-integration",
  requestId: `it-ingest-${RUN}`,
  isPrefetch: false,
};

const CALL = { actor: ACTOR, ctx: CTX, via: "api" as const };

function extId(label: string): string {
  return `it-${RUN}-${label}`;
}

function baseTicket(label: string, overrides: Record<string, unknown> = {}) {
  return {
    source: "EMAIL" as const,
    externalId: extId(label),
    subject: `Ingest probe ${label} ${RUN}`,
    description: `Body for ${label}`,
    requesterName: "Probe Requester",
    requesterEmail: `probe.${RUN}@example.com`,
    ...overrides,
  };
}

describe.skipIf(!TEST_URL)("ingest cores (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: QUEUE_KEY },
      update: {},
      create: { key: QUEUE_KEY, name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    await prisma.queue.upsert({
      where: { key: "CLIENT_SERVICE" },
      update: {},
      create: { key: "CLIENT_SERVICE", name: "Client Service", description: "integration fixture", sortOrder: 2 },
    });
    // The seeded machine identity: prisma/seed.ts step 0 writes it, but a bare test database may not
    // have been seeded, so the fixture makes it exist rather than skipping the whole file.
    await prisma.user.upsert({
      where: { id: MACHINE_USER_ID },
      update: { isActive: true },
      create: {
        id: MACHINE_USER_ID,
        email: "integration@wm-helpdesk.local",
        name: "Integration (machine)",
        groups: [],
        isActive: true,
      },
    });
    await prisma.user.upsert({
      where: { id: STAFF_USER_ID },
      update: { isActive: true },
      create: {
        id: STAFF_USER_ID,
        email: STAFF_EMAIL,
        name: "Ingest Staff",
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    if (!dbModule) return;
    await dbModule.prisma.$disconnect();
    await dbModule.publicDb.$disconnect();
  });

  // -------------------------------------------------------------------------
  // createTicketCore
  // -------------------------------------------------------------------------

  it("creates the ticket, its receipt and its TICKET_INGESTED row in one transaction", async () => {
    const { prisma, createTicketCore } = mods();
    const result = await createTicketCore(baseTicket("create"), CALL);

    expect(result.created).toBe(true);
    expect(result.ticketNumber).toBeGreaterThan(0);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
      select: {
        source: true,
        externalId: true,
        status: true,
        category: true,
        priority: true,
        brand: true,
        createdById: true,
        firstRespondedAt: true,
        slaFirstResponseMinutes: true,
        firstResponseDueAt: true,
        createdAt: true,
        queue: { select: { key: true } },
      },
    });
    expect(ticket.source).toBe("EMAIL");
    expect(ticket.externalId).toBe(extId("create"));
    expect(ticket.status).toBe("NEW");
    // No category supplied → OTHER, and OTHER's routing row decides the queue and priority.
    expect(ticket.category).toBe("OTHER");
    expect(ticket.brand).toBe("CEDAR_RIDGE_WEALTH");
    expect(ticket.createdById).toBe(MACHINE_USER_ID);
    expect(ticket.firstRespondedAt).toBeNull();
    // SLA stamping identical to the staff path: the due date is createdAt + the stored policy minutes.
    expect(ticket.firstResponseDueAt.getTime()).toBe(
      ticket.createdAt.getTime() + ticket.slaFirstResponseMinutes * 60_000,
    );

    const receipt = await prisma.ingestReceipt.findUniqueOrThrow({
      where: { source_externalId: { source: "EMAIL", externalId: extId("create") } },
    });
    expect(receipt.ticketId).toBe(result.ticketId);
    expect(receipt.commentId).toBeNull();
    expect(receipt.outcome).toBe("ticket");

    const rows = await prisma.auditLog.findMany({
      where: { ticketId: result.ticketId },
      orderBy: { seq: "asc" },
    });
    const ingested = rows.find((r) => r.action === "TICKET_INGESTED");
    expect(ingested).toBeDefined();
    expect(ingested?.actorId).toBe(MACHINE_USER_ID);
    expect(ingested?.actorGroups).toEqual([]);
    expect(ingested?.ipAddress).toBe(CTX.ipAddress);
    expect(ingested?.metadata).toMatchObject({ via: "api", source: "EMAIL", externalId: extId("create") });
    expect(JSON.parse(String(ingested?.newValue))).toMatchObject({
      source: "EMAIL",
      externalId: extId("create"),
      category: "OTHER",
      queueKey: ticket.queue.key,
      brand: "CEDAR_RIDGE_WEALTH",
    });
  });

  it("is idempotent: a replay returns the same ids with created:false and writes no second ticket", async () => {
    const { prisma, createTicketCore } = mods();
    const first = await createTicketCore(baseTicket("replay"), CALL);
    const second = await createTicketCore(baseTicket("replay", { subject: "A DIFFERENT subject" }), CALL);

    expect(second.created).toBe(false);
    expect(second.ticketId).toBe(first.ticketId);
    expect(second.ticketNumber).toBe(first.ticketNumber);

    const count = await prisma.ticket.count({ where: { source: "EMAIL", externalId: extId("replay") } });
    expect(count).toBe(1);
    // The replay wrote nothing at all — not even a second TICKET_INGESTED row.
    const ingestedRows = await prisma.auditLog.count({
      where: { ticketId: first.ticketId, action: "TICKET_INGESTED" },
    });
    expect(ingestedRows).toBe(1);
    // And the first call's subject is what the record holds: a replay is not an edit.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: first.ticketId }, select: { subject: true } });
    expect(ticket.subject).toContain("Ingest probe replay");
  });

  it("resolves a concurrent duplicate into one ticket rather than two or a 500", async () => {
    const { prisma, createTicketCore } = mods();
    const input = baseTicket("race");
    const [a, b] = await Promise.all([createTicketCore(input, CALL), createTicketCore(input, CALL)]);

    expect(a.ticketId).toBe(b.ticketId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await prisma.ticket.count({ where: { source: "EMAIL", externalId: extId("race") } })).toBe(1);
  });

  it("sanitizes every free-text field before persistence and records counts, never values (I4)", async () => {
    const { prisma, createTicketCore } = mods();
    const result = await createTicketCore(
      baseTicket("pii", {
        description: "Please debit account number 123456789012 today.",
        clientReference: "SSN 123-45-6789",
      }),
      CALL,
    );

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
      select: { description: true, clientReference: true, piiRedacted: true, piiRedactionCount: true },
    });
    expect(ticket.description).not.toContain("123456789012");
    expect(ticket.clientReference).not.toContain("123-45-6789");
    expect(ticket.piiRedacted).toBe(true);
    expect(ticket.piiRedactionCount).toBeGreaterThanOrEqual(2);
    expect(result.piiRedacted).toBe(true);

    const pii = await prisma.auditLog.findFirst({
      where: { ticketId: result.ticketId, action: "PII_REDACTED" },
    });
    expect(pii).not.toBeNull();
    expect(pii?.newValue ?? "").not.toContain("123456789012");
  });

  it("accepts a phone-only ticket (Decision #62) and stores no address", async () => {
    const { prisma, createTicketCore } = mods();
    const result = await createTicketCore(
      baseTicket("voicemail", {
        source: "VOICEMAIL",
        externalId: extId("voicemail"),
        category: "VOICEMAIL_CALLBACK",
        requesterEmail: null,
        requesterPhone: "+14155550123",
      }),
      CALL,
    );
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
      select: { requesterEmail: true, requesterPhone: true, category: true, queue: { select: { key: true } } },
    });
    expect(ticket.requesterEmail).toBeNull();
    expect(ticket.requesterPhone).toBe("+14155550123");
    // Decision #61 routing: VOICEMAIL_CALLBACK belongs to Client Service.
    expect(ticket.queue.key).toBe("CLIENT_SERVICE");
  });

  it("truncates an oversize body and says so in the stored record", async () => {
    const { prisma, createTicketCore, truncateBody } = mods();
    const long = "z".repeat(25_000);
    const result = await createTicketCore(baseTicket("truncate", { description: long }), CALL);
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
      select: { description: true },
    });
    expect(ticket.description).toBe(truncateBody(long).body);
    expect(ticket.description.endsWith("the full original is in the mailbox.]")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // addRequesterMessageCore
  // -------------------------------------------------------------------------

  it("writes a requester message with a NULL authorId and never stamps the first response", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("msg"), CALL);

    const result = await addRequesterMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "EMAIL",
        externalId: extId("msg-1"),
        authorKind: "REQUESTER",
        body: "Following up on this.",
      },
      CALL,
    );

    expect(result.created).toBe(true);
    const comment = await prisma.comment.findUniqueOrThrow({
      where: { id: String(result.commentId) },
      select: { authorId: true, authorKind: true, visibility: true, disclaimerKey: true, body: true },
    });
    expect(comment.authorId).toBeNull();
    expect(comment.authorKind).toBe("REQUESTER");
    expect(comment.visibility).toBe("PUBLIC");
    // A client's own words never carry the firm's disclaimer.
    expect(comment.disclaimerKey).toBe("NONE");
    expect(comment.body).toBe("Following up on this.");

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { firstRespondedAt: true, status: true },
    });
    // The whole point: a client writing to us is not the desk responding.
    expect(after.firstRespondedAt).toBeNull();
    expect(after.status).toBe("NEW");

    const added = await prisma.auditLog.findFirst({
      where: { ticketId: ticket.ticketId, action: "COMMENT_ADDED_REQUESTER" },
    });
    expect(added?.entityId).toBe(result.commentId);
    expect(added?.metadata).toMatchObject({ via: "api", source: "EMAIL" });
  });

  it("is idempotent on messages too", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("msg-idem"), CALL);
    const input = {
      ticketId: ticket.ticketId,
      source: "EMAIL" as const,
      externalId: extId("msg-idem-1"),
      authorKind: "REQUESTER" as const,
      body: "Same message twice.",
    };
    const first = await addRequesterMessageCore(input, CALL);
    const second = await addRequesterMessageCore({ ...input, body: "Different text, same id." }, CALL);

    expect(second.created).toBe(false);
    expect(second.commentId).toBe(first.commentId);
    expect(await prisma.comment.count({ where: { ticketId: ticket.ticketId } })).toBe(1);
  });

  it("moves PENDING_CLIENT to OPEN and audits it as a status change, not a reopen", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("pending"), CALL);
    await prisma.ticket.update({ where: { id: ticket.ticketId }, data: { status: "PENDING_CLIENT" } });

    const result = await addRequesterMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "EMAIL",
        externalId: extId("pending-1"),
        authorKind: "REQUESTER",
        body: "Here is the document you asked for.",
      },
      CALL,
    );
    expect(result.reopened).toBe(true);

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { status: true },
    });
    expect(after.status).toBe("OPEN");

    const statusRows = await prisma.auditLog.findMany({
      where: { ticketId: ticket.ticketId, fieldChanged: "status" },
      select: { action: true, oldValue: true, newValue: true },
    });
    expect(statusRows).toEqual([{ action: "TICKET_STATUS_CHANGED", oldValue: "PENDING_CLIENT", newValue: "OPEN" }]);
  });

  it("reopens a RESOLVED ticket, clears resolvedAt and writes TICKET_REOPENED_BY_REQUESTER", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("resolved"), CALL);
    const resolvedAt = new Date("2026-09-18T10:00:00.000Z");
    await prisma.ticket.update({ where: { id: ticket.ticketId }, data: { status: "RESOLVED", resolvedAt } });

    const result = await addRequesterMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "EMAIL",
        externalId: extId("resolved-1"),
        authorKind: "REQUESTER",
        body: "This is not fixed yet.",
      },
      CALL,
    );
    expect(result.reopened).toBe(true);

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { status: true, resolvedAt: true },
    });
    expect(after.status).toBe("OPEN");
    // A ticket carrying resolvedAt reads as COMPLETE to computeSlaStatus, so the reopen must clear it.
    expect(after.resolvedAt).toBeNull();

    const reopen = await prisma.auditLog.findFirst({
      where: { ticketId: ticket.ticketId, action: "TICKET_REOPENED_BY_REQUESTER" },
    });
    expect(reopen?.oldValue).toBe("RESOLVED");
    expect(reopen?.newValue).toBe("OPEN");
    const cleared = await prisma.auditLog.findFirst({
      where: { ticketId: ticket.ticketId, action: "TICKET_FIELD_CHANGED", fieldChanged: "resolvedAt" },
    });
    expect(cleared?.oldValue).toBe(resolvedAt.toISOString());
    expect(cleared?.newValue).toBeNull();
  });

  it("leaves PENDING_INTERNAL alone — the desk is waiting on itself, not the client", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("pending-internal"), CALL);
    await prisma.ticket.update({ where: { id: ticket.ticketId }, data: { status: "PENDING_INTERNAL" } });

    const result = await addRequesterMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "EMAIL",
        externalId: extId("pending-internal-1"),
        authorKind: "REQUESTER",
        body: "Any news?",
      },
      CALL,
    );
    expect(result.reopened).toBe(false);
    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { status: true },
    });
    expect(after.status).toBe("PENDING_INTERNAL");
  });

  it("REFUSES a reply on a CLOSED ticket (Decision #70)", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore, ConflictError } = mods();
    const ticket = await createTicketCore(baseTicket("closed"), CALL);
    await prisma.ticket.update({
      where: { id: ticket.ticketId },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    await expect(
      addRequesterMessageCore(
        {
          ticketId: ticket.ticketId,
          source: "EMAIL",
          externalId: extId("closed-1"),
          authorKind: "REQUESTER",
          body: "One more thing.",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing landed on the closed record.
    expect(await prisma.comment.count({ where: { ticketId: ticket.ticketId } })).toBe(0);
  });

  it("opens a NEW linked ticket when a requester replies to a CLOSED one", async () => {
    const { prisma, createTicketCore, addRequesterMessageOrFollowUp } = mods();
    const original = await createTicketCore(
      baseTicket("closed-followup", { category: "COST_BASIS", requesterPhone: "+14155550199" }),
      CALL,
    );
    await prisma.ticket.update({
      where: { id: original.ticketId },
      data: { status: "CLOSED", closedAt: new Date(), householdId: "hh_probe" },
    });

    const outcome = await addRequesterMessageOrFollowUp(
      {
        ticketId: original.ticketId,
        source: "EMAIL",
        externalId: extId("closed-followup-1"),
        authorKind: "REQUESTER",
        body: "Actually, one more question about the basis.",
      },
      CALL,
    );

    expect(outcome.linkedFromTicketId).toBe(original.ticketId);
    expect(outcome.result.created).toBe(true);
    expect(outcome.result.ticketId).not.toBe(original.ticketId);

    const followUp = await prisma.ticket.findUniqueOrThrow({
      where: { id: outcome.result.ticketId },
      select: {
        linkedFromTicketId: true,
        status: true,
        category: true,
        householdId: true,
        requesterPhone: true,
        description: true,
      },
    });
    expect(followUp.linkedFromTicketId).toBe(original.ticketId);
    expect(followUp.status).toBe("NEW");
    // The follow-up inherits everything except the closed ticket's status and history.
    expect(followUp.category).toBe("COST_BASIS");
    expect(followUp.householdId).toBe("hh_probe");
    expect(followUp.requesterPhone).toBe("+14155550199");
    expect(followUp.description).toBe("Actually, one more question about the basis.");

    // The closed record is untouched — that is what "CLOSED is terminal" means.
    const closed = await prisma.ticket.findUniqueOrThrow({
      where: { id: original.ticketId },
      select: { status: true },
    });
    expect(closed.status).toBe("CLOSED");

    const linked = await prisma.auditLog.findFirst({
      where: { ticketId: outcome.result.ticketId, action: "TICKET_LINKED" },
    });
    expect(linked?.newValue).toBe(original.ticketId);
  });

  // -------------------------------------------------------------------------
  // addStaffMessageCore
  // -------------------------------------------------------------------------

  it("writes a machine-posted INTERNAL staff note against the named, active user", async () => {
    const { prisma, createTicketCore, addStaffMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("staff"), CALL);

    const result = await addStaffMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "API",
        externalId: extId("staff-1"),
        authorKind: "STAFF",
        authorEmail: STAFF_EMAIL,
        body: "Called the custodian; awaiting their reference.",
      },
      CALL,
    );

    const comment = await prisma.comment.findUniqueOrThrow({
      where: { id: String(result.commentId) },
      select: { authorId: true, authorKind: true, visibility: true, disclaimerKey: true },
    });
    expect(comment.authorId).toBe(STAFF_USER_ID);
    expect(comment.authorKind).toBe("STAFF");
    expect(comment.visibility).toBe("INTERNAL");
    expect(comment.disclaimerKey).toBe("NONE");

    // An internal note never stamps the first response.
    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { firstRespondedAt: true },
    });
    expect(after.firstRespondedAt).toBeNull();
  });

  it("refuses a staff message whose author is unknown or deactivated", async () => {
    const { prisma, createTicketCore, addStaffMessageCore, ValidationError } = mods();
    const ticket = await createTicketCore(baseTicket("staff-unknown"), CALL);

    await expect(
      addStaffMessageCore(
        {
          ticketId: ticket.ticketId,
          source: "API",
          externalId: extId("staff-unknown-1"),
          authorKind: "STAFF",
          authorEmail: `nobody.${RUN}@wm-helpdesk.local`,
          body: "Who am I?",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const inactiveId = `it_ing_inactive_${RUN}`;
    const inactiveEmail = `it.ingest.inactive.${RUN}@wm-helpdesk.local`;
    await prisma.user.upsert({
      where: { id: inactiveId },
      update: { isActive: false },
      create: { id: inactiveId, email: inactiveEmail, name: "Offboarded", groups: ["ops_team"], isActive: false },
    });
    await expect(
      addStaffMessageCore(
        {
          ticketId: ticket.ticketId,
          source: "API",
          externalId: extId("staff-unknown-2"),
          authorKind: "STAFF",
          authorEmail: inactiveEmail,
          body: "Still here?",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.comment.count({ where: { ticketId: ticket.ticketId } })).toBe(0);
  });

  it("allows an INTERNAL staff note on a CLOSED ticket (§b.9) but refuses a PUBLIC one", async () => {
    const { prisma, createTicketCore, addStaffMessageCore, ConflictError } = mods();
    const ticket = await createTicketCore(baseTicket("staff-closed"), CALL);
    await prisma.ticket.update({
      where: { id: ticket.ticketId },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    const note = await addStaffMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "API",
        externalId: extId("staff-closed-1"),
        authorKind: "STAFF",
        authorEmail: STAFF_EMAIL,
        body: "Compliance annotation after close.",
      },
      CALL,
    );
    expect(note.created).toBe(true);

    await expect(
      addStaffMessageCore(
        {
          ticketId: ticket.ticketId,
          source: "API",
          externalId: extId("staff-closed-2"),
          authorKind: "STAFF",
          authorEmail: STAFF_EMAIL,
          visibility: "PUBLIC",
          disclaimerKey: "GENERAL_SERVICE",
          body: "A reply the client would receive.",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  // -------------------------------------------------------------------------
  // Idempotency scoping — the key never crosses a caller, the replay never crosses a record
  // -------------------------------------------------------------------------

  it("keeps two CLIENT_APP requesters apart when they present the SAME externalId", async () => {
    const { prisma, createTicketCore } = mods();
    const shared = extId("capp-shared");
    const alice = `alice.${RUN}@example.com`;
    const bob = `bob.${RUN}@example.com`;

    const a = await createTicketCore(
      baseTicket("capp-a", { source: "CLIENT_APP", externalId: shared, requesterEmail: alice }),
      CALL,
    );
    const b = await createTicketCore(
      baseTicket("capp-b", { source: "CLIENT_APP", externalId: shared, requesterEmail: bob }),
      CALL,
    );

    // Two people, two tickets. Before the scoping fix, Bob was handed Alice's id and WM number.
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.ticketId).not.toBe(a.ticketId);
    expect(b.ticketNumber).not.toBe(a.ticketNumber);

    // And the derived keys are distinct rows, with the scope hashed rather than stored in the clear.
    const rows = await prisma.ingestReceipt.findMany({
      where: { source: "CLIENT_APP", ticketId: { in: [a.ticketId, b.ticketId] } },
      select: { externalId: true, ticketId: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.externalId)).size).toBe(2);
    for (const row of rows) {
      expect(row.externalId.endsWith(`~${shared}`)).toBe(true);
      expect(row.externalId).not.toContain(alice);
      expect(row.externalId).not.toContain(bob);
    }
  });

  it("still replays a CLIENT_APP retry from the SAME requester — the phone kept its safety net", async () => {
    const { prisma, createTicketCore } = mods();
    const input = baseTicket("capp-retry", {
      source: "CLIENT_APP",
      externalId: extId("capp-retry-1"),
      requesterEmail: `retry.${RUN}@example.com`,
    });

    const first = await createTicketCore(input, CALL);
    const second = await createTicketCore({ ...input, description: "Resent after a dropped connection." }, CALL);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ticketId).toBe(first.ticketId);
    expect(
      await prisma.ticket.count({ where: { source: "CLIENT_APP", requesterEmail: input.requesterEmail } }),
    ).toBe(1);
  });

  it("REFUSES a message whose externalId is already recorded against a DIFFERENT ticket", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore, IngestExternalIdConflictError } = mods();
    const ticketA = await createTicketCore(baseTicket("xid-a"), CALL);
    const ticketB = await createTicketCore(baseTicket("xid-b"), CALL);
    const shared = extId("xid-msg");

    const onA = await addRequesterMessageCore(
      {
        ticketId: ticketA.ticketId,
        source: "EMAIL",
        externalId: shared,
        authorKind: "REQUESTER",
        body: "Alice's question.",
      },
      CALL,
    );
    expect(onA.created).toBe(true);

    // The old behaviour answered 200 with ticket A's id and number and wrote nothing to B.
    await expect(
      addRequesterMessageCore(
        {
          ticketId: ticketB.ticketId,
          source: "EMAIL",
          externalId: shared,
          authorKind: "REQUESTER",
          body: "Bob's question, which must not vanish.",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(IngestExternalIdConflictError);

    // Nothing was written to B, and nothing about A was disclosed by writing to B.
    expect(await prisma.comment.count({ where: { ticketId: ticketB.ticketId } })).toBe(0);
    expect(await prisma.comment.count({ where: { ticketId: ticketA.ticketId } })).toBe(1);
  });

  it("refuses a CLIENT_APP reply whose request id is already spent on another of the same client's tickets", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore, IngestExternalIdConflictError } = mods();
    const requester = `twotickets.${RUN}@example.com`;
    const first = await createTicketCore(
      baseTicket("capp-msg-a", {
        source: "CLIENT_APP",
        externalId: extId("capp-msg-a"),
        requesterEmail: requester,
      }),
      CALL,
    );
    const second = await createTicketCore(
      baseTicket("capp-msg-b", {
        source: "CLIENT_APP",
        externalId: extId("capp-msg-b"),
        requesterEmail: requester,
      }),
      CALL,
    );
    const shared = extId("capp-msg-shared");

    await addRequesterMessageCore(
      {
        ticketId: first.ticketId,
        source: "CLIENT_APP",
        externalId: shared,
        authorKind: "REQUESTER",
        body: "On the first ticket.",
      },
      CALL,
    );
    await expect(
      addRequesterMessageCore(
        {
          ticketId: second.ticketId,
          source: "CLIENT_APP",
          externalId: shared,
          authorKind: "REQUESTER",
          body: "On the second ticket.",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(IngestExternalIdConflictError);
    expect(await prisma.comment.count({ where: { ticketId: second.ticketId } })).toBe(0);
  });

  it("does NOT mint a follow-up ticket for an id collision on a CLOSED ticket", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore, addRequesterMessageOrFollowUp } = mods();
    const live = await createTicketCore(baseTicket("xid-live"), CALL);
    const closed = await createTicketCore(baseTicket("xid-closed"), CALL);
    await prisma.ticket.update({
      where: { id: closed.ticketId },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    const shared = extId("xid-followup");

    await addRequesterMessageCore(
      {
        ticketId: live.ticketId,
        source: "EMAIL",
        externalId: shared,
        authorKind: "REQUESTER",
        body: "Spends the id.",
      },
      CALL,
    );

    const before = await prisma.ticket.count({ where: { linkedFromTicketId: closed.ticketId } });
    await expect(
      addRequesterMessageOrFollowUp(
        {
          ticketId: closed.ticketId,
          source: "EMAIL",
          externalId: shared,
          authorKind: "REQUESTER",
          body: "Would have become a ticket under a spent id.",
        },
        CALL,
      ),
    ).rejects.toThrow();
    // Decision #70 must not be reached by an error that is not "this ticket is closed".
    expect(await prisma.ticket.count({ where: { linkedFromTicketId: closed.ticketId } })).toBe(before);
  });

  it("REFUSES a staff message whose externalId belongs to another ticket", async () => {
    const { prisma, createTicketCore, addStaffMessageCore, IngestExternalIdConflictError } = mods();
    const ticketA = await createTicketCore(baseTicket("xid-staff-a"), CALL);
    const ticketB = await createTicketCore(baseTicket("xid-staff-b"), CALL);
    const shared = extId("xid-staff");

    await addStaffMessageCore(
      {
        ticketId: ticketA.ticketId,
        source: "API",
        externalId: shared,
        authorKind: "STAFF",
        authorEmail: STAFF_EMAIL,
        body: "Internal note on A.",
      },
      CALL,
    );
    await expect(
      addStaffMessageCore(
        {
          ticketId: ticketB.ticketId,
          source: "API",
          externalId: shared,
          authorKind: "STAFF",
          authorEmail: STAFF_EMAIL,
          body: "Internal note meant for B.",
        },
        CALL,
      ),
    ).rejects.toBeInstanceOf(IngestExternalIdConflictError);
    expect(await prisma.comment.count({ where: { ticketId: ticketB.ticketId } })).toBe(0);
  });

  it("queues a public staff reply to the address the ticket holds INSIDE the transaction", async () => {
    const { prisma, createTicketCore, addStaffMessageCore } = mods();
    const ticket = await createTicketCore(baseTicket("staff-deliver"), CALL);
    // The address the pre-transaction snapshot would have captured is deliberately superseded here.
    const current = `moved.${RUN}@example.com`;
    await prisma.ticket.update({ where: { id: ticket.ticketId }, data: { requesterEmail: current } });

    const result = await addStaffMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "API",
        externalId: extId("staff-deliver-1"),
        authorKind: "STAFF",
        authorEmail: STAFF_EMAIL,
        visibility: "PUBLIC",
        disclaimerKey: "GENERAL_SERVICE",
        body: "Here is the update you asked for.",
      },
      CALL,
    );

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({
      where: { commentId: String(result.commentId) },
      select: { toAddress: true, status: true, subject: true },
    });
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { requesterEmail: true, number: true },
    });
    expect(delivery.toAddress).toBe(row.requesterEmail);
    expect(delivery.toAddress).toBe(current);
    expect(delivery.subject).toContain(`HD-${row.number}`);
    // Nothing transmits from this repo: the row sits QUEUED until a poller that does not exist yet.
    expect(delivery.status).toBe("QUEUED");
  });

  // -------------------------------------------------------------------------
  // The Ops Portal mirror export
  // -------------------------------------------------------------------------

  it("exports PUBLIC messages only, and never an INTERNAL body (I1)", async () => {
    const { prisma, createTicketCore, addRequesterMessageCore, addStaffMessageCore, exportTicketsPage } = mods();
    const ticket = await createTicketCore(baseTicket("export"), CALL);
    await addRequesterMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "EMAIL",
        externalId: extId("export-req"),
        authorKind: "REQUESTER",
        body: "Client visible question.",
      },
      CALL,
    );
    const sentinel = `INTERNAL_SENTINEL_${RUN} — never leaves the desk`;
    await addStaffMessageCore(
      {
        ticketId: ticket.ticketId,
        source: "API",
        externalId: extId("export-int"),
        authorKind: "STAFF",
        authorEmail: STAFF_EMAIL,
        body: sentinel,
      },
      CALL,
    );

    const updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.ticketId },
      select: { updatedAt: true },
    });
    const page = await exportTicketsPage({ updatedSince: updated.updatedAt, limit: 50 });
    const row = page.rows.find((r) => r.id === ticket.ticketId);
    expect(row).toBeDefined();
    expect(row?.reference).toBe(`HD-${ticket.ticketNumber}`);
    expect(row?.messages.map((m) => m.authorKind)).toEqual(["REQUESTER"]);
    expect(JSON.stringify(page)).not.toContain(sentinel);
    expect(JSON.stringify(page)).not.toContain("INTERNAL_SENTINEL");
  });

  it("pages by (updatedAt, id) without gaps or repeats, and stops with a null cursor", async () => {
    const { prisma, createTicketCore, exportTicketsPage, decodeExportCursor } = mods();

    // The export has no tenant filter — it pages the WHOLE ticket table from a watermark — and the
    // test database is shared with every other file running at the same time. So the walk is over
    // real, foreign rows, and only the rows carrying this marker are this test's to reason about.
    const MARKER = `page.${RUN}.${randomUUID().slice(0, 8)}@paging.test`;
    const LIMIT = 2;

    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTicketCore(baseTicket(`page-${i}`, { requesterEmail: MARKER }), CALL);
      created.push(t.ticketId);
    }

    // The keyset order the walk must reproduce, asked of the database in the export's own ordering so
    // a millisecond shared by two fixtures is broken by id exactly as the export breaks it.
    const marked = await prisma.ticket.findMany({
      where: { id: { in: created } },
      select: { id: true, updatedAt: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });
    expect(marked).toHaveLength(created.length);
    const watermark = marked[0].updatedAt;
    const newest = marked[marked.length - 1].updatedAt;
    const expectedOrder = marked.map((m) => m.id);
    const markedIds = new Set(expectedOrder);

    // The bound that replaces the old `guard < 20`, and the reason it cannot loop forever: every row
    // the walk can return before its cursor passes `newest` lies in the CLOSED interval
    // [watermark, newest], and that interval can only lose rows from here — anything written or
    // touched from now on gets an `updatedAt` later than `newest` and falls outside it. So this count,
    // taken now, is a permanent upper bound on the rows the bounded walk can consume.
    const windowRows = await prisma.ticket.count({ where: { updatedAt: { gte: watermark, lte: newest } } });
    const maxPages = Math.ceil(windowRows / LIMIT) + 2;

    const seen: { id: string; updatedAt: string; requesterEmail: string | null }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let sawFullPageWithCursor = false;
    for (;;) {
      const page: Awaited<ReturnType<typeof exportTicketsPage>> = await exportTicketsPage({
        updatedSince: watermark,
        cursor: cursor === null ? undefined : (decodeExportCursor(cursor) ?? undefined),
        limit: LIMIT,
      });
      pages += 1;
      expect(pages).toBeLessThanOrEqual(maxPages);
      expect(page.rows.length).toBeLessThanOrEqual(LIMIT);

      // The termination rule itself, asserted on every page rather than inferred from reaching the
      // end of a table other files are still growing: a page that is not full is the LAST page, and
      // it says so with a null cursor. A non-null cursor therefore always has more rows behind it.
      if (page.rows.length < LIMIT) expect(page.nextCursor).toBeNull();
      if (page.nextCursor !== null) sawFullPageWithCursor = true;

      seen.push(
        ...page.rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt, requesterEmail: r.requesterEmail })),
      );

      // A concurrent writer, made deterministic: a foreign ticket committed mid-walk, between two
      // pages, exactly as a sibling test file does. It must not shift, skip or duplicate anything the
      // remaining pages owe this test.
      if (pages === 1) {
        await createTicketCore(baseTicket("page-intruder", { requesterEmail: `intruder.${RUN}@example.com` }), CALL);
      }

      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      const decoded = decodeExportCursor(cursor);
      expect(decoded).not.toBeNull();
      // Past this test's window every further row belongs to somebody else; the marked rows are all
      // behind us by construction, so walking on would only be reading the rest of the database.
      if (decoded !== null && decoded.updatedAt.getTime() > newest.getTime()) break;
    }

    // Five rows at two per page is three pages minimum, so the multi-page path really was exercised.
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(sawFullPageWithCursor).toBe(true);

    // Strictly increasing by (updatedAt, id) across the whole walk, page boundaries included — which
    // is both the ordering guarantee and, on its own, proof that no row came back twice.
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1];
      const curr = seen[i];
      const ordered = curr.updatedAt > prev.updatedAt || (curr.updatedAt === prev.updatedAt && curr.id > prev.id);
      expect(ordered, `keyset went backwards at ${i}: ${JSON.stringify(prev)} then ${JSON.stringify(curr)}`).toBe(
        true,
      );
    }
    expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);

    // And the marked rows specifically: all five, each exactly once, in the keyset order — no gap.
    const mine = seen.filter((r) => markedIds.has(r.id));
    expect(mine.map((r) => r.id)).toEqual(expectedOrder);
    // The marker is on the exported row, not just on the id list — so "the rows carrying the marker"
    // is something the payload itself can be asked, which is what makes the filter above meaningful.
    expect(mine.map((r) => r.requesterEmail)).toEqual(Array(expectedOrder.length).fill(MARKER));
    expect(seen.filter((r) => r.requesterEmail === MARKER).map((r) => r.id)).toEqual(expectedOrder);
  });

  it("returns an empty page and a null cursor when nothing has changed since the watermark", async () => {
    const { exportTicketsPage } = mods();
    const page = await exportTicketsPage({ updatedSince: new Date("2099-01-01T00:00:00.000Z"), limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
