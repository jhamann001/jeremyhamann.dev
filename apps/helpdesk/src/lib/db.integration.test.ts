/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database — immutability triggers make every AuditLog / Comment row permanent, so this must never
 * point at the dev database. Tolerates rows left by earlier runs (fixtures are upsert / find-or-create and
 * the chain is verified from GENESIS over every row).
 *
 * Proves live: I2 (raw UPDATE/DELETE/TRUNCATE raise; the hash chain verifies with the app's payload),
 * I3 (an audit insert failure rolls the business write back), I8 (Comment immutable, Ticket undeletable),
 * I1 (publicDb never returns an INTERNAL comment; relation reads and unsafe raw access throw).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditActor, RequestContext } from "@/types/domain";
import { AuditImmutabilityError, IsolationViolationError, PrefetchNotAllowedError } from "@/lib/errors";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}
const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;

function mods() {
  if (!dbModule || !auditModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...auditModule };
}

const RUN = randomUUID().slice(0, 8);
const QUEUE_ID = "it_queue_operations";
const USER_ID = "it_user_dual_role";
const TICKET_ID = "it_ticket_isolation_probe";
const INTERNAL_COMMENT_ID = "it_comment_internal";
const PUBLIC_COMMENT_ID = "it_comment_public";
const INTERNAL_SENTINEL = "INTERNAL_SENTINEL_7f3a — INTERNAL — not for client";
const PUBLIC_BODY = "Public reply body\n\n---\nDisclaimer text";

const DUAL_ROLE_ACTOR: AuditActor = {
  id: USER_ID,
  email: "dual.role@wm-helpdesk.local",
  // Deliberately NOT in OKTA_GROUPS order: the mapper must sort before insert.
  groups: ["compliance_officers", "ops_team"],
};

const CTX: RequestContext = {
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0 (Macintosh; ssn 123-45-6789) AppleWebKit/537.36 it-run",
  requestId: `it-req-${RUN}`,
  isPrefetch: false,
};

/**
 * Raw TRUNCATE probe. Postgres takes ACCESS EXCLUSIVE locks on every listed (or cascaded) table BEFORE it
 * fires the BEFORE TRUNCATE trigger, so under vitest's parallel workers — the other DB-gated files insert into
 * Ticket / Comment / AuditLog concurrently — the statement can stall behind a sibling's open transaction or be
 * chosen as a deadlock victim (40P01) while a sibling's FK check waits on Ticket. Neither outcome says anything
 * about the invariant, so the probe retries ONLY those transient lock failures until the trigger's verdict is
 * observed. Callers still assert the verdict itself (/append-only/) — the proof is not relaxed.
 *
 * `lock_timeout` is deliberately TINY. A pending ACCESS EXCLUSIVE request does not merely wait: it
 * parks at the head of the table's lock queue and every later lock request — a sibling worker's ordinary SELECT
 * or INSERT on Ticket / Comment / AuditLog — queues BEHIND it for as long as the probe is willing to wait. At
 * the old 250ms, forty retries meant this probe could stall the rest of the DB-gated suite for ~10s of wall
 * clock, which is what pushed `sla-sweep.integration.test.ts` (whose sweep reads Ticket) past vitest's 5s
 * default. Bounding the wait at LOCK_WAIT_MS caps the collateral damage at a few milliseconds per attempt while
 * leaving the probe exactly as strict; the budget is spent on MORE attempts instead of LONGER ones, so the
 * probe still lands its verdict as soon as the table is quiet. `SET LOCAL` shares the batch transaction, so
 * both statements land on one connection.
 */
const LOCK_WAIT_MS = 10;
const PROBE_RETRY_GAP_MS = 20;
const PROBE_BUDGET_MS = 20_000;
/** Covers PROBE_BUDGET_MS for every probe a single test makes, plus the surrounding assertions. */
const TRUNCATE_TEST_TIMEOUT_MS = 120_000;

async function truncateVerdict(sql: string): Promise<string> {
  const { prisma } = mods();
  const deadline = Date.now() + PROBE_BUDGET_MS;
  for (;;) {
    let message: string;
    try {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT_MS}ms'`),
        prisma.$executeRawUnsafe(sql),
      ]);
      throw new Error(`${sql} unexpectedly succeeded`);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    if (/append-only/.test(message)) return message;
    const transientLockFailure = /40P01|55P03|deadlock detected|lock timeout/i.test(message);
    if (!transientLockFailure || Date.now() >= deadline) return message;
    await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_GAP_MS));
  }
}

describe.skipIf(!TEST_URL)("db integration (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { id: QUEUE_ID, key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { groups: ["ops_team", "compliance_officers"], isActive: true },
      create: {
        id: USER_ID,
        email: "dual.role@wm-helpdesk.local",
        name: "Dual Role",
        groups: ["ops_team", "compliance_officers"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    const createdAt = new Date("2026-09-16T12:00:00.000Z");
    await prisma.ticket.upsert({
      where: { id: TICKET_ID },
      update: {},
      create: {
        id: TICKET_ID,
        subject: "Isolation probe",
        description: "Ticket used by db.integration.test.ts",
        requesterName: "Probe Requester",
        requesterEmail: "probe@example.com",
        category: "OTHER",
        priority: "STANDARD",
        queue: { connect: { id: queue.id } },
        createdBy: { connect: { id: USER_ID } },
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      },
    });
    // Comments are immutable (no upsert through the extension): find-or-create.
    if ((await prisma.comment.findUnique({ where: { id: INTERNAL_COMMENT_ID } })) === null) {
      await prisma.comment.create({
        data: {
          id: INTERNAL_COMMENT_ID,
          body: INTERNAL_SENTINEL,
          visibility: "INTERNAL",
          disclaimerKey: "NONE",
          ticket: { connect: { id: TICKET_ID } },
          author: { connect: { id: USER_ID } },
        },
      });
    }
    if ((await prisma.comment.findUnique({ where: { id: PUBLIC_COMMENT_ID } })) === null) {
      await prisma.comment.create({
        data: {
          id: PUBLIC_COMMENT_ID,
          body: PUBLIC_BODY,
          visibility: "PUBLIC",
          disclaimerKey: "GENERAL_SERVICE",
          ticket: { connect: { id: TICKET_ID } },
          author: { connect: { id: USER_ID } },
        },
      });
    }
  });

  afterAll(async () => {
    if (!dbModule) return;
    await dbModule.prisma.$disconnect();
    await dbModule.publicDb.$disconnect();
  });

  it("writes audit rows through the shared mapper (sanitized, sorted groups, never-null ip)", async () => {
    const { prisma, writeAudit, writeAuditMany, recordClientApiRead, recordClientApiDenied, recordDenied, recordView, SYSTEM_ACTOR, systemRequestContext } =
      mods();

    await writeAudit(prisma, SYSTEM_ACTOR, systemRequestContext(`it-system-${RUN}`), {
      action: "AUDIT_CHAIN_VERIFIED",
      entityType: "AUDIT_LOG",
      newValue: "OK",
      metadata: { ok: true, checkedRows: 0 },
    });
    await writeAudit(prisma, DUAL_ROLE_ACTOR, CTX, {
      action: "TICKET_VIEWED",
      entityType: "TICKET",
      entityId: TICKET_ID,
      ticketId: TICKET_ID,
    });
    await writeAuditMany(prisma, DUAL_ROLE_ACTOR, CTX, [
      {
        action: "TICKET_FIELD_CHANGED",
        entityType: "TICKET",
        entityId: TICKET_ID,
        ticketId: TICKET_ID,
        fieldChanged: "subject",
        oldValue: "Card 4111 1111 1111 1111 on file",
        newValue: "Card on file",
        metadata: { note: "requester SSN 123-45-6789", count: 1 },
      },
      {
        action: "AUTHZ_DENIED",
        entityType: "QUEUE",
        fieldChanged: "capability",
        newValue: "path:/compliance/audit",
      },
    ]);
    await recordClientApiRead(CTX, TICKET_ID, "Client@Example.COM");
    await recordClientApiDenied(CTX, `no-such-ticket-${RUN}`, null, "client:unauthenticated", false);
    await recordClientApiDenied(CTX, TICKET_ID, "Wrong@Example.com", "client:requester-mismatch", true);
    await recordDenied(DUAL_ROLE_ACTOR, CTX, "ticket:read PREVIEW", TICKET_ID);
    await recordDenied(DUAL_ROLE_ACTOR, CTX, "verifyAuditChain: Forbidden: audit:verify");
    await recordView(DUAL_ROLE_ACTOR, CTX, TICKET_ID, "PREVIEW");

    await expect(recordView(DUAL_ROLE_ACTOR, { ...CTX, isPrefetch: true }, TICKET_ID, "DETAIL")).rejects.toBeInstanceOf(
      PrefetchNotAllowedError,
    );

    const rows = await prisma.auditLog.findMany({ where: { requestId: CTX.requestId }, orderBy: { seq: "asc" } });
    expect(rows).toHaveLength(9);

    const viewed = rows.find((r) => r.action === "TICKET_VIEWED");
    expect(viewed).toBeDefined();
    expect(viewed!.actorGroups).toEqual(["ops_team", "compliance_officers"]);
    expect(viewed!.actorId).toBe(USER_ID);
    expect(viewed!.ipAddress).toBe("203.0.113.7");
    expect(viewed!.userAgent).toContain("[REDACTED:SSN]");
    expect(viewed!.userAgent).not.toContain("123-45-6789");
    expect(viewed!.seq).toBeGreaterThan(BigInt(0));
    expect(viewed!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(viewed!.prevHash).toMatch(/^([0-9a-f]{64}|GENESIS)$/);

    const changed = rows.find((r) => r.action === "TICKET_FIELD_CHANGED");
    expect(changed!.oldValue).toBe("Card [REDACTED:CARD ****1111] on file");
    expect(changed!.metadata).toEqual({ note: "requester SSN [REDACTED:SSN]", count: 1 });

    const denied = rows.find((r) => r.action === "AUTHZ_DENIED" && r.newValue === "path:/compliance/audit");
    expect(denied!.entityType).toBe("QUEUE");
    expect(denied!.ticketId).toBeNull();

    const apiRead = rows.find((r) => r.action === "CLIENT_API_READ");
    expect(apiRead!.actorEmail).toBe("client:client@example.com");
    expect(apiRead!.actorId).toBeNull();
    expect(apiRead!.ticketId).toBe(TICKET_ID);

    const unauth = rows.find((r) => r.newValue === "client:unauthenticated");
    expect(unauth!.actorEmail).toBe("client:anonymous");
    expect(unauth!.entityType).toBe("TICKET");
    // `no-such-ticket-<run>` is not a plausible ticket id (dashes), so it is bounded to "id:invalid" before
    // it reaches the append-only ledger — an unauthenticated caller controls this segment.
    expect(unauth!.entityId).toBe("id:invalid");
    expect(unauth!.ticketId).toBeNull();

    const mismatch = rows.find((r) => r.newValue === "client:requester-mismatch");
    expect(mismatch!.actorEmail).toBe("client:wrong@example.com");
    expect(mismatch!.ticketId).toBe(TICKET_ID);
    // A plausible, real ticket id is still stored verbatim (it matches the id shape).
    expect(mismatch!.entityId).toBe(TICKET_ID);

    const previewDenied = rows.find((r) => r.newValue === "ticket:read PREVIEW");
    expect(previewDenied!.entityType).toBe("TICKET");
    expect(previewDenied!.ticketId).toBe(TICKET_ID);
    const verifyDenied = rows.find((r) => r.newValue === "verifyAuditChain: Forbidden: audit:verify");
    expect(verifyDenied!.entityType).toBe("AUDIT_LOG");

    const previewed = rows.find((r) => r.action === "TICKET_PREVIEWED");
    expect(previewed!.newValue).toBe("slide-over");

    const system = await prisma.auditLog.findFirst({
      where: { requestId: { startsWith: `it-system-${RUN}` } },
    });
    expect(system!.actorEmail).toBe("system@wm-helpdesk.local");
    expect(system!.actorGroups).toEqual([]);
    expect(system!.ipAddress).toBe("unknown");
    expect(system!.userAgent).toBe(`it-system-${RUN}`);
  });

  it("raw UPDATE / DELETE / TRUNCATE on AuditLog raise at the database and leave the row unchanged (I2)", async () => {
    const { prisma } = mods();
    const first = await prisma.auditLog.findFirstOrThrow({ orderBy: { seq: "asc" } });
    const seq = first.seq.toString();

    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "newValue" = 'tampered' WHERE seq = ${seq}`)).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE seq = ${seq}`)).rejects.toThrow(/append-only/);
    expect(await truncateVerdict(`TRUNCATE "AuditLog"`)).toMatch(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "metadata" = '{}'::jsonb WHERE seq = ${seq}`)).rejects.toThrow(
      /append-only/,
    );

    const again = await prisma.auditLog.findUniqueOrThrow({ where: { seq: first.seq } });
    expect(again).toEqual(first);
    expect(await prisma.auditLog.count()).toBeGreaterThan(0);
  }, TRUNCATE_TEST_TIMEOUT_MS);

  it("the in-app extension also refuses mutation of the ledger against the live client", async () => {
    const { prisma } = mods();
    await expect(prisma.auditLog.updateMany({ data: { newValue: "x" } })).rejects.toBeInstanceOf(AuditImmutabilityError);
    await expect(prisma.comment.deleteMany({})).rejects.toBeInstanceOf(AuditImmutabilityError);
    await expect(prisma.ticket.delete({ where: { id: TICKET_ID } })).rejects.toBeInstanceOf(AuditImmutabilityError);
    // Wave A's six tables are covered by the same layer, not by the triggers alone. Every `where`
    // names an id that cannot exist, so a missing guard here cannot damage the test database.
    const missing = { id: "no-such-row" };
    await expect(
      prisma.ingestReceipt.updateMany({ where: missing, data: { outcome: "comment" } }),
    ).rejects.toBeInstanceOf(AuditImmutabilityError);
    await expect(prisma.slaAlert.updateMany({ where: missing, data: { minutesOver: 1 } })).rejects.toBeInstanceOf(
      AuditImmutabilityError,
    );
    await expect(prisma.attachment.deleteMany({ where: missing })).rejects.toBeInstanceOf(AuditImmutabilityError);
    await expect(prisma.messageDelivery.deleteMany({ where: missing })).rejects.toBeInstanceOf(AuditImmutabilityError);
    await expect(prisma.suspendedIntake.deleteMany({ where: missing })).rejects.toBeInstanceOf(AuditImmutabilityError);
  });

  it("Comment is immutable and Ticket cannot be hard-deleted at the database (I8)", async () => {
    const { prisma } = mods();
    const before = await prisma.comment.findUniqueOrThrow({ where: { id: INTERNAL_COMMENT_ID } });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "Comment" SET body = $1 WHERE id = $2`, "tampered", INTERNAL_COMMENT_ID),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "Comment" WHERE id = $1`, INTERNAL_COMMENT_ID)).rejects.toThrow(
      /append-only/,
    );
    // CASCADE because Wave A's IngestReceipt references Comment: without it Postgres refuses on the
    // foreign key BEFORE the trigger can speak, which proves nothing about the invariant.
    expect(await truncateVerdict(`TRUNCATE "Comment" CASCADE`)).toMatch(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "Ticket" WHERE id = $1`, TICKET_ID)).rejects.toThrow(/append-only/);
    expect(await truncateVerdict(`TRUNCATE "Ticket" CASCADE`)).toMatch(/append-only/);
    const after = await prisma.comment.findUniqueOrThrow({ where: { id: INTERNAL_COMMENT_ID } });
    expect(after).toEqual(before);
    expect(await prisma.ticket.findUnique({ where: { id: TICKET_ID } })).not.toBeNull();
  }, TRUNCATE_TEST_TIMEOUT_MS);

  it("Wave A: the two new ledgers are append-only and the four state tables cannot be hard-deleted", async () => {
    const { prisma } = mods();
    const externalId = `it-receipt-${RUN}`;
    const receipt = await prisma.ingestReceipt.create({
      data: { source: "API", externalId, ticketId: TICKET_ID, outcome: "ticket" },
      select: { id: true },
    });
    // IngestReceipt and SlaAlert are evidence of "we already handled this": UPDATE and DELETE raise.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "IngestReceipt" SET outcome = $1 WHERE id = $2`, "comment", receipt.id),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "IngestReceipt" WHERE id = $1`, receipt.id),
    ).rejects.toThrow(/append-only/);
    expect(await truncateVerdict(`TRUNCATE "IngestReceipt"`)).toMatch(/append-only/);

    // Read-then-create, not upsert: the extension refuses `slaAlert.upsert` because its update branch
    // would rewrite an append-only row. The unique key makes the read the dedupe, as the sweep does.
    const alertKey = { ticketId_phase_kind: { ticketId: TICKET_ID, phase: "FIRST_RESPONSE", kind: "WARNING" } } as const;
    const alert =
      (await prisma.slaAlert.findUnique({ where: alertKey, select: { id: true } })) ??
      (await prisma.slaAlert.create({
        data: { ticketId: TICKET_ID, phase: "FIRST_RESPONSE", kind: "WARNING", minutesOver: 0 },
        select: { id: true },
      }));
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "SlaAlert" SET "minutesOver" = 5 WHERE id = $1`, alert.id),
    ).rejects.toThrow(/append-only/);
    expect(await truncateVerdict(`TRUNCATE "SlaAlert"`)).toMatch(/append-only/);

    // The state tables DO transition (they are state machines whose every change is audited), but a row
    // is never removed: the record of what the firm sent, held or attached survives.
    expect(await truncateVerdict(`TRUNCATE "MessageDelivery"`)).toMatch(/append-only/);
    expect(await truncateVerdict(`TRUNCATE "SuspendedIntake"`)).toMatch(/append-only/);
    expect(await truncateVerdict(`TRUNCATE "Attachment"`)).toMatch(/append-only/);
  }, TRUNCATE_TEST_TIMEOUT_MS);

  it("Wave A: the CHECK constraints refuse a contactless ticket, an unattributed STAFF comment and a traversal key", async () => {
    const { prisma } = mods();
    // A ticket must be reachable: email OR phone.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Ticket" SET "requesterEmail" = NULL, "requesterPhone" = NULL WHERE id = $1`,
        TICKET_ID,
      ),
    ).rejects.toThrow(/ticket_requester_contact_present/);

    // A STAFF comment always names its author; a REQUESTER comment never does.
    await expect(
      prisma.comment.create({
        data: { ticketId: TICKET_ID, authorKind: "STAFF", authorId: null, visibility: "INTERNAL", body: "no author" },
      }),
    ).rejects.toThrow(/comment_staff_has_author/);
    await expect(
      prisma.comment.create({
        data: {
          ticketId: TICKET_ID,
          authorKind: "REQUESTER",
          authorId: USER_ID,
          visibility: "PUBLIC",
          body: "requester rows carry no staff id",
        },
      }),
    ).rejects.toThrow(/comment_staff_has_author/);

    // Object keys are derived, never a filename: no traversal, no leading slash.
    await expect(
      prisma.attachment.create({
        data: {
          ticketId: TICKET_ID,
          filename: "statement.pdf",
          mime: "application/pdf",
          size: 10,
          objectKey: `../../etc/passwd-${RUN}`,
        },
      }),
    ).rejects.toThrow(/attachment_object_key_shape/);
  });

  it("every AuditLog row re-hashes with the app payload and the chain links from GENESIS", async () => {
    const { prisma, canonicalAuditPayload, hashAuditRow, verifyChainRows } = mods();
    const rows = await prisma.auditLog.findMany({ orderBy: { seq: "asc" } });
    expect(rows.length).toBeGreaterThanOrEqual(9);

    expect(rows[0].prevHash).toBe("GENESIS");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      expect(hashAuditRow(canonicalAuditPayload(row))).toBe(row.hash);
      if (i > 0) {
        expect(row.prevHash).toBe(rows[i - 1].hash);
        expect(row.seq).toBeGreaterThan(rows[i - 1].seq);
      }
    }
    expect(rows.some((r) => r.actorGroups.length === 2 && r.userAgent !== null)).toBe(true);
    expect(rows.some((r) => r.actorGroups.length === 0)).toBe(true);
    expect(rows.every((r) => r.ipAddress.length > 0)).toBe(true);

    const verdict = verifyChainRows(rows, null);
    expect(verdict).toEqual({ ok: true, checked: rows.length, firstBadSeq: null, reason: "OK" });

    // A tampered copy is detected without touching the database.
    const tampered = rows.map((r) => ({ ...r }));
    tampered[tampered.length - 1].newValue = "edited";
    const bad = verifyChainRows(tampered, null);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("HASH_MISMATCH");
    expect(bad.firstBadSeq).toBe(rows[rows.length - 1].seq);
  });

  it("withTx: an audit insert failure rolls back the business write; success commits both (I3)", async () => {
    const { prisma, withTx, writeAudit } = mods();
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_ID } });
    // Assertions are scoped to rows THIS transaction could produce: the other DB-gated files run in parallel
    // vitest workers against the same TEST_DATABASE_URL and append their own audit rows, so a global
    // `auditLog.count()` is not a stable rollback witness. Only this file writes rows for TICKET_ID.
    const ghostActor: AuditActor = { id: `ghost_${RUN}`, email: `ghost_${RUN}@wm-helpdesk.local`, groups: [] };
    const probeRowsBefore = await prisma.auditLog.count({ where: { ticketId: TICKET_ID } });

    await expect(
      withTx(async (tx) => {
        await tx.ticket.update({ where: { id: TICKET_ID }, data: { version: { increment: 1 } } });
        // actorId references no User row → FK violation on the audit insert → whole transaction rolls back.
        await writeAudit(tx, ghostActor, CTX, {
          action: "TICKET_FIELD_CHANGED",
          entityType: "TICKET",
          entityId: TICKET_ID,
          ticketId: TICKET_ID,
        });
      }),
    ).rejects.toThrow();

    const afterRollback = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_ID } });
    expect(afterRollback.version).toBe(before.version);
    expect(await prisma.auditLog.count({ where: { ticketId: TICKET_ID } })).toBe(probeRowsBefore);
    expect(await prisma.auditLog.count({ where: { actorEmail: ghostActor.email } })).toBe(0);

    const result = await withTx(async (tx) => {
      const updated = await tx.ticket.update({ where: { id: TICKET_ID }, data: { version: { increment: 1 } } });
      await writeAudit(tx, DUAL_ROLE_ACTOR, { ...CTX, requestId: `it-tx-${RUN}` }, {
        action: "TICKET_FIELD_CHANGED",
        entityType: "TICKET",
        entityId: TICKET_ID,
        ticketId: TICKET_ID,
        fieldChanged: "version",
        oldValue: String(before.version),
        newValue: String(updated.version),
      });
      return updated.version;
    });
    expect(result).toBe(before.version + 1);
    expect(await prisma.auditLog.count({ where: { requestId: `it-tx-${RUN}` } })).toBe(1);
  });

  it("publicDb never sees INTERNAL comments and rejects relation / raw-unsafe access (I1)", async () => {
    const { prisma, publicDb } = mods();

    expect(await prisma.comment.count({ where: { ticketId: TICKET_ID, visibility: "INTERNAL" } })).toBeGreaterThanOrEqual(1);
    expect(await publicDb.comment.count({ where: { ticketId: TICKET_ID, visibility: "INTERNAL" } })).toBe(0);
    expect(await publicDb.comment.count({ where: { ticketId: TICKET_ID } })).toBe(
      await prisma.comment.count({ where: { ticketId: TICKET_ID, visibility: "PUBLIC" } }),
    );

    const publicRows = await publicDb.comment.findMany({ where: { ticketId: TICKET_ID } });
    expect(publicRows.length).toBeGreaterThanOrEqual(1);
    expect(publicRows.every((c) => c.visibility === "PUBLIC")).toBe(true);
    expect(JSON.stringify(publicRows)).not.toContain("INTERNAL_SENTINEL_7f3a");
    expect(await publicDb.comment.findUnique({ where: { id: INTERNAL_COMMENT_ID } })).toBeNull();
    expect(await publicDb.comment.findFirst({ where: { id: INTERNAL_COMMENT_ID } })).toBeNull();
    expect((await publicDb.comment.findUnique({ where: { id: PUBLIC_COMMENT_ID } }))?.body).toBe(PUBLIC_BODY);

    const scalar = await publicDb.ticket.findUnique({
      where: { id: TICKET_ID },
      select: { id: true, number: true, subject: true, status: true, requesterEmail: true },
    });
    expect(scalar?.id).toBe(TICKET_ID);

    await expect(publicDb.ticket.findUnique({ where: { id: TICKET_ID }, include: { comments: true } })).rejects.toBeInstanceOf(
      IsolationViolationError,
    );
    await expect(publicDb.ticket.findUnique({ where: { id: TICKET_ID }, select: { comments: true } })).rejects.toBeInstanceOf(
      IsolationViolationError,
    );
    await expect(publicDb.$queryRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(IsolationViolationError);
    await expect(publicDb.$executeRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(IsolationViolationError);
    await expect(publicDb.user.findMany()).rejects.toBeInstanceOf(IsolationViolationError);
    await expect(publicDb.ticket.update({ where: { id: TICKET_ID }, data: { subject: "x" } })).rejects.toBeInstanceOf(
      IsolationViolationError,
    );

    // The tagged-template $queryRaw stays available for the view (what selectPublicComments uses).
    const viaView = await publicDb.$queryRaw<Array<{ id: string; body: string }>>`
      SELECT id, body FROM "ClientVisibleComment" WHERE "ticketId" = ${TICKET_ID} ORDER BY "createdAt" ASC`;
    expect(viaView.length).toBe(publicRows.length);
    expect(viaView.some((c) => c.body.includes("INTERNAL_SENTINEL_7f3a"))).toBe(false);

    const leak = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "ClientVisibleComment" v JOIN "Comment" c USING (id) WHERE c.visibility = 'INTERNAL'`;
    expect(leak[0].n).toBe(0);
  });
});
