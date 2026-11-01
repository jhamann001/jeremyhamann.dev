// @vitest-environment node
import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDemoData } from "./seed";
import { loadUniverse } from "./universe";

// The nightly reset against real PostgreSQL, made to fail part-way. Nothing it does may outlive the
// rollback, the fee store's id sequence included: setval() is not transactional, so a sequence moved
// that way stays moved while yesterday's rows come back, and a later insert can collide on "id". Run in
// CI on the job's own Postgres (ACAT_SEED_DATABASE_TEST=1). The reset never commits here, so the shared
// test database keeps every row the other suites made.
const enabled = process.env.ACAT_SEED_DATABASE_TEST === "1";
const NOW = new Date("2026-10-27T15:00:00Z");
const INJECTED = "Injected failure after the fee store's sequence step";

interface SequenceState { last_value: bigint; is_called: boolean }
type Raw = Pick<PrismaClient, "$queryRawUnsafe">;

const sequenceState = async (db: Raw) =>
  (await db.$queryRawUnsafe<SequenceState[]>(`SELECT last_value, is_called FROM "DemoFeeCreditRow_id_seq"`))[0];
const nextId = (s: SequenceState) => Number(s.last_value) + (s.is_called ? 1 : 0);

/**
 * The real client, except that the reset's transaction throws straight after the statement that moves
 * the fee store's sequence, once `onStep` has looked inside it. If the reset ever stops reaching that
 * statement, the transaction still throws before it can commit.
 */
function failingAfterSequenceStep(onStep: (tx: Prisma.TransactionClient) => Promise<void>): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop !== "$transaction") return Reflect.get(target, prop);
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) =>
        target.$transaction(async (tx) => {
          const watched = new Proxy(tx, {
            get(t, p) {
              if (p !== "$executeRawUnsafe") {
                const value = Reflect.get(t, p);
                return typeof value === "function" ? value.bind(t) : value;
              }
              return async (sql: string, ...values: unknown[]) => {
                const result = await t.$executeRawUnsafe(sql, ...values);
                if (!sql.includes(`pg_get_serial_sequence('"DemoFeeCreditRow"'`)) return result;
                await onStep(t);
                throw new Error(INJECTED);
              };
            },
          });
          await fn(watched);
          throw new Error("The reset never reached the fee store's sequence step");
        }, options);
    },
  });
}

describe.skipIf(!enabled)("demo reset against PostgreSQL", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Seed tests require an explicit localhost transfer_tracker_test database");
    }
  });

  it("leaves the fee store's sequence where it was when the reset fails after moving it", async () => {
    // Hand out one id first, so the reset's restart can never leave the sequence as it found it by chance.
    await prisma.$queryRawUnsafe(`SELECT nextval(pg_get_serial_sequence('"DemoFeeCreditRow"', 'id'))`);
    const before = await sequenceState(prisma);
    const rowsBefore = await prisma.demoFeeCreditRow.count();

    let during: SequenceState | undefined;
    let seededMax: number | null = null;
    const failing = failingAfterSequenceStep(async (tx) => {
      during = await sequenceState(tx);
      const [{ max }] = await tx.$queryRawUnsafe<{ max: number | null }[]>(`SELECT max("id") AS max FROM "DemoFeeCreditRow"`);
      seededMax = max;
    });
    await expect(resetDemoData(failing, loadUniverse(), NOW)).rejects.toThrow(INJECTED);

    // Inside the transaction the step moved the sequence past the seeded ids, with the usual floor.
    expect(during).toBeDefined();
    expect(during).not.toEqual(before);
    expect(nextId(during!)).toBe(Math.max(seededMax ?? 0, 1000) + 1);
    // After the rollback, the sequence and the rows it numbers are both as they were.
    expect(await sequenceState(prisma)).toEqual(before);
    expect(await prisma.demoFeeCreditRow.count()).toBe(rowsBefore);
  }, 120_000);
});
