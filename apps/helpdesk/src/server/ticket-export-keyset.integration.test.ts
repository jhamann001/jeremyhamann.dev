/**
 * DB-gated (TEST_DATABASE_URL only — the immutability triggers make fixture rows permanent by design).
 *
 * Proves the one property a keyset export exists for and that the module previously CLAIMED without
 * having: a ticket that is written to while the file is streaming is emitted exactly once.
 *
 * The walk used to be ordered on `(updatedAt, id)`. `updatedAt` moves on every comment, assignment and
 * status change, so any ticket the walk had already passed jumped back ahead of the cursor the moment
 * an agent touched it and came out of the file a SECOND time — on a busy desk, continuously, for the
 * length of a several-thousand-row export. The audited `TICKET_LIST_EXPORTED` count could then be
 * smaller than the file it describes, which for a compliance artefact is the defect: the ledger row is
 * the evidence of what left the building. The walk is now ordered on `number`, which nothing updates.
 *
 * Two cases, both driven through the real iterator with a page size of 1 so the interleaving is exact:
 *  1. a ticket ALREADY EMITTED is touched mid-walk — it must not reappear;
 *  2. a ticket NOT YET REACHED is touched mid-walk — it must still appear, exactly once.
 * Plus the third leg the route depends on: a ticket created after the count is outside the export's
 * `createdAt <= now` bound, so the file cannot carry a row the ledger never counted.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OktaGroup, TicketListQuery, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const REQUESTER_EMAIL = `keyset.${RUN}@example.com`;
const OPS_USER_ID = `it_ks_ops_${RUN}`;
const TICKET_IDS = [1, 2, 3, 4].map((n) => `it_ks_ticket_${n}_${RUN}`);

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const exportModule = TEST_URL ? await import("@/server/ticket-export") : null;

function mods() {
  if (!dbModule || !exportModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { prisma: dbModule.prisma, ...exportModule };
}

function viewerOf(groups: OktaGroup[]): Viewer {
  return { id: OPS_USER_ID, email: `${OPS_USER_ID}@wm-helpdesk.local`, name: "Keyset Ops", image: null, groups, isDev: false };
}

const VIEWER = viewerOf(["compliance_officers"]);
/** Exact-match requester filter: this run's four tickets and nothing else in a shared test database. */
const QUERY = { requesterEmail: REQUESTER_EMAIL } as unknown as TicketListQuery;

/** Drain the iterator one page at a time, running `between` after each page. */
async function collect(
  iterator: AsyncGenerator<{ id: string }[]>,
  between?: (pageIndex: number) => Promise<void>,
): Promise<string[]> {
  const seen: string[] = [];
  let page = 0;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return seen;
    for (const row of next.value) seen.push(row.id);
    await between?.(page);
    page++;
  }
}

describe.skipIf(!TEST_URL)("ticket export keyset stability (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();

    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });

    await prisma.user.upsert({
      where: { id: OPS_USER_ID },
      update: { groups: ["compliance_officers"], isActive: true },
      create: {
        id: OPS_USER_ID,
        email: `${OPS_USER_ID}@wm-helpdesk.local`,
        name: "Keyset Ops",
        groups: ["compliance_officers"],
        emailVerified: new Date(),
        isActive: true,
      },
    });

    const createdAt = new Date("2026-09-19T09:00:00.000Z");
    // Created in order, so `number` ascends with the array: the walk's order is known up front.
    for (const id of TICKET_IDS) {
      await prisma.ticket.upsert({
        where: { id },
        update: {},
        create: {
          id,
          subject: `Keyset fixture ${id}`,
          description: "keyset fixture",
          requesterName: "Margaret Thompson",
          requesterEmail: REQUESTER_EMAIL,
          category: "WIRE_TRANSFER",
          priority: "STANDARD",
          status: "OPEN",
          queue: { connect: { id: ops.id } },
          createdBy: { connect: { id: OPS_USER_ID } },
          slaFirstResponseMinutes: 30,
          slaResolutionMinutes: 120,
          firstResponseDueAt: new Date(createdAt.getTime() + 30 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 120 * 60_000),
          createdAt,
        },
      });
    }
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("emits every matching ticket exactly once, in ticket-number order", async () => {
    const { iterateExportRows, countExportRows } = mods();
    const now = new Date();

    const total = await countExportRows(VIEWER, QUERY, now);
    const seen = await collect(iterateExportRows(VIEWER, QUERY, 1, now));

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...TICKET_IDS].sort());
  });

  it("a ticket touched AFTER it was emitted does not come out of the file a second time", async () => {
    const { iterateExportRows, countExportRows, prisma } = mods();
    const now = new Date();
    const total = await countExportRows(VIEWER, QUERY, now);

    // After the first page, bump the updatedAt of the ticket that page just emitted — exactly what a
    // comment, an assignment or a status change does to a row the walk has already passed.
    const touched: string[] = [];
    const seen = await collect(iterateExportRows(VIEWER, QUERY, 1, now), async (page) => {
      if (page !== 0) return;
      const first = await prisma.ticket.findUniqueOrThrow({ where: { id: TICKET_IDS[0] } });
      await prisma.ticket.update({
        where: { id: first.id },
        data: { escalationTarget: first.escalationTarget === "NONE" ? "COMPLIANCE" : "NONE" },
      });
      touched.push(first.id);
    });

    expect(touched).toEqual([TICKET_IDS[0]]);
    expect(seen.filter((id) => id === TICKET_IDS[0])).toHaveLength(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(total);
  });

  it("a ticket touched BEFORE the walk reaches it is still emitted, exactly once", async () => {
    const { iterateExportRows, countExportRows, prisma } = mods();
    const now = new Date();
    const total = await countExportRows(VIEWER, QUERY, now);

    const last = TICKET_IDS[TICKET_IDS.length - 1];
    const seen = await collect(iterateExportRows(VIEWER, QUERY, 1, now), async (page) => {
      if (page !== 0) return;
      const row = await prisma.ticket.findUniqueOrThrow({ where: { id: last } });
      await prisma.ticket.update({
        where: { id: last },
        data: { escalationTarget: row.escalationTarget === "NONE" ? "COMPLIANCE" : "NONE" },
      });
    });

    expect(seen.filter((id) => id === last)).toHaveLength(1);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("a ticket created after the count is outside the export's bound, so the file cannot exceed it", async () => {
    const { iterateExportRows, countExportRows, prisma } = mods();
    const now = new Date();
    const total = await countExportRows(VIEWER, QUERY, now);

    const lateId = `it_ks_late_${RUN}`;
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.ticket.create({
      data: {
        id: lateId,
        subject: `Keyset fixture ${lateId}`,
        description: "created after the count",
        requesterName: "Margaret Thompson",
        requesterEmail: REQUESTER_EMAIL,
        category: "WIRE_TRANSFER",
        priority: "STANDARD",
        status: "OPEN",
        queue: { connect: { id: ops.id } },
        createdBy: { connect: { id: OPS_USER_ID } },
        slaFirstResponseMinutes: 30,
        slaResolutionMinutes: 120,
        firstResponseDueAt: new Date(now.getTime() + 30 * 60_000),
        resolutionDueAt: new Date(now.getTime() + 120 * 60_000),
      },
    });

    const seen = await collect(iterateExportRows(VIEWER, QUERY, 1, now));
    expect(seen).not.toContain(lateId);
    expect(seen).toHaveLength(total);

    // ...and a LATER export, whose `now` is after that ticket existed, does carry it.
    const later = new Date();
    expect(await countExportRows(VIEWER, QUERY, later)).toBe(total + 1);
    expect(await collect(iterateExportRows(VIEWER, QUERY, 1, later))).toContain(lateId);
  });
});
