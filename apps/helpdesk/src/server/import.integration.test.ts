/**
 * `importTicketCore` against a real database (DB-gated; docs/ARCHITECTURE.md §g shared convention 10).
 *
 * TEST_DATABASE_URL only. The immutability triggers make every row written here PERMANENT, and other
 * files run concurrently against the same database, so every fixture is namespaced by a per-run id and
 * every assertion is scoped to rows this run created.
 *
 * What needs a real schema rather than a stub:
 *  - the ORIGINAL timestamps actually land (`@updatedAt` does not overwrite a supplied `updatedAt`,
 *    and `createdAt` is not `now()`), which is the one claim a unit test cannot make;
 *  - `(IMPORT, zd:<id>)` is unique on BOTH `IngestReceipt` and `Ticket`, so the second call replays;
 *  - the CHECK constraints accept what the mapper produces (`comment_staff_has_author`,
 *    `ticket_requester_contact_present`, the attachment key shape);
 *  - `sanitizePII` really ran before the write — the row in the database holds no SSN;
 *  - the `TICKET_IMPORTED` row is in the hash-chained ledger with `metadata.via = "import"`.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const importModule = TEST_URL ? await import("@/server/import") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;

function mods() {
  if (!dbModule || !importModule || !auditModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...importModule, ...auditModule };
}

const RUN = randomUUID().slice(0, 8);
const ACTOR = `it_imp_actor_${RUN}`;
const AGENT = `it_imp_agent_${RUN}`;
const AGENT_EMAIL = `imp.agent.${RUN}@wm-helpdesk.local`;
const REQUESTER_EMAIL = `imp.client.${RUN}@example.invalid`;

const ORIGINAL_CREATED = "2026-03-02T09:15:00.000Z";
const ORIGINAL_UPDATED = "2026-03-09T17:45:00.000Z";
const ORIGINAL_FIRST_REPLY = "2026-03-02T10:02:00.000Z";

function call() {
  const { AUDIT_VIA, systemRequestContext } = mods();
  return {
    actor: { id: ACTOR, email: `${ACTOR}@wm-helpdesk.local`, groups: [] },
    ctx: systemRequestContext(`import-it-${RUN}`),
    via: AUDIT_VIA.import,
  };
}

function ticketInput(id: string, over: Record<string, unknown> = {}) {
  const { legacyDeskExternalId } = mods();
  return {
    externalId: legacyDeskExternalId(id),
    subject: `Imported wire question ${RUN}`,
    description: "The wire did not land; my SSN is 123-45-6789 if you need it.",
    category: "WIRE_TRANSFER" as const,
    priority: "HIGH" as const,
    status: "OPEN" as const,
    queueKey: "OPERATIONS" as const,
    requesterName: `Imported Client ${RUN}`,
    requesterEmail: REQUESTER_EMAIL,
    createdAt: ORIGINAL_CREATED,
    updatedAt: ORIGINAL_UPDATED,
    firstRespondedAt: ORIGINAL_FIRST_REPLY,
    externalRef: "REQ-4410",
    isComplaint: true,
    comments: [
      {
        externalId: `zd:c1-${id}`,
        authorKind: "REQUESTER" as const,
        authorEmail: REQUESTER_EMAIL,
        visibility: "PUBLIC" as const,
        body: "The wire did not land.",
        createdAt: ORIGINAL_CREATED,
      },
      {
        externalId: `zd:c2-${id}`,
        authorKind: "STAFF" as const,
        authorEmail: AGENT_EMAIL,
        visibility: "PUBLIC" as const,
        body: "Checking with the custodian now.",
        createdAt: ORIGINAL_FIRST_REPLY,
      },
      {
        externalId: `zd:c3-${id}`,
        authorKind: "STAFF" as const,
        authorEmail: `departed.${RUN}@nowhere.invalid`,
        authorName: "Former Agent",
        visibility: "INTERNAL" as const,
        body: "Internal: account 4455667788 flagged for review.",
        createdAt: ORIGINAL_UPDATED,
      },
    ],
    ...over,
  };
}

describe.skipIf(!TEST_URL)("importTicketCore (DB-gated)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.user.upsert({
      where: { id: ACTOR },
      update: { isActive: true },
      create: { id: ACTOR, email: `${ACTOR}@wm-helpdesk.local`, name: "Import runner", groups: [], isActive: true },
    });
    await prisma.user.upsert({
      where: { id: AGENT },
      update: { isActive: true, email: AGENT_EMAIL },
      create: { id: AGENT, email: AGENT_EMAIL, name: "Desk Agent", groups: ["ops_team"], isActive: true },
    });
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "import fixture", sortOrder: 1 },
    });
  });

  it("writes the ticket with its ORIGINAL clock, its comments and its flags", async () => {
    const { importTicketCore, prisma } = mods();
    const zid = `900${RUN.slice(0, 4)}1`;
    const result = await importTicketCore(ticketInput(zid), call());

    expect(result.created).toBe(true);
    expect(result.comments).toBe(3);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
      include: { comments: { orderBy: { createdAt: "asc" } }, queue: true },
    });

    // The whole reason this core exists rather than a call to createTicketCore.
    expect(ticket.createdAt.toISOString()).toBe(ORIGINAL_CREATED);
    expect(ticket.updatedAt.toISOString()).toBe(ORIGINAL_UPDATED);
    expect(ticket.firstRespondedAt?.toISOString()).toBe(ORIGINAL_FIRST_REPLY);
    expect(ticket.source).toBe("IMPORT");
    expect(ticket.externalId).toBe(`zd:${zid}`);
    expect(ticket.status).toBe("OPEN");
    expect(ticket.isComplaint).toBe(true);
    expect(ticket.complaintFiledAt?.toISOString()).toBe(ORIGINAL_CREATED);
    expect(ticket.queue.key).toBe("OPERATIONS");
    // The SLA snapshot is measured from the original creation, not from the import.
    expect(ticket.firstResponseDueAt.getTime()).toBeGreaterThan(Date.parse(ORIGINAL_CREATED));
    expect(ticket.firstResponseDueAt.getTime()).toBeLessThan(Date.parse(ORIGINAL_CREATED) + 7 * 86_400_000);

    expect(ticket.comments).toHaveLength(3);
    const [first, second, third] = ticket.comments;
    expect(first.authorKind).toBe("REQUESTER");
    expect(first.authorId).toBeNull();
    expect(first.visibility).toBe("PUBLIC");
    expect(first.createdAt.toISOString()).toBe(ORIGINAL_CREATED);
    // The agent who still exists is attributed to their real row.
    expect(second.authorKind).toBe("STAFF");
    expect(second.authorId).toBe(AGENT);
    // The one who does not becomes SYSTEM with the name in the body, never a STAFF row with no author.
    expect(third.authorKind).toBe("SYSTEM");
    expect(third.authorId).toBeNull();
    expect(third.visibility).toBe("INTERNAL");
    expect(third.body).toContain("Former Agent");
  });

  it("redacts on the way in: the archive's unmasked NPI is not what the desk stores", async () => {
    const { importTicketCore, prisma } = mods();
    const zid = `900${RUN.slice(0, 4)}2`;
    const result = await importTicketCore(ticketInput(zid), call());

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.ticketId },
      include: { comments: true },
    });
    expect(ticket.description).not.toContain("123-45-6789");
    expect(ticket.piiRedacted).toBe(true);
    expect(ticket.piiRedactionCount).toBeGreaterThan(0);
    const internal = ticket.comments.find((c) => c.visibility === "INTERNAL");
    expect(internal?.body).not.toContain("4455667788");

    // The ledger records COUNTS, never the redacted values — and the counts span the ticket's
    // own fields AND its comments. A row reading `SSN=0` beside a non-zero total would be worse than
    // no row: the SSN legacy help desk never masked is far more often in a reply than in the description.
    const pii = await prisma.auditLog.findMany({
      where: { ticketId: ticket.id, action: "PII_REDACTED" },
    });
    expect(pii).toHaveLength(1);
    expect(pii[0].newValue ?? "").not.toContain("123-45-6789");
    expect(pii[0].newValue ?? "").toMatch(/SSN=[1-9]/);
    expect(pii[0].newValue ?? "").toMatch(/ACCOUNT=[1-9]/);
    expect(pii[0].fieldChanged ?? "").toContain("description");
    expect(pii[0].fieldChanged ?? "").toContain("comments");
    expect((pii[0].metadata as Record<string, unknown> | null)?.comments).toBe(1);
  });

  it("is idempotent: a re-run returns the same ids with created=false and writes nothing new", async () => {
    const { importTicketCore, prisma } = mods();
    const zid = `900${RUN.slice(0, 4)}3`;
    const first = await importTicketCore(ticketInput(zid), call());
    const before = await prisma.auditLog.count({ where: { ticketId: first.ticketId } });

    const second = await importTicketCore(ticketInput(zid), call());
    expect(second.created).toBe(false);
    expect(second.ticketId).toBe(first.ticketId);
    expect(second.ticketNumber).toBe(first.ticketNumber);
    expect(second.comments).toBe(3);

    expect(await prisma.auditLog.count({ where: { ticketId: first.ticketId } })).toBe(before);
    expect(await prisma.ticket.count({ where: { source: "IMPORT", externalId: `zd:${zid}` } })).toBe(1);
    expect(await prisma.comment.count({ where: { ticketId: first.ticketId } })).toBe(3);
  });

  it("writes ONE TICKET_IMPORTED row, in the ledger, labelled via=import", async () => {
    const { importTicketCore, prisma } = mods();
    const zid = `900${RUN.slice(0, 4)}4`;
    const result = await importTicketCore(ticketInput(zid), call());

    const rows = await prisma.auditLog.findMany({
      where: { ticketId: result.ticketId, action: "TICKET_IMPORTED" },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.entityType).toBe("TICKET");
    expect(row.entityId).toBe(result.ticketId);
    const metadata = row.metadata as Record<string, unknown> | null;
    expect(metadata?.via).toBe("import");
    expect(metadata?.source).toBe("IMPORT");
    // §3.2: the newValue carries the externalId, the source, the original creation and the counts.
    const newValue = JSON.parse(row.newValue ?? "{}") as Record<string, unknown>;
    expect(newValue).toMatchObject({
      externalId: `zd:${zid}`,
      source: "IMPORT",
      originalCreatedAt: ORIGINAL_CREATED,
      comments: 3,
    });
    // No acknowledgement, no assignment, no notification: an import is a backfill, not an event.
    const noise = await prisma.auditLog.count({
      where: { ticketId: result.ticketId, action: { in: ["TICKET_ASSIGNED", "MESSAGE_QUEUED", "COMMENT_ADDED_PUBLIC"] } },
    });
    expect(noise).toBe(0);
    expect(await prisma.messageDelivery.count({ where: { ticketId: result.ticketId } })).toBe(0);
    expect(await prisma.notification.count({ where: { ticketId: result.ticketId } })).toBe(0);
  });

  it("stores an attachment through the object store and flips it READY", async () => {
    const { importTicketCore, prisma } = mods();
    const zid = `900${RUN.slice(0, 4)}5`;
    const bytes = new TextEncoder().encode("%PDF-1.7 fixture");
    const puts: string[] = [];
    const store = {
      backend: "filesystem" as const,
      async signedPutUrl() {
        throw new Error("unused");
      },
      async signedGetUrl() {
        throw new Error("unused");
      },
      async head() {
        return { exists: false, size: 0, sha256: null };
      },
      async put(key: string, body: Uint8Array) {
        puts.push(key);
        return { size: body.byteLength, sha256: "a".repeat(64) };
      },
      async get() {
        return bytes;
      },
    };

    const input = ticketInput(zid, {
      attachments: [
        {
          externalId: `zd:att-${zid}`,
          filename: "wire confirmation.pdf",
          mime: "application/pdf",
          size: bytes.byteLength,
          sourcePath: `attachments/1/wire-confirmation.pdf`,
          commentExternalId: `zd:c2-${zid}`,
        },
        {
          // Outside the allowlist: reported as skipped, never stored.
          externalId: `zd:att2-${zid}`,
          filename: "macro.xlsm",
          mime: "application/vnd.ms-excel.sheet.macroEnabled.12",
          size: 10,
          sourcePath: `attachments/2/macro.xlsm`,
          commentExternalId: null,
        },
      ],
    });

    const result = await importTicketCore(input, call(), {
      readAttachment: async () => bytes,
      store,
    });

    expect(result.attachments).toBe(1);
    expect(puts).toHaveLength(1);
    const attachments = await prisma.attachment.findMany({ where: { ticketId: result.ticketId } });
    expect(attachments).toHaveLength(1);
    expect(attachments[0].state).toBe("READY");
    expect(attachments[0].visibility).toBe("INTERNAL");
    expect(attachments[0].objectKey).toBe(`${result.ticketId}/${attachments[0].id}`);
    expect(attachments[0].commentId).not.toBeNull();
    expect(puts[0]).toBe(attachments[0].objectKey);
  });

  it("refuses a call that is not labelled via=import, and a VOIDED status", async () => {
    const { importTicketCore } = mods();
    const zid = `900${RUN.slice(0, 4)}6`;
    await expect(importTicketCore(ticketInput(zid), { ...call(), via: null })).rejects.toThrow(/via="import"/);
    await expect(importTicketCore(ticketInput(zid, { status: "VOIDED" }), call())).rejects.toThrow(/VOIDED/);
  });

  it("imports a phone-only ticket, and refuses one with neither address nor phone", async () => {
    const { importTicketCore, prisma } = mods();
    const zid = `900${RUN.slice(0, 4)}7`;
    const result = await importTicketCore(
      ticketInput(zid, { requesterEmail: null, requesterPhone: "+14155550123", comments: [] }),
      call(),
    );
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } });
    expect(ticket.requesterEmail).toBeNull();
    expect(ticket.requesterPhone).toBe("+14155550123");

    await expect(
      importTicketCore(ticketInput(`${zid}x`, { requesterEmail: null, requesterPhone: null }), call()),
    ).rejects.toBeTruthy();
  });

  it("importedExternalIds answers which of a batch already landed", async () => {
    const { importTicketCore, importedExternalIds } = mods();
    const zid = `900${RUN.slice(0, 4)}8`;
    await importTicketCore(ticketInput(zid), call());
    const found = await importedExternalIds([`zd:${zid}`, `zd:${zid}-never`]);
    expect(found.has(`zd:${zid}`)).toBe(true);
    expect(found.has(`zd:${zid}-never`)).toBe(false);
    expect(await importedExternalIds([])).toEqual(new Set());
  });
});
