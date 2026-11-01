/**
 * db.ts without a database: the client extensions throw before any engine call, and the migration /
 * role scripts are checked as text (docs/ARCHITECTURE.md §g S2 tests).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditImmutabilityError, IsolationViolationError } from "@/lib/errors";
import { BOOKS_AND_RECORDS_GUARDS, TICKET_RELATION_KEYS, prisma, publicDb, withTx } from "@/lib/db";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Converts a rejected (or synchronously thrown) operation into its error value. */
async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the operation to reject");
}

describe("booksAndRecords extension (I2, I8) — throws in-app before reaching the engine", () => {
  const auditOps: Array<[string, () => Promise<unknown>]> = [
    ["auditLog.update", () => prisma.auditLog.update({ where: { id: "x" }, data: { newValue: "y" } })],
    ["auditLog.updateMany", () => prisma.auditLog.updateMany({ where: { id: "x" }, data: { newValue: "y" } })],
    [
      "auditLog.updateManyAndReturn",
      () => prisma.auditLog.updateManyAndReturn({ where: { id: "x" }, data: { newValue: "y" } }),
    ],
    [
      "auditLog.upsert",
      () =>
        prisma.auditLog.upsert({
          where: { id: "x" },
          update: { newValue: "y" },
          create: { actorEmail: "a@b", action: "TICKET_VIEWED", entityType: "TICKET", ipAddress: "unknown", requestId: "r" },
        }),
    ],
    ["auditLog.delete", () => prisma.auditLog.delete({ where: { id: "x" } })],
    ["auditLog.deleteMany", () => prisma.auditLog.deleteMany({ where: { id: "x" } })],
  ];

  const commentOps: Array<[string, () => Promise<unknown>]> = [
    ["comment.update", () => prisma.comment.update({ where: { id: "x" }, data: { body: "y" } })],
    ["comment.updateMany", () => prisma.comment.updateMany({ where: { id: "x" }, data: { body: "y" } })],
    ["comment.updateManyAndReturn", () => prisma.comment.updateManyAndReturn({ where: { id: "x" }, data: { body: "y" } })],
    [
      "comment.upsert",
      () =>
        prisma.comment.upsert({
          where: { id: "x" },
          update: { body: "y" },
          create: {
            body: "b",
            visibility: "INTERNAL",
            ticket: { connect: { id: "t" } },
            author: { connect: { id: "u" } },
          },
        }),
    ],
    ["comment.delete", () => prisma.comment.delete({ where: { id: "x" } })],
    ["comment.deleteMany", () => prisma.comment.deleteMany({ where: { id: "x" } })],
  ];

  const ticketOps: Array<[string, () => Promise<unknown>]> = [
    ["ticket.delete", () => prisma.ticket.delete({ where: { id: "x" } })],
    ["ticket.deleteMany", () => prisma.ticket.deleteMany({ where: { id: "x" } })],
  ];

  // Wave A's two append-only ledgers. Every `where` below names an id that cannot exist, so a
  // REGRESSION here (the guard removed) surfaces as a wrong error type, never as a real mutation.
  const ingestReceiptOps: Array<[string, () => Promise<unknown>]> = [
    ["ingestReceipt.update", () => prisma.ingestReceipt.update({ where: { id: "x" }, data: { outcome: "comment" } })],
    [
      "ingestReceipt.updateMany",
      () => prisma.ingestReceipt.updateMany({ where: { id: "x" }, data: { outcome: "comment" } }),
    ],
    [
      "ingestReceipt.updateManyAndReturn",
      () => prisma.ingestReceipt.updateManyAndReturn({ where: { id: "x" }, data: { outcome: "comment" } }),
    ],
    [
      "ingestReceipt.upsert",
      () =>
        prisma.ingestReceipt.upsert({
          where: { id: "x" },
          update: { outcome: "comment" },
          create: { source: "API", externalId: "e", outcome: "ticket" },
        }),
    ],
    ["ingestReceipt.delete", () => prisma.ingestReceipt.delete({ where: { id: "x" } })],
    ["ingestReceipt.deleteMany", () => prisma.ingestReceipt.deleteMany({ where: { id: "x" } })],
  ];

  const slaAlertOps: Array<[string, () => Promise<unknown>]> = [
    ["slaAlert.update", () => prisma.slaAlert.update({ where: { id: "x" }, data: { minutesOver: 1 } })],
    ["slaAlert.updateMany", () => prisma.slaAlert.updateMany({ where: { id: "x" }, data: { minutesOver: 1 } })],
    [
      "slaAlert.updateManyAndReturn",
      () => prisma.slaAlert.updateManyAndReturn({ where: { id: "x" }, data: { minutesOver: 1 } }),
    ],
    [
      "slaAlert.upsert",
      () =>
        prisma.slaAlert.upsert({
          where: { id: "x" },
          update: { minutesOver: 1 },
          create: { phase: "FIRST_RESPONSE", kind: "WARNING", minutesOver: 0, ticket: { connect: { id: "t" } } },
        }),
    ],
    ["slaAlert.delete", () => prisma.slaAlert.delete({ where: { id: "x" } })],
    ["slaAlert.deleteMany", () => prisma.slaAlert.deleteMany({ where: { id: "x" } })],
  ];

  // Wave A's state tables: they transition (audited), but no row ever leaves.
  const stateTableOps: Array<[string, () => Promise<unknown>]> = [
    ["attachment.delete", () => prisma.attachment.delete({ where: { id: "x" } })],
    ["attachment.deleteMany", () => prisma.attachment.deleteMany({ where: { id: "x" } })],
    ["messageDelivery.delete", () => prisma.messageDelivery.delete({ where: { id: "x" } })],
    ["messageDelivery.deleteMany", () => prisma.messageDelivery.deleteMany({ where: { id: "x" } })],
    ["suspendedIntake.delete", () => prisma.suspendedIntake.delete({ where: { id: "x" } })],
    ["suspendedIntake.deleteMany", () => prisma.suspendedIntake.deleteMany({ where: { id: "x" } })],
  ];

  for (const [op, run] of [
    ...auditOps,
    ...commentOps,
    ...ticketOps,
    ...ingestReceiptOps,
    ...slaAlertOps,
    ...stateTableOps,
  ]) {
    it(`${op} → AuditImmutabilityError`, async () => {
      const e = await rejection(run);
      expect(e).toBeInstanceOf(AuditImmutabilityError);
      expect((e as AuditImmutabilityError).operation).toBe(op);
      expect((e as AuditImmutabilityError).code).toBe("AUDIT_IMMUTABLE");
    });
  }

  it("exposes withTx and the ticket relation key list", () => {
    expect(typeof withTx).toBe("function");
    expect(TICKET_RELATION_KEYS).toEqual(["queue", "createdBy", "assignee", "comments", "auditLogs"]);
  });
});

/**
 * The schema header claims books-and-records immutability is "enforced three ways": this extension,
 * the Postgres triggers, and REVOKE on the runtime role. G14 (guardrails.test.ts) checks the trigger
 * half. This is the other half of that claim — it reads the same triggers and asserts the extension
 * has not fallen behind them, so a new guarded table cannot ship with only two layers (and on a dev
 * machine whose DATABASE_URL owns the schema, only one).
 */
describe("booksAndRecords coverage tracks the migration triggers", () => {
  const migrationsDir = path.join(ROOT, "prisma/migrations");
  const allMigrationSql = readdirSync(migrationsDir)
    .filter((entry) => /^\d/.test(entry))
    .map((dir) => readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8"))
    .join("\n");

  const tablesMatching = (pattern: RegExp): string[] =>
    [...new Set([...allMigrationSql.matchAll(pattern)].map((m) => m[1]))].sort();

  /** BEFORE UPDATE OR DELETE → append-only: the row is written once and never touched again. */
  const APPEND_ONLY = tablesMatching(/BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+"([A-Za-z0-9_]+)"/g);
  /** BEFORE DELETE alone → a state table: it transitions, but no row is ever removed. */
  const NO_HARD_DELETE = tablesMatching(/BEFORE\s+DELETE\s+ON\s+"([A-Za-z0-9_]+)"/g).filter(
    (table) => !APPEND_ONLY.includes(table),
  );

  const APPEND_ONLY_OPS = ["update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"];
  const DELETE_OPS = ["delete", "deleteMany"];
  /** Table name → Prisma client model key: the generated client lower-cases the first letter. */
  const modelKey = (table: string) => table.charAt(0).toLowerCase() + table.slice(1);

  it("reads real triggers out of the migrations (the scan is not silently empty)", () => {
    expect(allMigrationSql.length).toBeGreaterThan(0);
    expect(APPEND_ONLY).toEqual(expect.arrayContaining(["AuditLog", "Comment", "IngestReceipt", "SlaAlert"]));
    expect(NO_HARD_DELETE).toEqual(
      expect.arrayContaining(["Attachment", "MessageDelivery", "SuspendedIntake", "Ticket"]),
    );
  });

  it("refuses in-app every operation the triggers refuse at the database", () => {
    const gaps: string[] = [];
    for (const [tables, required] of [
      [APPEND_ONLY, APPEND_ONLY_OPS],
      [NO_HARD_DELETE, DELETE_OPS],
    ] as const) {
      for (const table of tables) {
        const key = modelKey(table);
        const covered = BOOKS_AND_RECORDS_GUARDS[key];
        if (!covered) {
          gaps.push(`${table}: guarded by a trigger but absent from the booksAndRecords extension`);
          continue;
        }
        for (const op of required) {
          if (!covered.includes(op)) gaps.push(`${key}.${op}: trigger refuses it, the extension does not`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("guards nothing the database leaves mutable (JobCursor is a bookmark, not evidence)", () => {
    const guarded = new Set([...APPEND_ONLY, ...NO_HARD_DELETE].map(modelKey));
    const unexplained = Object.keys(BOOKS_AND_RECORDS_GUARDS).filter((key) => !guarded.has(key));
    expect(unexplained).toEqual([]);
    expect(Object.keys(BOOKS_AND_RECORDS_GUARDS)).not.toContain("jobCursor");
  });
});

describe("publicReadOnly extension (I1) — top-level isolation", () => {
  it("rejects every model other than Ticket / Comment", async () => {
    for (const run of [
      () => publicDb.user.findMany(),
      () => publicDb.queue.findFirst(),
      () => publicDb.auditLog.count(),
      () => publicDb.macro.findMany(),
      () => publicDb.sLA.findMany(),
      () => publicDb.account.findMany(),
    ]) {
      const e = await rejection(run);
      expect(e).toBeInstanceOf(IsolationViolationError);
      expect((e as Error).message).toMatch(/is not readable/);
    }
  });

  it("rejects every write operation on Ticket and Comment", async () => {
    const writes: Array<() => Promise<unknown>> = [
      () => publicDb.ticket.update({ where: { id: "x" }, data: { subject: "y" } }),
      () => publicDb.ticket.updateMany({ where: { id: "x" }, data: { subject: "y" } }),
      () => publicDb.ticket.delete({ where: { id: "x" } }),
      () => publicDb.ticket.deleteMany({}),
      () =>
        publicDb.ticket.create({
          data: {
            subject: "s",
            description: "d",
            requesterName: "r",
            requesterEmail: "r@x",
            category: "OTHER",
            priority: "LOW",
            slaFirstResponseMinutes: 1,
            slaResolutionMinutes: 2,
            firstResponseDueAt: new Date(),
            resolutionDueAt: new Date(),
            queue: { connect: { id: "q" } },
            createdBy: { connect: { id: "u" } },
          },
        }),
      () => publicDb.ticket.aggregate({ _count: true }),
      () => publicDb.ticket.groupBy({ by: ["status"] }),
      () =>
        publicDb.comment.create({
          data: { body: "b", visibility: "PUBLIC", ticket: { connect: { id: "t" } }, author: { connect: { id: "u" } } },
        }),
      () => publicDb.comment.update({ where: { id: "x" }, data: { body: "y" } }),
      () => publicDb.comment.delete({ where: { id: "x" } }),
      () => publicDb.comment.deleteMany({}),
      () => publicDb.comment.aggregate({ _count: true }),
    ];
    for (const run of writes) {
      const e = await rejection(run);
      expect(e).toBeInstanceOf(IsolationViolationError);
      expect((e as Error).message).toMatch(/is not allowed/);
    }
  });

  it("rejects ticket include", async () => {
    const e = await rejection(() => publicDb.ticket.findUnique({ where: { id: "x" }, include: { comments: true } }));
    expect(e).toBeInstanceOf(IsolationViolationError);
    expect((e as Error).message).toBe("publicDb: ticket include is not allowed");
  });

  it("rejects every relation key inside a ticket select", async () => {
    for (const key of TICKET_RELATION_KEYS) {
      const select = { id: true, [key]: true } as { id: true };
      const e = await rejection(() => publicDb.ticket.findUnique({ where: { id: "x" }, select }));
      expect(e).toBeInstanceOf(IsolationViolationError);
      expect((e as Error).message).toBe("publicDb: ticket relation select is not allowed");
    }
    const nested = await rejection(() =>
      publicDb.ticket.findMany({ select: { id: true, comments: { select: { body: true } } } }),
    );
    expect(nested).toBeInstanceOf(IsolationViolationError);
  });

  it("rejects comment include and comment relation selects", async () => {
    const inc = await rejection(() => publicDb.comment.findMany({ include: { author: true } }));
    expect(inc).toBeInstanceOf(IsolationViolationError);
    expect((inc as Error).message).toBe("publicDb: comment include is not allowed");
    for (const key of ["author", "ticket", "macro"] as const) {
      const select = { id: true, [key]: true } as { id: true };
      const e = await rejection(() => publicDb.comment.findMany({ select }));
      expect(e).toBeInstanceOf(IsolationViolationError);
      expect((e as Error).message).toBe("publicDb: comment relation select is not allowed");
    }
  });

  it("rejects $executeRaw / $executeRawUnsafe / $queryRawUnsafe", async () => {
    const exec = await rejection(() => publicDb.$executeRaw`SELECT 1`);
    expect(exec).toBeInstanceOf(IsolationViolationError);
    expect((exec as Error).message).toBe("publicDb: $executeRaw is not allowed");
    const execUnsafe = await rejection(() => publicDb.$executeRawUnsafe("SELECT 1"));
    expect(execUnsafe).toBeInstanceOf(IsolationViolationError);
    const queryUnsafe = await rejection(() => publicDb.$queryRawUnsafe("SELECT 1"));
    expect(queryUnsafe).toBeInstanceOf(IsolationViolationError);
    expect((queryUnsafe as Error).message).toBe("publicDb: $queryRawUnsafe is not allowed");
  });

  it("forces visibility PUBLIC into every comment read (observed through a stacked query hook)", async () => {
    let captured: unknown = null;
    // Prisma runs earlier-added query hooks first, so publicReadOnly rewrites `args` before this probe sees them.
    const probe = publicDb.$extends({
      query: {
        comment: {
          async findMany({ args }) {
            captured = args;
            return [];
          },
          async findFirst({ args }) {
            captured = args;
            return null;
          },
          async findUnique({ args }) {
            captured = args;
            return null;
          },
          async count({ args }) {
            captured = args;
            return 0;
          },
        },
        ticket: {
          async findUnique({ args }) {
            captured = args;
            return null;
          },
        },
      },
    });

    await probe.comment.findMany({ where: { ticketId: "t1" } });
    expect(captured).toEqual({ where: { AND: [{ ticketId: "t1" }, { visibility: "PUBLIC" }] } });

    await probe.comment.findMany();
    expect(captured).toEqual({ where: { AND: [{}, { visibility: "PUBLIC" }] } });

    await probe.comment.findMany({ where: { ticketId: "t1", visibility: "INTERNAL" } });
    expect(captured).toEqual({
      where: { AND: [{ ticketId: "t1", visibility: "INTERNAL" }, { visibility: "PUBLIC" }] },
    });

    await probe.comment.count({ where: { visibility: "INTERNAL" } });
    expect(captured).toEqual({ where: { AND: [{ visibility: "INTERNAL" }, { visibility: "PUBLIC" }] } });

    await probe.comment.findFirst({ where: { id: "c1" }, orderBy: { createdAt: "asc" } });
    expect(captured).toEqual({ where: { AND: [{ id: "c1" }, { visibility: "PUBLIC" }] }, orderBy: { createdAt: "asc" } });

    // Unique reads take the merged form (an AND-only unique `where` fails Prisma validation); PUBLIC still wins.
    await probe.comment.findUnique({ where: { id: "c1" } });
    expect(captured).toEqual({ where: { id: "c1", visibility: "PUBLIC" } });
    await probe.comment.findUnique({ where: { id: "c1", visibility: "INTERNAL" } });
    expect(captured).toEqual({ where: { id: "c1", visibility: "PUBLIC" } });

    // A scalar-only ticket read passes through untouched.
    await probe.ticket.findUnique({ where: { id: "t1" }, select: { id: true, subject: true } });
    expect(captured).toEqual({ where: { id: "t1" }, select: { id: true, subject: true } });
  });
});

describe("source and script scans", () => {
  const dbSource = readFileSync(path.join(ROOT, "src/lib/db.ts"), "utf8");

  it("db.ts constructs publicDb from its own PrismaClient (two constructions) and never logs statements", () => {
    expect(dbSource.match(/new PrismaClient\(/g)).toHaveLength(2);
    expect(dbSource).toContain("datasourceUrl");
    expect(dbSource).not.toMatch(/log:\s*\[[^\]]*["']query["']/);
    expect(dbSource).not.toMatch(/["']query["']\s*,?\s*\]/);
  });

  const migrationsDir = path.join(ROOT, "prisma/migrations");
  const auditMigrationDir = readdirSync(migrationsDir).find((d) => d.endsWith("_audit_immutability"));
  const migrationSql = auditMigrationDir
    ? readFileSync(path.join(migrationsDir, auditMigrationDir, "migration.sql"), "utf8")
    : "";

  it("the audit_immutability migration exists alongside init and the lock file", () => {
    expect(auditMigrationDir).toBeDefined();
    expect(readdirSync(migrationsDir).some((d) => d.endsWith("_init"))).toBe(true);
    expect(readFileSync(path.join(migrationsDir, "migration_lock.toml"), "utf8")).toContain('provider = "postgresql"');
    expect(auditMigrationDir! > readdirSync(migrationsDir).find((d) => d.endsWith("_init"))!).toBe(true);
  });

  it("migration SQL declares every §e trigger and the chain sequence", () => {
    // The trigger names the migration actually declares, read once with a LITERAL pattern. This
    // replaces a `new RegExp(`CREATE TRIGGER ${trigger}\\b`)` per name (security scanner CWE-185) and is stricter
    // than the word boundary was: membership of an exact-name set, not a prefix match.
    const declared = new Set([...migrationSql.matchAll(/CREATE TRIGGER ([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    for (const trigger of [
      "audit_log_chain_trg",
      "audit_log_no_update_delete",
      "audit_log_no_truncate",
      "comment_no_update_delete",
      "comment_no_truncate",
      "ticket_no_delete",
      "ticket_no_truncate",
    ]) {
      expect(declared, `${trigger} is not declared by the migration`).toContain(trigger);
    }
    expect(migrationSql).toContain("CREATE SEQUENCE IF NOT EXISTS audit_log_seq AS BIGINT START WITH 1 INCREMENT BY 1;");
    expect(migrationSql).toContain("pg_advisory_xact_lock(hashtext('AuditLog.chain'))");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON \"AuditLog\"");
    expect(migrationSql).toContain("BEFORE TRUNCATE ON \"AuditLog\"");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON \"Comment\"");
    expect(migrationSql).toContain("BEFORE DELETE ON \"Ticket\"");
    expect(migrationSql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM PUBLIC;');
    expect(migrationSql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "Comment" FROM PUBLIC;');
  });

  it("hash payload covers the 16 §e fields including actorGroups and userAgent, with \\x1f separators", () => {
    expect(migrationSql).toContain(`|| E'\\x1f' || COALESCE(array_to_string(NEW."actorGroups", ','), '')`);
    expect(migrationSql).toContain(`|| E'\\x1f' || COALESCE(NEW."userAgent", '');`);
    expect(migrationSql).toContain(`to_char(NEW."occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
    const payloadBlock = migrationSql.slice(migrationSql.indexOf('payload := NEW."prevHash"'), migrationSql.indexOf("NEW.hash :="));
    expect(payloadBlock.match(/E'\\x1f'/g)).toHaveLength(15);
    expect(payloadBlock).not.toContain('NEW."metadata"');
    expect(payloadBlock).not.toContain("NEW.id");
    expect(migrationSql).toContain("encode(sha256(convert_to(payload, 'UTF8')), 'hex')");
  });

  it("ClientVisibleComment view filters PUBLIC and exposes neither visibility nor authorId", () => {
    const start = migrationSql.indexOf('CREATE OR REPLACE VIEW "ClientVisibleComment"');
    expect(start).toBeGreaterThan(-1);
    const viewSql = migrationSql.slice(start, migrationSql.indexOf(";", start));
    expect(viewSql).toContain("WHERE c.visibility = 'PUBLIC'");
    const selectList = viewSql.slice(viewSql.indexOf("SELECT"), viewSql.indexOf("FROM"));
    expect(selectList).not.toContain("visibility");
    expect(selectList).not.toContain("authorId");
    expect(selectList).toContain("c.body");
    expect(selectList).toContain('c."disclaimerKey"');
  });

  it("runtime-roles.sql never grants ALL and never grants UPDATE/DELETE on AuditLog", () => {
    const script = readFileSync(path.join(ROOT, "prisma/sql/runtime-roles.sql"), "utf8");
    const sqlOnly = script
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    expect(sqlOnly).not.toMatch(/GRANT\s+ALL/i);
    const statements = sqlOnly.split(";").map((s) => s.trim());
    const auditGrants = statements.filter((s) => /^GRANT\b/i.test(s) && s.includes('"AuditLog"'));
    expect(auditGrants.length).toBeGreaterThan(0);
    for (const grant of auditGrants) {
      const privileges = grant.slice(0, grant.toUpperCase().indexOf(" ON ")).toUpperCase();
      expect(privileges).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|ALL)\b/);
    }
    expect(sqlOnly).toContain('GRANT SELECT, INSERT ON "AuditLog" TO wm_helpdesk_app');
    // The client-API role reads the view whole and "Ticket" column by column (guardrail G15 owns the
    // column list itself; this asserts the shape — a table-wide Ticket grant would fail here too).
    expect(sqlOnly).toContain('GRANT SELECT ON "ClientVisibleComment" TO wm_helpdesk_public');
    expect(sqlOnly).toContain('REVOKE ALL ON "Ticket" FROM wm_helpdesk_public');
    expect(sqlOnly).toMatch(/GRANT\s+SELECT\s*\([^)]*\)\s*\n?\s*ON\s+"Ticket"\s+TO\s+wm_helpdesk_public/);
    expect(sqlOnly).not.toMatch(/GRANT\s+SELECT\s+ON\s+"Ticket"[^;]*wm_helpdesk_public/);
    expect(sqlOnly).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "Comment" FROM wm_helpdesk_app');
    expect(sqlOnly).toContain('REVOKE DELETE, TRUNCATE ON "Ticket" FROM wm_helpdesk_app');
  });
});
