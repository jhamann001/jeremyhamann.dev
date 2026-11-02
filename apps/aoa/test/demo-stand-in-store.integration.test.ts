// The stand-ins' store on real PostgreSQL, under the app login: records are added, read in order and changed under
// a row lock, never removed. Runs only against a loopback database with the owner cleanup URL set (the database job's
// settings).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
import { prisma } from "@/lib/db";
import { STAND_IN_KIND_CAP, changeRecord, listRecords, readRecord, saveRecord } from "@/lib/demo/stand-ins/store";

const RUN = process.env.DATABASE_URL && process.env.AUDIT_TEST_CLEANUP_URL ? describe : describe.skip;
const KIND = "s4_integration";
// The database's own ceiling (migration 20261107120000_demo_stand_in_bounds).
const MAX_ROWS = 4000;
const MAX_BYTES = 16 * 1024 * 1024;

function loopback(raw: string, user: string): string {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== user) {
    throw new Error("loopback_stand_in_store_database_required");
  }
  return raw;
}

RUN("demo stand-in store under the app login", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    loopback(process.env.DATABASE_URL!, "app_rw");
    owner = new PrismaClient({ datasourceUrl: loopback(process.env.AUDIT_TEST_CLEANUP_URL!, "aoa") });
  });
  afterAll(async () => {
    if (owner) await owner.$executeRaw`DELETE FROM demo.stand_in_record WHERE kind LIKE ${`${KIND}%`}`;
    await Promise.all([owner?.$disconnect(), prisma.$disconnect()]);
  });

  it("adds records in order, replaces one by id and reads them back", async () => {
    await saveRecord("tracker", KIND, "b", { n: 1 });
    await saveRecord("tracker", KIND, "a", { n: 2 });
    await saveRecord("tracker", KIND, "b", { n: 3 });
    expect((await listRecords<{ n: number }>("tracker", KIND)).map((r) => [r.id, r.doc.n])).toEqual([["b", 3], ["a", 2]]);
    expect((await readRecord<{ n: number }>("tracker", KIND, "a"))?.doc).toEqual({ n: 2 });
    expect(await readRecord("tracker", KIND, "missing")).toBeNull();
  });

  it("serializes concurrent changes to one record", async () => {
    await saveRecord("pipeline", KIND, "counter", { n: 0 });
    await Promise.all(Array.from({ length: 8 }, () =>
      changeRecord<{ n: number }>("pipeline", KIND, "counter", (d) => ({ n: d.n + 1 }))));
    expect((await readRecord<{ n: number }>("pipeline", KIND, "counter"))?.doc.n).toBe(8);
    expect(await changeRecord("pipeline", KIND, "missing", () => ({}))).toBeNull();
  });

  it("can't remove a record, or file one under a service the demo doesn't stand in for", async () => {
    await expect(prisma.$executeRaw`DELETE FROM demo.stand_in_record WHERE kind = ${KIND}`).rejects.toThrow(/permission denied/);
    await expect(prisma.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc) VALUES ('crm', ${KIND}, 'x', '{}'::jsonb)`).rejects.toThrow(/check constraint/);
  });

  it("adds no new record past a kind's cap, but still replaces one, and reads at most the cap", async () => {
    const kind = `${KIND}_cap`;
    await owner.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc, position)
      SELECT 'tracker', ${kind}, 'r' || g, '{}'::jsonb, g FROM generate_series(1, ${STAND_IN_KIND_CAP}::integer) g`;
    expect(await saveRecord("tracker", kind, "one-more", { n: 1 })).toBe("full");
    expect(await readRecord("tracker", kind, "one-more")).toBeNull();
    expect(await saveRecord("tracker", kind, "r1", { n: 1 })).toBe("saved");
    expect((await readRecord<{ n: number }>("tracker", kind, "r1"))?.doc).toEqual({ n: 1 });
    expect(await saveRecord("pipeline", kind, "another-service", { n: 1 })).toBe("saved");
    await owner.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc, position) VALUES ('tracker', ${kind}, 'past-the-cap', '{}'::jsonb, 0)`;
    expect(await listRecords("tracker", kind)).toHaveLength(STAND_IN_KIND_CAP);
    await owner.$executeRaw`DELETE FROM demo.stand_in_record WHERE kind = ${kind}`;
  }, 60_000);

  it("refuses rows past the table's row ceiling, whoever writes, and keeps replacing", async () => {
    const kind = `${KIND}_rows`;
    const [{ held }] = await owner.$queryRaw<Array<{ held: bigint }>>`SELECT count(*) AS held FROM demo.stand_in_record`;
    await owner.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc, position)
      SELECT 'warehouse', ${kind}, 'r' || g, '{}'::jsonb, g FROM generate_series(1, ${MAX_ROWS - Number(held)}::integer) g`;
    await expect(prisma.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc) VALUES ('warehouse', ${kind}, 'one-more', '{}'::jsonb)`)
      .rejects.toThrow(/at most 4000 stand-in records/);
    await expect(owner.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc) VALUES ('warehouse', ${kind}, 'one-more', '{}'::jsonb)`)
      .rejects.toThrow(/at most 4000 stand-in records/);
    expect(await saveRecord("warehouse", kind, "r1", { n: 2 })).toBe("saved");
    expect(await changeRecord<{ n?: number }>("warehouse", kind, "r2", () => ({ n: 3 }))).toEqual({ n: 3 });
    await owner.$executeRaw`DELETE FROM demo.stand_in_record WHERE kind = ${kind}`;
  }, 60_000);

  it("refuses an insert or a change that would take the table past its size ceiling", async () => {
    const kind = `${KIND}_bytes`;
    // About 250 KB of JSON a row that compression can't shrink much, just under the per-row limit.
    const big = (seed: number) => owner.$executeRaw`
      INSERT INTO demo.stand_in_record (service, kind, id, doc)
      SELECT 'warehouse', ${kind}, ${`big-${seed}`},
             jsonb_build_object('blob', (SELECT string_agg(md5(${seed}::text || ':' || g), '') FROM generate_series(1, 7800) g))`;
    let stored = 0;
    let refusal: unknown = null;
    for (let i = 0; i < 80 && !refusal; i++) {
      try {
        await big(i);
        stored += 1;
      } catch (error) {
        refusal = error;
      }
    }
    expect(String(refusal)).toMatch(/at most 16777216 bytes of stand-in records/);
    const [{ bytes }] = await owner.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT sum(pg_column_size(doc)) AS bytes FROM demo.stand_in_record`;
    expect(Number(bytes)).toBeLessThanOrEqual(MAX_BYTES);
    expect(stored).toBeGreaterThan(30);
    // Growing a small record past the ceiling is refused too; shrinking one is not.
    await saveRecord("warehouse", kind, "small", { n: 1 });
    await expect(changeRecord("warehouse", kind, "small", () => ({ blob: "x".repeat(250_000) }))).rejects.toThrow(/bytes of stand-in records/);
    expect(await changeRecord("warehouse", kind, "big-0", () => ({ n: 0 }))).toEqual({ n: 0 });
    await owner.$executeRaw`DELETE FROM demo.stand_in_record WHERE kind = ${kind}`;
  }, 120_000);
});
