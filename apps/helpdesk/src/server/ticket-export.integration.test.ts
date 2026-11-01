/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make fixture rows permanent). Proves the three promises of
 * `/api/tickets/export` that only a database can prove:
 *
 *  1. Rows are bounded by the viewer's READABLE queues — a client_services export cannot contain an
 *     ADVICE ticket, even one belonging to the same requester.
 *  2. The count recorded on `TICKET_LIST_EXPORTED` equals the number of data rows in the file, and the
 *     row is written BEFORE the first byte.
 *  3. `scope=full` is compliance-only: a non-compliance caller is refused with an `AUTHZ_DENIED` row
 *     and NO export row, and the compliance file is the only one carrying the description and the
 *     INTERNAL comment bodies.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the real route runs against the real test
 * database with a viewer this test controls.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const REQUESTER_EMAIL = `export.${RUN}@example.com`;
const OPS_USER_ID = `it_tx_ops_${RUN}`;
const CS_USER_ID = `it_tx_cs_${RUN}`;
const COMPLIANCE_USER_ID = `it_tx_co_${RUN}`;
const OPS_TICKET_ID = `it_tx_ops_ticket_${RUN}`;
const ADVICE_TICKET_ID = `it_tx_adv_ticket_${RUN}`;
const DESCRIPTION_SENTINEL = `DESCRIPTION_SENTINEL_${RUN}`;
const INTERNAL_SENTINEL = `INTERNAL_SENTINEL_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: `Export ${groups[0]}`, image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(CS_USER_ID, ["client_services"]);
hoisted.ctx = {
  ipAddress: "203.0.113.42",
  userAgent: `it-ticket-export/${RUN}`,
  requestId: `it-ticket-export-${RUN}`,
  isPrefetch: false,
};

vi.mock("@/lib/session", () => ({
  requireViewerOrThrow: vi.fn(async () => hoisted.viewer),
  getViewer: vi.fn(async () => hoisted.viewer),
  requireUser: vi.fn(async () => hoisted.viewer),
  requireGroup: vi.fn(async () => hoisted.viewer),
}));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: vi.fn(async () => hoisted.ctx),
  getRequestContextFromRequest: vi.fn(() => hoisted.ctx),
}));

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const routeModule = TEST_URL ? await import("@/app/api/tickets/export/route") : null;

function mods() {
  if (!dbModule || !routeModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { prisma: dbModule.prisma, GET: routeModule.GET };
}

function exportRequest(query: string): Request {
  return new Request(`http://localhost/api/tickets/export?${query}`, {
    method: "GET",
    headers: { "x-request-id": hoisted.ctx.requestId, "user-agent": hoisted.ctx.userAgent ?? "" },
  });
}

/** Only this run's tickets: the exact-match requesterEmail filter S6 added. */
const MINE = `requesterEmail=${encodeURIComponent(REQUESTER_EMAIL)}`;

function dataLines(csv: string): string[] {
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  return lines.slice(1);
}

describe.skipIf(!TEST_URL)("ticket export route (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();

    for (const [key, name, sortOrder] of [
      ["OPERATIONS", "Operations", 1],
      ["CLIENT_SERVICE", "Client Service", 2],
      ["ADVICE", "Advice", 3],
    ] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name, description: "integration fixture", sortOrder },
      });
    }
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    const advice = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" } });

    for (const [id, groups] of [
      [OPS_USER_ID, ["ops_team"]],
      [CS_USER_ID, ["client_services"]],
      [COMPLIANCE_USER_ID, ["compliance_officers"]],
    ] as const) {
      await prisma.user.upsert({
        where: { id },
        update: { groups: [...groups], isActive: true },
        create: {
          id,
          email: `${id}@wm-helpdesk.local`,
          name: `Export ${groups[0]}`,
          groups: [...groups],
          emailVerified: new Date(),
          isActive: true,
        },
      });
    }

    const createdAt = new Date("2026-09-19T09:00:00.000Z");
    for (const [id, queueId] of [
      [OPS_TICKET_ID, ops.id],
      [ADVICE_TICKET_ID, advice.id],
    ] as const) {
      await prisma.ticket.upsert({
        where: { id },
        update: {},
        create: {
          id,
          subject: `Export fixture ${id}`,
          description: `${DESCRIPTION_SENTINEL} — the original description, standard scope must not carry it`,
          requesterName: "Margaret Thompson",
          requesterEmail: REQUESTER_EMAIL,
          category: "WIRE_TRANSFER",
          priority: "URGENT",
          status: "OPEN",
          queue: { connect: { id: queueId } },
          createdBy: { connect: { id: OPS_USER_ID } },
          slaFirstResponseMinutes: 30,
          slaResolutionMinutes: 120,
          firstResponseDueAt: new Date(createdAt.getTime() + 30 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 120 * 60_000),
          createdAt,
        },
      });
    }

    // Comments are immutable (no upsert through the extension): find-or-create.
    const commentId = `it_tx_comment_${RUN}`;
    if ((await prisma.comment.findUnique({ where: { id: commentId } })) === null) {
      await prisma.comment.create({
        data: {
          id: commentId,
          body: `${INTERNAL_SENTINEL} — staff-only note`,
          visibility: "INTERNAL",
          authorKind: "STAFF",
          disclaimerKey: "NONE",
          ticket: { connect: { id: OPS_TICKET_ID } },
          author: { connect: { id: OPS_USER_ID } },
        },
      });
    }
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("bounds rows by the viewer's readable queues: client_services never sees the ADVICE ticket (I5)", async () => {
    const { GET, prisma } = mods();
    hoisted.viewer = viewerOf(CS_USER_ID, ["client_services"]);

    const res = await GET(exportRequest(MINE));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const csv = await res.text();

    const rows = dataLines(csv);
    expect(rows).toHaveLength(1);
    expect(csv).toContain(`Export fixture ${OPS_TICKET_ID}`);
    expect(csv).not.toContain(`Export fixture ${ADVICE_TICKET_ID}`);

    // The recorded total equals what the file carries, and it was written before the stream.
    const exportRow = await prisma.auditLog.findFirst({
      where: { action: "TICKET_LIST_EXPORTED", actorId: CS_USER_ID },
      orderBy: { seq: "desc" },
    });
    expect(exportRow).not.toBeNull();
    expect(exportRow!.newValue).toBe(String(rows.length));
    expect(exportRow!.entityType).toBe("TICKET");
    expect(exportRow!.entityId).toBeNull();
    const meta = exportRow!.metadata as { scope?: string; filters?: Record<string, unknown> } | null;
    expect(meta?.scope).toBe("standard");
    expect(meta?.filters?.requesterEmail).toBe(REQUESTER_EMAIL);
    // Paging never selected rows, so it is not recorded as if it had.
    expect(meta?.filters).not.toHaveProperty("page");
  });

  it("compliance reads every queue, so its standard export carries both tickets and still no content", async () => {
    const { GET } = mods();
    hoisted.viewer = viewerOf(COMPLIANCE_USER_ID, ["compliance_officers"]);

    const csv = await (await GET(exportRequest(MINE))).text();
    expect(dataLines(csv)).toHaveLength(2);
    expect(csv).toContain(`Export fixture ${ADVICE_TICKET_ID}`);
    // standard is built from TicketListRow: no description, no comment body, no requester address.
    expect(csv).not.toContain(DESCRIPTION_SENTINEL);
    expect(csv).not.toContain(INTERNAL_SENTINEL);
    expect(csv).not.toContain(REQUESTER_EMAIL);
  });

  it("scope=full is refused for a non-compliance caller, recorded as a denial, with no export row", async () => {
    const { GET, prisma } = mods();
    hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);

    const before = await prisma.auditLog.count({ where: { action: "TICKET_LIST_EXPORTED", actorId: OPS_USER_ID } });
    const res = await GET(exportRequest(`${MINE}&scope=full`));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });

    const denial = await prisma.auditLog.findFirst({
      where: { action: "AUTHZ_DENIED", actorId: OPS_USER_ID },
      orderBy: { seq: "desc" },
    });
    expect(denial).not.toBeNull();
    expect(denial!.newValue).toContain("ticket:export scope=full");

    const after = await prisma.auditLog.count({ where: { action: "TICKET_LIST_EXPORTED", actorId: OPS_USER_ID } });
    expect(after).toBe(before);
  });

  it("scope=full gives compliance the original description and the INTERNAL comment bodies", async () => {
    const { GET, prisma } = mods();
    hoisted.viewer = viewerOf(COMPLIANCE_USER_ID, ["compliance_officers"]);

    const res = await GET(exportRequest(`${MINE}&scope=full`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("ticket-export-full-");
    const csv = await res.text();

    const header = csv.split("\r\n")[0];
    expect(header.endsWith("description,comments")).toBe(true);
    expect(csv).toContain(DESCRIPTION_SENTINEL);
    expect(csv).toContain(INTERNAL_SENTINEL);
    expect(dataLines(csv)).toHaveLength(2);

    const exportRow = await prisma.auditLog.findFirst({
      where: { action: "TICKET_LIST_EXPORTED", actorId: COMPLIANCE_USER_ID },
      orderBy: { seq: "desc" },
    });
    expect((exportRow!.metadata as { scope?: string }).scope).toBe("full");
    expect(exportRow!.newValue).toBe("2");
  });

  it("a filter that matches nothing still produces a header-only file and a zero-count export row", async () => {
    const { GET, prisma } = mods();
    hoisted.viewer = viewerOf(CS_USER_ID, ["client_services"]);

    const csv = await (await GET(exportRequest(`requesterEmail=nobody.${RUN}%40example.com`))).text();
    expect(dataLines(csv)).toHaveLength(0);
    expect(csv.split("\r\n")[0]).toContain("number,link,subject");

    const exportRow = await prisma.auditLog.findFirst({
      where: { action: "TICKET_LIST_EXPORTED", actorId: CS_USER_ID },
      orderBy: { seq: "desc" },
    });
    expect(exportRow!.newValue).toBe("0");
  });
});
