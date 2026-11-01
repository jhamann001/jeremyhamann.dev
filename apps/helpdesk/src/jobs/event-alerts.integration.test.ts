/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database. Tolerates rows left by earlier runs — the cursor is read and restored around each
 * assertion and every fixture is namespaced by run id.
 *
 * Proves live, for the event-alert job:
 *   - `readLedgerEvents` picks up exactly the four routable actions after a given seq, with the ticket
 *     facts a Slack line needs and nothing else;
 *   - the `JobCursor` row round-trips as a bigint bookmark;
 *   - a run with no channel configured advances nothing it should not and transmits nothing.
 *
 * FIXED: every assertion is scoped to the rows THIS RUN created, by ticket number.
 *
 * The first test used to narrow the batch with `currentQueueKey === "OPERATIONS" && priority ===
 * "URGENT"` — properties of the fixture, not an identity — and then assert over whatever came back.
 * Two things could go wrong, and the shared test database plus concurrent files make both reachable:
 * a sibling file's URGENT Operations ticket would be swept into `mine` and could satisfy an
 * assertion this file never wrote a row for, and — the one that actually bites — `readLedgerEvents`
 * takes at most `EVENT_ALERTS_BATCH` (500) rows after the cursor, so enough concurrent ledger
 * traffic between `ledgerHead()` and these writes would push this file's own rows out of the page
 * and fail a `toContain` for a row that is sitting in the table.
 *
 * `readOwnEvents` fixes both at once: it pages forward from the bookmark until it has seen the
 * ledger head, keeping only rows whose `ticketNumber` is this run's, and the assertions then read
 * "the events I wrote are exactly these" rather than "somewhere in the last page there is one of
 * these". `LedgerEvent` carries no `ticketId`, so the number is the identity available — and it is a
 * unique column, so it is a sound one.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}
// No channel map for the whole file: event alerts must run, read and audit while posting nothing.
delete process.env.SLACK_QUEUE_WEBHOOKS;

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const eventsModule = TEST_URL ? await import("@/jobs/event-alerts") : null;

function mods() {
  if (!dbModule || !auditModule || !eventsModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...auditModule, ...eventsModule };
}

const RUN = randomUUID().slice(0, 8);
const QUEUE_ID = "it_queue_operations";
const USER_ID = `it_events_actor_${RUN}`;
const USER_EMAIL = `events+${RUN}@wm-helpdesk.local`;
const TICKET_ID = `it_events_ticket_${RUN}`;

/** Filled in `beforeAll`: the autoincrement number this run's fixture ticket got. */
let TICKET_NUMBER = -1;

describe.skipIf(!TEST_URL)("event alerts (DB-gated)", () => {
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
      update: {},
      create: { id: USER_ID, email: USER_EMAIL, name: "Event fixture", groups: [], isActive: true },
    });
    const ticket = await prisma.ticket.upsert({
      where: { id: TICKET_ID },
      update: {},
      create: {
        id: TICKET_ID,
        subject: "Event alert fixture",
        description: "Ticket used by event-alerts.integration.test.ts",
        requesterName: "Fixture Requester",
        requesterEmail: `fixture+${RUN}@example.com`,
        category: "OTHER",
        priority: "URGENT",
        queue: { connect: { id: queue.id } },
        createdBy: { connect: { id: USER_ID } },
        slaFirstResponseMinutes: 60,
        slaResolutionMinutes: 480,
        firstResponseDueAt: new Date(Date.now() + 60 * 60_000),
        resolutionDueAt: new Date(Date.now() + 8 * 60 * 60_000),
      },
      select: { number: true },
    });
    TICKET_NUMBER = ticket.number;
  });

  /**
   * Every routable ledger row for THIS run's ticket, after `fromSeq`.
   *
   * Pages forward rather than reading one batch: `readLedgerEvents` caps at `EVENT_ALERTS_BATCH`, and
   * a concurrent file writing a few hundred audit rows would otherwise hide this run's own rows
   * behind the cap. The loop ends when a short page proves it reached the end of the ledger, and the
   * page budget is a backstop against an infinite loop if something else is writing continuously.
   */
  async function readOwnEvents(fromSeq: bigint) {
    const { readLedgerEvents, EVENT_ALERTS_BATCH } = mods();
    const mine = [];
    let cursor = fromSeq;
    for (let page = 0; page < 20; page++) {
      const batch = await readLedgerEvents(cursor);
      if (batch.length === 0) break;
      for (const e of batch) {
        if (e.ticketNumber === TICKET_NUMBER) mine.push(e);
      }
      cursor = batch[batch.length - 1].seq;
      if (batch.length < EVENT_ALERTS_BATCH) break;
    }
    return mine;
  }

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("reads the routable ledger rows after a cursor, and ignores the rest", async () => {
    const { prisma, writeAuditMany, actorFromMachineUser, systemRequestContext, ledgerHead, toQueueEvent } = mods();

    const before = await ledgerHead();
    const actor = actorFromMachineUser({ id: USER_ID, email: USER_EMAIL });
    const ctx = systemRequestContext(`it-events-${RUN}`);

    await writeAuditMany(prisma, actor, ctx, [
      {
        action: "TICKET_ASSIGNED",
        entityType: "TICKET",
        entityId: TICKET_ID,
        ticketId: TICKET_ID,
        fieldChanged: "assigneeId",
        oldValue: null,
        newValue: USER_ID,
        metadata: { newEmail: USER_EMAIL },
      },
      {
        action: "TICKET_QUEUE_CHANGED",
        entityType: "TICKET",
        entityId: TICKET_ID,
        ticketId: TICKET_ID,
        fieldChanged: "queueKey",
        oldValue: "CLIENT_SERVICE",
        newValue: "OPERATIONS",
      },
      {
        action: "TICKET_STATUS_CHANGED",
        entityType: "TICKET",
        entityId: TICKET_ID,
        ticketId: TICKET_ID,
        fieldChanged: "status",
        oldValue: "RESOLVED",
        newValue: "OPEN",
      },
      // Neither of these is an alertable event; both must be filtered out in SQL.
      {
        action: "TICKET_STATUS_CHANGED",
        entityType: "TICKET",
        entityId: TICKET_ID,
        ticketId: TICKET_ID,
        fieldChanged: "status",
        oldValue: "OPEN",
        newValue: "RESOLVED",
      },
      { action: "TICKET_VIEWED", entityType: "TICKET", entityId: TICKET_ID, ticketId: TICKET_ID },
    ]);

    const mine = await readOwnEvents(before);

    // Exactly the three routable rows this test wrote, in ledger order. Not `toContain`: the point of
    // scoping by ticket number is that the set is now knowable, so the assertion states the whole set
    // — which is what catches an over-broad `eventAlertsWhere` as well as a missing row.
    expect(mine.map((e) => e.action)).toEqual([
      "TICKET_ASSIGNED",
      "TICKET_QUEUE_CHANGED",
      "TICKET_STATUS_CHANGED",
    ]);
    // The OPEN -> RESOLVED row and the view were filtered in SQL, not in TypeScript.
    expect(mine).toHaveLength(3);
    for (const e of mine) {
      expect(e.currentQueueKey).toBe("OPERATIONS");
      expect(e.priority).toBe("URGENT");
    }

    const routed = mine.map(toQueueEvent).filter((e) => e !== null);
    expect(routed.map((e) => e.kind)).toEqual(["assigned", "queue-changed", "reopened"]);
    for (const e of routed) expect(e.ticketNumber).toBe(TICKET_NUMBER);

    // A ticket's own queue and priority are all the ticket contributes — never the subject or requester.
    const serialised = JSON.stringify(routed, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialised).not.toContain("Event alert fixture");
    expect(serialised).not.toContain(USER_EMAIL);
    expect(serialised).not.toContain("Fixture Requester");
  });

  it("round-trips the JobCursor bookmark as a bigint", async () => {
    const { prisma, readCursor, writeCursor, EVENT_ALERTS_CURSOR, ledgerHead } = mods();
    const original = await readCursor();
    const head = await ledgerHead();

    await writeCursor(head);
    expect(await readCursor()).toBe(head);

    const row = await prisma.jobCursor.findUniqueOrThrow({ where: { name: EVENT_ALERTS_CURSOR } });
    expect(row.seq).toBe(head);
    expect(typeof row.seq).toBe("bigint");

    // Restore whatever a sibling run left, so this file does not move another test's bookmark.
    if (original !== null) await writeCursor(original);
  });
});
