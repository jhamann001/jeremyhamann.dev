import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { operationIsInTransaction } from "@/lib/db";

// ticket — the guard the unit tests CAN'T give us: prove `operationIsInTransaction`
// still reads a LIVE transaction correctly against the real @prisma/client
// runtime. It depends on Prisma's private, untyped `__internalParams.transaction`
// field; a Prisma upgrade that renamed/removed it would make the helper silently
// return `false`, re-enabling retries inside withUserScope's SET LOCAL RLS
// transaction (the exact hole PR #93 closes). A hand-shaped unit-test object
// can't catch that — only the real engine can. So here we attach a probe
// extension that records `operationIsInTransaction(params)` for each op, then run
// one op top-level and one inside `$transaction`, and assert the flag flips.
//
// Gated on a DB URL so `npm run test` stays green with no database (mirrors the
// session-renew + ingest integration suites): set SESSION_TEST_DB_URL (or
// DIRECT_DATABASE_URL) to run it. Locally:
//   SESSION_TEST_DB_URL=postgresql://aoa@localhost:5432/aoa \
//     npx vitest run test/db-retry-transaction.integration.test.ts

const DB_URL = process.env.SESSION_TEST_DB_URL ?? process.env.DIRECT_DATABASE_URL;
const gated = DB_URL ? describe : describe.skip;

// A factory so `probed` gets Prisma's concrete extended-client type by inference
// (annotating it as ReturnType<PrismaClient["$extends"]> collapses the $-methods
// to `unknown`). The probe records, per op, whether the helper saw a transaction.
function buildProbe(client: PrismaClient, seen: boolean[]) {
  return client.$extends({
    name: "probe-in-transaction",
    query: {
      async $allOperations(params) {
        seen.push(operationIsInTransaction(params));
        const { args, query } = params;
        return query(args);
      },
    },
  });
}

gated("operationIsInTransaction detects a live Prisma transaction", () => {
  const seen: boolean[] = [];
  let db: PrismaClient;
  let probed: ReturnType<typeof buildProbe>;

  beforeAll(() => {
    // Lazy init (see session-renew.integration.test.ts): the describe body still
    // evaluates when skipped, so constructing the client here keeps a no-DB run
    // from throwing.
    db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    probed = buildProbe(db, seen);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("reads false top-level and true inside $transaction (real runtime)", async () => {
    // Top-level raw read → not in a transaction.
    seen.length = 0;
    await probed.$queryRaw`SELECT 1`;
    expect(seen).toContain(false);
    expect(seen).not.toContain(true);

    // Same op inside an interactive transaction → the flag MUST flip to true. If
    // this fails after a Prisma upgrade, the __internalParams.transaction field
    // moved — fix operationIsInTransaction() in lib/db.ts BEFORE shipping, or the
    // retry will start firing inside withUserScope and break RLS scoping.
    seen.length = 0;
    await probed.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
    });
    expect(seen).toContain(true);
  });
});
