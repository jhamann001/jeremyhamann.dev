/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make every row written here permanent).
 *
 * Proves the auto-assignment QUERY against a real database. The ordering itself is pinned without a
 * database in `auto-assign.test.ts`; what needs a real schema is who the query finds.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT, because the test database is shared and permanent:
 *
 *  - **Every fixture is namespaced by run id** and every assertion is restricted to the ids this run
 *    created. A sibling file's advisor must not be able to win this file's rota and make an assertion
 *    pass for the wrong reason.
 *  - **`Queue.autoAssign` is flipped inside a transaction that is always rolled back.** There are
 *    exactly three queue rows in this schema (the key is a unique enum), so the switch cannot be
 *    namespaced — and committing it would turn auto-assignment on for every other file running at the
 *    same time. Rolling back means the flag is visible to `pickAutoAssignee` inside the transaction
 *    and to nobody else, ever.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const autoAssignModule = TEST_URL ? await import("@/server/auto-assign") : null;
const usersModule = TEST_URL ? await import("@/server/users") : null;

function mods() {
  if (!dbModule || !autoAssignModule || !usersModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...autoAssignModule, ...usersModule };
}

const RUN = randomUUID().slice(0, 8);
const LIGHT = `it_aa_light_${RUN}`;
const BUSY = `it_aa_busy_${RUN}`;
const AWAY = `it_aa_away_${RUN}`;
const GONE = `it_aa_gone_${RUN}`;
const WRONG_GROUP = `it_aa_wrong_${RUN}`;
const REQUESTER = `it_aa_requester_${RUN}`;
const REQUESTER_EMAIL = `aa.requester.${RUN}@wm-helpdesk.local`;

const MINE = [LIGHT, BUSY, AWAY, GONE, WRONG_GROUP, REQUESTER];

const NEW_TICKET = `it_aa_ticket_${RUN}`;
const ASSIGNED_TICKET = `it_aa_assigned_${RUN}`;
const BUSY_TICKET = `it_aa_busyload_${RUN}`;

/** Rolled back on purpose; carried by the one transaction that flips `Queue.autoAssign`. */
class Rollback extends Error {}

describe.skipIf(!TEST_URL)("auto-assignment (DB-gated)", () => {
  let adviceQueueId = "";

  beforeAll(async () => {
    const { prisma } = mods();
    const queue = await prisma.queue.upsert({
      where: { key: "ADVICE" },
      update: {},
      create: { key: "ADVICE", name: "Advice", description: "auto-assign fixture", sortOrder: 3 },
    });
    adviceQueueId = queue.id;

    const person = (id: string, over: Record<string, unknown> = {}) => ({
      where: { id },
      update: { isActive: true, groups: ["advisors" as const], outOfOfficeUntil: null, ...over },
      create: {
        id,
        email: `${id}@wm-helpdesk.local`,
        name: id,
        groups: ["advisors" as const],
        isActive: true,
        ...over,
      },
    });

    await prisma.user.upsert(person(LIGHT));
    await prisma.user.upsert(person(BUSY));
    await prisma.user.upsert(person(AWAY, { outOfOfficeUntil: new Date(Date.now() + 86_400_000) }));
    await prisma.user.upsert(person(GONE, { isActive: false }));
    await prisma.user.upsert(person(WRONG_GROUP, { groups: ["client_services" as const] }));
    await prisma.user.upsert({
      where: { id: REQUESTER },
      update: { isActive: true, groups: ["advisors"], outOfOfficeUntil: null, email: REQUESTER_EMAIL },
      create: { id: REQUESTER, email: REQUESTER_EMAIL, name: "Self service", groups: ["advisors"], isActive: true },
    });

    const ticket = (id: string, over: Record<string, unknown> = {}) => ({
      where: { id },
      update: {},
      create: {
        id,
        subject: `auto-assign fixture ${RUN}`,
        description: "auto-assign integration fixture (no PII)",
        requesterName: "Fixture Requester",
        requesterEmail: REQUESTER_EMAIL,
        category: "PLANNING_UPDATE" as const,
        priority: "LOW" as const,
        status: "NEW" as const,
        queueId: adviceQueueId,
        createdById: LIGHT,
        slaFirstResponseMinutes: 480,
        slaResolutionMinutes: 4320,
        firstResponseDueAt: new Date(Date.now() + 8 * 3_600_000),
        resolutionDueAt: new Date(Date.now() + 72 * 3_600_000),
        ...over,
      },
    });

    await prisma.ticket.upsert(ticket(NEW_TICKET));
    await prisma.ticket.upsert(ticket(ASSIGNED_TICKET, { assigneeId: GONE }));
    // Load for BUSY, so the rota has a reason to prefer LIGHT.
    await prisma.ticket.upsert(ticket(BUSY_TICKET, { assigneeId: BUSY, status: "OPEN" as const }));
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  /** Runs `fn` with ADVICE's auto-assign switched on, then rolls the switch back. */
  async function withAutoAssignOn<T>(fn: (tx: import("@/lib/db").DbTx) => Promise<T>): Promise<T> {
    const { prisma } = mods();
    let captured: T;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.queue.update({ where: { id: adviceQueueId }, data: { autoAssign: true } });
        captured = await fn(tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return captured!;
  }

  it("returns null while the queue's autoAssign is off — the shipped state of every queue", async () => {
    const { prisma, pickAutoAssignee } = mods();
    // The flag is SET to false inside the rolled-back transaction rather than read from the committed
    // row, so this file neither depends on nor disturbs whatever a concurrent file is doing with it.
    let picked: string | null = "unset";
    try {
      await prisma.$transaction(async (tx) => {
        await tx.queue.update({ where: { id: adviceQueueId }, data: { autoAssign: false } });
        picked = await pickAutoAssignee(tx, {
          queueKey: "ADVICE",
          queueId: adviceQueueId,
          ticketId: NEW_TICKET,
        });
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(picked).toBeNull();
  });

  it("picks the least-loaded eligible advisor once the queue is switched on", async () => {
    const { eligibleAssignees, pickFrom } = mods();
    const picked = await withAutoAssignOn(async (tx) => {
      const all = await eligibleAssignees(tx, "ADVICE", new Date(), REQUESTER_EMAIL);
      return { mine: all.filter((c) => MINE.includes(c.id)), winner: pickFrom(all.filter((c) => MINE.includes(c.id))) };
    });

    // Only the two eligible fixtures are in the rota: away, deactivated, wrong-group and the
    // requester themselves are all excluded.
    expect(picked.mine.map((c) => c.id).sort()).toEqual([BUSY, LIGHT].sort());
    expect(picked.winner).toBe(LIGHT);
    const busy = picked.mine.find((c) => c.id === BUSY);
    expect(busy?.openAssignments).toBeGreaterThanOrEqual(1);
    expect(picked.mine.find((c) => c.id === LIGHT)?.openAssignments).toBe(0);
  });

  it("never returns a machine identity", async () => {
    const { eligibleAssignees, MACHINE_ACTOR_EMAILS } = mods();
    const all = await withAutoAssignOn((tx) => eligibleAssignees(tx, "ADVICE", new Date()));
    const machine = MACHINE_ACTOR_EMAILS.map((e) => e.toLowerCase());
    expect(all.some((c) => machine.includes(c.email.toLowerCase()))).toBe(false);
  });

  it("excludes the requester's own account only when the ticket names them", async () => {
    const { eligibleAssignees } = mods();
    const withGuard = await withAutoAssignOn((tx) => eligibleAssignees(tx, "ADVICE", new Date(), REQUESTER_EMAIL));
    const withoutGuard = await withAutoAssignOn((tx) => eligibleAssignees(tx, "ADVICE", new Date()));
    expect(withGuard.map((c) => c.id)).not.toContain(REQUESTER);
    expect(withoutGuard.map((c) => c.id)).toContain(REQUESTER);
  });

  it("never overrides an assignee somebody already set — even a deactivated one", async () => {
    const { pickAutoAssignee } = mods();
    // ASSIGNED_TICKET is held by a deactivated account, which is the most tempting case to "fix"
    // silently. It is still an explicit assignment, and unpicking it belongs to a person.
    const picked = await withAutoAssignOn((tx) =>
      pickAutoAssignee(tx, { queueKey: "ADVICE", queueId: adviceQueueId, ticketId: ASSIGNED_TICKET }),
    );
    expect(picked).toBeNull();
  });

  it("assigns an unassigned ticket to the rota winner", async () => {
    const { pickAutoAssignee } = mods();
    const picked = await withAutoAssignOn((tx) =>
      pickAutoAssignee(tx, { queueKey: "ADVICE", queueId: adviceQueueId, ticketId: NEW_TICKET }),
    );
    // A sibling file could have a lighter advisor, so the assertion is the property that must hold:
    // whoever won is eligible, and it is never one of this run's excluded fixtures.
    expect(picked).not.toBeNull();
    expect([AWAY, GONE, WRONG_GROUP, REQUESTER]).not.toContain(picked);
  });

  it("returns null for a ticket that does not exist rather than throwing into an ingest", async () => {
    const { pickAutoAssignee } = mods();
    const picked = await withAutoAssignOn((tx) =>
      pickAutoAssignee(tx, { queueKey: "ADVICE", queueId: adviceQueueId, ticketId: `it_aa_missing_${RUN}` }),
    );
    expect(picked).toBeNull();
  });

  it("counts the rota per queue for /admin/sla without needing the switch on", async () => {
    const { eligibleAssigneeCounts } = mods();
    const counts = await eligibleAssigneeCounts(new Date());
    // This run added two eligible advisors (plus the requester, who is only excluded per ticket).
    expect(counts.ADVICE ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts.OPERATIONS ?? 0).toBeGreaterThanOrEqual(0);
  });
});
