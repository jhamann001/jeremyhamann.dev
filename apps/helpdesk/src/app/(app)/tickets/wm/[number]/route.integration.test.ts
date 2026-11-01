/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * The unit test beside this one proves the route hands `getTicketIdByNumber` the viewer's readable
 * queues. This one proves the resolver actually honours that scope against real rows: a number that
 * exists in ADVICE must be indistinguishable, to `client_services`, from a number that was never
 * issued. Both answers are `null`, which the route turns into the same 404.
 *
 * Fixtures are find-or-create and namespaced per run — rows in the test database are permanent by
 * design (the append-only triggers), so nothing here deletes anything.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readableQueues } from "@/lib/rbac";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const ticketsModule = TEST_URL ? await import("@/server/tickets") : null;

function mods() {
  if (!dbModule || !ticketsModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { prisma: dbModule.prisma, ...ticketsModule };
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_wm_user_${RUN}`;

let adviceNumber = 0;
let operationsNumber = 0;

async function seedTicket(queueKey: "OPERATIONS" | "ADVICE", suffix: string): Promise<number> {
  const { prisma } = mods();
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: queueKey } });
  const createdAt = new Date("2026-09-19T09:00:00.000Z");
  const t = await prisma.ticket.create({
    data: {
      id: `it_wm_ticket_${RUN}_${suffix}`,
      subject: `Deep link fixture ${suffix}`,
      description: "Fixture body",
      requesterName: "Margaret Thompson",
      requesterEmail: `wm.${RUN}.${suffix}@example.com`,
      category: "WIRE_TRANSFER",
      priority: "STANDARD",
      status: "OPEN",
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: USER_ID } },
      slaFirstResponseMinutes: 60,
      slaResolutionMinutes: 480,
      firstResponseDueAt: new Date(createdAt.getTime() + 60 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 480 * 60_000),
      createdAt,
    },
    select: { number: true },
  });
  return t.number;
}

describe.skipIf(!TEST_URL)("getTicketIdByNumber queue scope (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const [key, name, sortOrder] of [
      ["OPERATIONS", "Operations", 1],
      ["ADVICE", "Advice", 3],
    ] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name, description: "integration fixture", sortOrder },
      });
    }
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: {
        id: USER_ID,
        email: `${USER_ID}@wm-helpdesk.local`,
        name: "Deep Link Fixture",
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    adviceNumber = await seedTicket("ADVICE", "advice");
    operationsNumber = await seedTicket("OPERATIONS", "ops");
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("resolves a number inside the scope", async () => {
    const { getTicketIdByNumber } = mods();
    const id = await getTicketIdByNumber(operationsNumber, readableQueues(["client_services"]));
    expect(id).toBe(`it_wm_ticket_${RUN}_ops`);
  });

  it("returns null for a real ADVICE number when the scope excludes ADVICE", async () => {
    const { getTicketIdByNumber } = mods();
    expect(readableQueues(["client_services"])).not.toContain("ADVICE");
    const id = await getTicketIdByNumber(adviceNumber, readableQueues(["client_services"]));
    expect(id).toBeNull();
  });

  it("answers a real out-of-scope number and a number that was never issued identically", async () => {
    const { getTicketIdByNumber, prisma } = mods();
    const max = await prisma.ticket.aggregate({ _max: { number: true } });
    const neverIssued = (max._max.number ?? 0) + 5_000;

    const outOfScope = await getTicketIdByNumber(adviceNumber, readableQueues(["client_services"]));
    const missing = await getTicketIdByNumber(neverIssued, readableQueues(["client_services"]));

    expect(outOfScope).toBe(missing);
    expect(outOfScope).toBeNull();
  });

  it("resolves nothing at all for a viewer who reads no queue", async () => {
    const { getTicketIdByNumber } = mods();
    expect(readableQueues([])).toEqual([]);
    expect(await getTicketIdByNumber(operationsNumber, readableQueues([]))).toBeNull();
    expect(await getTicketIdByNumber(adviceNumber, readableQueues([]))).toBeNull();
  });

  it("still resolves across every queue when no scope is given (the contract's one-argument form)", async () => {
    const { getTicketIdByNumber } = mods();
    expect(await getTicketIdByNumber(adviceNumber)).toBe(`it_wm_ticket_${RUN}_advice`);
  });

  it("refuses a number that is not a positive safe integer before it queries", async () => {
    const { getTicketIdByNumber } = mods();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await getTicketIdByNumber(bad, readableQueues(["ops_team"]))).toBeNull();
    }
  });
});
