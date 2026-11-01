/**
 * The demo reset against a real Postgres. Three claims the nightly reset rests on:
 *   - the app role, which the container connects as, can do none of what the reset does;
 *   - a reset leaves a desk whose ledger verifies from GENESIS, with every trigger live again;
 *   - a reset that fails part-way leaves the previous desk exactly as it was, sequences included.
 *
 * Runs only with HELPDESK_RESET_DATABASE_TEST=1, TEST_DATABASE_URL (the owner, on a THROWAWAY database:
 * every test here empties it) and TEST_APP_DATABASE_URL (the same database as wm_helpdesk_app, with
 * prisma/sql/runtime-roles.sql applied).
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/lib/db";
import { loadUniverse } from "../src/lib/demo/universe";
import type { Universe } from "../src/lib/demo/universe";

const enabled =
  process.env.HELPDESK_RESET_DATABASE_TEST === "1" && !!process.env.TEST_DATABASE_URL && !!process.env.TEST_APP_DATABASE_URL;

type ResetModule = typeof import("./demo-reset");
type SeedModule = typeof import("./seed-dev");

describe.skipIf(!enabled)("demo reset (database)", () => {
  let owner: Db;
  let app: PrismaClient;
  let reset: ResetModule;
  let seed: SeedModule;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    ({ prisma: owner } = await import("../src/lib/db"));
    reset = await import("./demo-reset");
    seed = await import("./seed-dev");
    app = new PrismaClient({ datasourceUrl: process.env.TEST_APP_DATABASE_URL });
    await reset.runDemoReset(owner);
  }, 120_000);

  afterAll(async () => {
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  const triggersOff = async (): Promise<number> => {
    const rows = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND NOT g.tgisinternal AND g.tgenabled <> 'O'`;
    return Number(rows[0]?.n ?? -1);
  };
  const sequences = async () =>
    owner.$queryRaw<Array<{ audit: bigint; ticket: bigint }>>`
      SELECT (SELECT last_value FROM audit_log_seq) AS audit, (SELECT last_value FROM "Ticket_number_seq") AS ticket`;

  it("refuses the app role every step of the wipe, and the wipe itself", async () => {
    for (const sql of [
      'ALTER TABLE "AuditLog" DISABLE TRIGGER USER',
      "SET session_replication_role = replica",
      'TRUNCATE "AuditLog"',
      'TRUNCATE "Ticket"',
      'DELETE FROM "AuditLog"',
      "ALTER SEQUENCE audit_log_seq RESTART WITH 1",
      "SELECT setval('audit_log_seq', 1, false)",
      reset.WIPE_SQL,
    ]) {
      await expect(app.$executeRawUnsafe(sql), sql.slice(0, 60)).rejects.toThrow();
    }
    // Still there, untouched, and readable by the role that was refused.
    expect(await app.auditLog.count()).toBeGreaterThan(0);
    expect(await triggersOff()).toBe(0);
  });

  it("leaves a desk whose ledger verifies from GENESIS, with every trigger live again", async () => {
    const result = await reset.runDemoReset(owner);
    expect(result.tickets).toBeGreaterThan(150);
    expect(result.attachments).toBe(3);

    const chain = await seed.verifyWholeChain(owner);
    expect(chain).toMatchObject({ ok: true, checked: result.auditRows });
    const first = await owner.auditLog.findFirst({ orderBy: { seq: "asc" }, select: { seq: true, prevHash: true } });
    expect(first).toEqual({ seq: BigInt(1), prevHash: "GENESIS" });
    expect(await triggersOff()).toBe(0);

    // The append-only triggers bind the owner again: a story ticket and a ledger row cannot be removed.
    await expect(owner.$executeRawUnsafe('DELETE FROM "Ticket" WHERE "number" = 2479')).rejects.toThrow();
    await expect(owner.$executeRawUnsafe('UPDATE "AuditLog" SET "action" = "action" WHERE seq = 1')).rejects.toThrow();

    // The app sees the same desk, and the next ticket number follows the seeded ones.
    expect(await app.ticket.count()).toBe(result.tickets);
    const [seqs] = await sequences();
    expect(Number(seqs?.ticket)).toBe(result.numbers.last + 1);
  }, 120_000);

  it("rolls back a reset that fails after the wipe, leaving the previous desk and its sequences", async () => {
    const snapshot = async () => ({
      tickets: await owner.ticket.count(),
      comments: await owner.comment.count(),
      audit: await owner.auditLog.count(),
      lastHash: (await owner.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { hash: true } }))?.hash,
      sequences: await sequences(),
    });
    const before = await snapshot();
    expect(before.tickets).toBeGreaterThan(0);

    // A universe whose story names a person who does not exist: the seed throws after the wipe ran.
    const universe = loadUniverse();
    const broken: Universe = {
      ...universe,
      stories: {
        ...universe.stories,
        helpdesk: universe.stories.helpdesk.map((s) => (s.id === "HD-2463" ? { ...s, requester: "Nobody Here" } : s)),
      },
    };
    await expect(reset.runDemoReset(owner, { universe: broken })).rejects.toThrow(/no person named Nobody Here/);

    expect(await snapshot()).toEqual(before);
    expect(await triggersOff()).toBe(0);
    expect((await seed.verifyWholeChain(owner)).ok).toBe(true);
  }, 120_000);
});
