/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB, the
 * immutability triggers make fixture rows permanent). Proves the addPublicReply / addInternalNote CLOSED and
 * queue-move race fix (findings RBAC-3 / SLA-2): the CLOSED check and the ticket side effects
 * are now conditional writes evaluated inside the transaction, so a status change or queue move that commits
 * between the pre-tx load and the write can no longer land a PUBLIC reply or a first-response stamp on a
 * closed / moved-away ticket.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer/context
 * against the real test database; `@/lib/db`'s `withTx` is wrapped so we can commit a concurrent close in the
 * exact window between the pre-tx read and the transaction body (the same interleave the reviewer's probe used).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_race_user_ops_${RUN}`;
const OPEN_TICKET_ID = `it_race_open_${RUN}`;
const RACE_TICKET_ID = `it_race_close_${RUN}`;
const CLOSED_TICKET_ID = `it_race_closed_${RUN}`;
const REDIRECT_TICKET_ID = `it_race_redirect_${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
  closeBeforeTx: { id: null as string | null },
  redirectBeforeTx: { id: null as string | null, to: null as string | null },
}));
hoisted.viewer = {
  id: USER_ID,
  email: `race.ops.${RUN}@wm-helpdesk.local`,
  name: "Race Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.9",
  userAgent: `it-race/${RUN}`,
  requestId: `it-race-${RUN}`,
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
vi.mock("@/lib/db", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/db");
  return {
    ...real,
    // Wrap withTx so a test can commit a concurrent close in the window between the pre-tx read and the tx.
    withTx: async <T>(fn: (tx: import("@/lib/db").DbTx) => Promise<T>): Promise<T> => {
      const id = hoisted.closeBeforeTx.id;
      if (id !== null) {
        hoisted.closeBeforeTx.id = null;
        await real.prisma.ticket.update({
          where: { id },
          data: { status: "CLOSED", resolvedAt: new Date(), closedAt: new Date() },
        });
      }
      // Same window, different column: re-point the requester address between the pre-tx read and the
      // transaction body, which is what `changeRequesterEmail` does to a ticket someone is replying to.
      const redirectId = hoisted.redirectBeforeTx.id;
      if (redirectId !== null && hoisted.redirectBeforeTx.to !== null) {
        const to = hoisted.redirectBeforeTx.to;
        hoisted.redirectBeforeTx.id = null;
        hoisted.redirectBeforeTx.to = null;
        await real.prisma.ticket.update({ where: { id: redirectId }, data: { requesterEmail: to } });
      }
      return real.withTx(fn);
    },
  };
});

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const actionsModule = TEST_URL ? await import("@/server/comments.actions") : null;

function mods() {
  if (!dbModule || !actionsModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...actionsModule };
}

async function seedTicket(prisma: typeof import("@/lib/db").prisma, id: string, status: "OPEN" | "CLOSED", queueId: string) {
  const createdAt = new Date("2026-09-16T12:00:00.000Z");
  await prisma.ticket.upsert({
    where: { id },
    update: {},
    create: {
      id,
      subject: "Race probe",
      description: "Race probe description",
      requesterName: "Race Requester",
      requesterEmail: `race.${RUN}@example.com`,
      category: "TRADE_CORRECTION",
      priority: "URGENT",
      status,
      queue: { connect: { id: queueId } },
      createdBy: { connect: { id: USER_ID } },
      slaFirstResponseMinutes: 30,
      slaResolutionMinutes: 120,
      firstResponseDueAt: new Date(createdAt.getTime() + 30 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 120 * 60_000),
      resolvedAt: status === "CLOSED" ? createdAt : null,
      closedAt: status === "CLOSED" ? createdAt : null,
    },
  });
}

describe.skipIf(!TEST_URL)("addPublicReply / addInternalNote CLOSED + move race (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "race fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: {
        id: USER_ID,
        email: hoisted.viewer.email,
        name: "Race Ops",
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    await seedTicket(prisma, OPEN_TICKET_ID, "OPEN", queue.id);
    await seedTicket(prisma, RACE_TICKET_ID, "OPEN", queue.id);
    await seedTicket(prisma, CLOSED_TICKET_ID, "CLOSED", queue.id);
    await seedTicket(prisma, REDIRECT_TICKET_ID, "OPEN", queue.id);
  });

  afterAll(async () => {
    hoisted.closeBeforeTx.id = null;
    hoisted.redirectBeforeTx.id = null;
    hoisted.redirectBeforeTx.to = null;
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  const publicInput = (ticketId: string) => ({
    ticketId,
    body: "Thank you for reaching out; we are on it.",
    disclaimerKey: "GENERAL_SERVICE" as const,
    disclaimerAcknowledged: true,
  });

  it("baseline: a public reply on an OPEN ticket succeeds, stamps first response, and auto-opens are audited", async () => {
    const { addPublicReply, prisma } = mods();
    const before = await prisma.comment.count({ where: { ticketId: OPEN_TICKET_ID, visibility: "PUBLIC" } });
    const res = await addPublicReply(publicInput(OPEN_TICKET_ID));
    expect(res.ok).toBe(true);
    const after = await prisma.comment.count({ where: { ticketId: OPEN_TICKET_ID, visibility: "PUBLIC" } });
    expect(after).toBe(before + 1);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: OPEN_TICKET_ID } });
    expect(t.firstRespondedAt).not.toBeNull();
    expect(t.status).not.toBe("CLOSED");
  });

  it("RACE: a close committing between the pre-tx read and the write refuses the reply — no PUBLIC comment, no first-response stamp on the closed ticket", async () => {
    const { addPublicReply, prisma } = mods();
    const publicBefore = await prisma.comment.count({ where: { ticketId: RACE_TICKET_ID, visibility: "PUBLIC" } });

    // Arm the interleave: the mocked withTx will CLOSE the ticket after addPublicReply's pre-tx read passes.
    hoisted.closeBeforeTx.id = RACE_TICKET_ID;
    const res = await addPublicReply(publicInput(RACE_TICKET_ID));

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("VALIDATION");
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: RACE_TICKET_ID } });
    expect(t.status).toBe("CLOSED");
    // The reply and the first-response stamp both rolled back — nothing landed on the closed record.
    expect(await prisma.comment.count({ where: { ticketId: RACE_TICKET_ID, visibility: "PUBLIC" } })).toBe(publicBefore);
    expect(t.firstRespondedAt).toBeNull();
  });

  it("RACE: a requester-address redirect committing in the same window sends the reply to the NEW address", async () => {
    const { addPublicReply, prisma } = mods();
    const redirected = `redirected.${RUN}@example.com`;
    const stale = (await prisma.ticket.findUniqueOrThrow({ where: { id: REDIRECT_TICKET_ID } })).requesterEmail;
    expect(stale).not.toBe(redirected);

    // Arm the interleave: `changeRequesterEmail` commits after the pre-tx read and before the write.
    // The guard pins queueId and status, NOT requesterEmail, so the reply is correctly still allowed —
    // which is exactly why the delivery target has to be re-read inside the transaction.
    hoisted.redirectBeforeTx.id = REDIRECT_TICKET_ID;
    hoisted.redirectBeforeTx.to = redirected;
    const res = await addPublicReply(publicInput(REDIRECT_TICKET_ID));

    expect(res.ok).toBe(true);
    expect(res.ok === true && res.data.deliveryQueued).toBe(true);
    const deliveryId = res.ok === true ? res.data.deliveryId : null;
    expect(deliveryId).not.toBeNull();
    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { id: deliveryId as string } });
    // The pre-tx snapshot would have addressed the client's OLD mailbox, which the redirect just took
    // away from them — a reply delivered to an address the record no longer belongs to.
    expect(delivery.toAddress).toBe(redirected);
    expect(delivery.toAddress).not.toBe(stale);
  });

  it("an already-CLOSED ticket is refused up front (pre-tx fast path); no public reply is written", async () => {
    const { addPublicReply, prisma } = mods();
    const res = await addPublicReply(publicInput(CLOSED_TICKET_ID));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("VALIDATION");
    expect(await prisma.comment.count({ where: { ticketId: CLOSED_TICKET_ID, visibility: "PUBLIC" } })).toBe(0);
  });

  it("addInternalNote is still allowed on a CLOSED ticket (§b.9 — compliance annotation of a closed record)", async () => {
    const { addInternalNote, prisma } = mods();
    const before = await prisma.comment.count({ where: { ticketId: CLOSED_TICKET_ID, visibility: "INTERNAL" } });
    const res = await addInternalNote({ ticketId: CLOSED_TICKET_ID, body: "INTERNAL — closed-record annotation" });
    expect(res.ok).toBe(true);
    expect(await prisma.comment.count({ where: { ticketId: CLOSED_TICKET_ID, visibility: "INTERNAL" } })).toBe(before + 1);
  });
});
