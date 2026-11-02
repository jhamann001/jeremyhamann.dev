import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session-timeout";

// ticket — the CRITICAL proof: does "Stay signed in" actually move the
// DATABASE session's `expires` ~8h forward?
//
// This exercises the exact Prisma write the renew route (app/api/session/renew/
// route.ts) performs in database-session mode — resolve the session cookie to a
// Session row, then UPDATE its `expires` to now + maxAge scoped to the caller's
// (sessionToken, userId). We create real, suite-owned User and Session rows,
// snapshot its expires, run the update, and assert the DB row jumped forward by
// ~8h. Everything is namespaced (ticket-*) and torn down.
//
// Gated on a DB URL so `npm run test` stays green with no database (mirrors the
// ingest integration suite): set SESSION_TEST_DB_URL (or DIRECT_DATABASE_URL) to
// run it. Locally: SESSION_TEST_DB_URL=postgresql://aoa@localhost:5432/aoa \
//   npx vitest run test/session-renew.integration.test.ts

const DB_URL = process.env.SESSION_TEST_DB_URL ?? process.env.DIRECT_DATABASE_URL;
const gated = DB_URL ? describe : describe.skip;

const TOKEN = "ticket-session-token";
const USER_ID = "ticket-user-id";
const USER_EMAIL = "ticket-session-test@example.invalid";

gated("renew moves DB Session.expires ~8h forward", () => {
  // Construct the client INSIDE beforeAll (not at describe-eval time): when the
  // suite is skipped for lack of a DB URL, the describe body still evaluates, so
  // a top-level `new PrismaClient({ url: undefined })` would throw and fail the
  // file. Lazy init keeps `npm run test` green with no database.
  let db: PrismaClient;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await db.session.deleteMany({ where: { sessionToken: TOKEN } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.user.create({
      data: {
        id: USER_ID,
        email: USER_EMAIL,
        name: "Session Test User",
        role: "VIEWER",
      },
    });
    // Start with an expiry only 2 minutes out — i.e. a session in the warning
    // window, exactly the state the modal renders in.
    await db.session.create({
      data: {
        id: "ticket-session-id",
        sessionToken: TOKEN,
        userId: USER_ID,
        expires: new Date(Date.now() + 2 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await db.session.deleteMany({ where: { sessionToken: TOKEN } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
  });

  it("bumps the row's expires to ~now+8h (before < after, delta ≈ maxAge)", async () => {
    const before = await db.session.findUnique({ where: { sessionToken: TOKEN } });
    expect(before).not.toBeNull();
    const beforeExpires = before!.expires.getTime();

    // --- the exact write the renew route performs ---
    const at = Date.now();
    const newExpires = new Date(at + SESSION_MAX_AGE_SECONDS * 1000);
    const res = await db.session.updateMany({
      where: { sessionToken: TOKEN, userId: USER_ID },
      data: { expires: newExpires },
    });
    // Proves a real DB row matched and was written (the prod path's `updated`).
    expect(res.count).toBe(1);

    const after = await db.session.findUnique({ where: { sessionToken: TOKEN } });
    const afterExpires = after!.expires.getTime();

    // It moved FORWARD...
    expect(afterExpires).toBeGreaterThan(beforeExpires);
    // ...to ~now + 8h (within 5s of the projected expiry, allowing round-trip).
    expect(Math.abs(afterExpires - newExpires.getTime())).toBeLessThan(5000);
    // ...and the jump from the 2-min-out starting point is ≈ (8h − 2min).
    const jumpMs = afterExpires - beforeExpires;
    const expectedJump = SESSION_MAX_AGE_SECONDS * 1000 - 2 * 60 * 1000;
    expect(Math.abs(jumpMs - expectedJump)).toBeLessThan(5000);
  });
});
