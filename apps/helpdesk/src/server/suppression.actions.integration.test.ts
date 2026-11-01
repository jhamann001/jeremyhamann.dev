/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the no-delete triggers make fixture rows permanent).
 *
 * Proves live what only a real transaction can prove:
 *   - adding a suppression writes the row and its `SUPPRESSION_ADDED` row in one transaction, and
 *     adding the same live address twice writes no second ledger row;
 *   - removing is a SOFT remove with `SUPPRESSION_REMOVED` and a recorded reason, and the row survives;
 *   - re-adding a removed address updates the SAME row rather than inserting a second one, so there is
 *     exactly one live decision per address and the ledger carries the sequence;
 *   - `enqueueDelivery` refuses a suppressed destination: the comment still records, the delivery row
 *     is born `FAILED_SUPPRESSED`, and nothing is ever handed out for it;
 *   - a hard bounce is a CANDIDATE and nothing more until somebody confirms it.
 *
 * EVERY assertion is scoped to rows this run created, by a per-run marker: `wm_helpdesk_test` is
 * shared and permanent, and these files run concurrently.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer and
 * context against the real test database, exactly as `outbox.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_supp_user_${RUN}`;
const TICKET_ID = `it_supp_ticket_${RUN}`;
/** Every address this run touches carries the marker, so no other run's rows can match a query. */
const ADDRESS = `client.${RUN}@suppression.test`;
const BOUNCED_ADDRESS = `bounced.${RUN}@suppression.test`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: USER_ID,
  email: `supp.ops.${RUN}@wm-helpdesk.local`,
  name: "Suppression Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.44",
  userAgent: `it-suppression/${RUN}`,
  requestId: `it-suppression-${RUN}`,
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
const suppressionModule = TEST_URL ? await import("@/server/suppression.actions") : null;
const outboxModule = TEST_URL ? await import("@/server/outbox") : null;

function mods() {
  if (!dbModule || !suppressionModule || !outboxModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...suppressionModule, ...outboxModule };
}

type Prisma = typeof import("@/lib/db").prisma;

async function auditRows(prisma: Prisma, entityId: string) {
  return prisma.auditLog.findMany({
    where: { entityType: "SUPPRESSION", entityId },
    orderBy: { seq: "asc" },
    select: { action: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("suppression list (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "suppression fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, email: hoisted.viewer.email, name: "Suppression Ops", groups: ["ops_team"], isActive: true },
    });
    const createdAt = new Date("2026-09-17T12:00:00.000Z");
    await prisma.ticket.upsert({
      where: { id: TICKET_ID },
      update: {},
      create: {
        id: TICKET_ID,
        subject: "Suppression probe",
        description: "Suppression probe description",
        requesterName: "Suppression Requester",
        requesterEmail: ADDRESS,
        category: "OTHER",
        priority: "STANDARD",
        status: "OPEN",
        brand: "CEDAR_RIDGE_WEALTH",
        queue: { connect: { id: queue.id } },
        createdBy: { connect: { id: USER_ID } },
        slaFirstResponseMinutes: 30,
        slaResolutionMinutes: 120,
        firstResponseDueAt: new Date(createdAt.getTime() + 30 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 120 * 60_000),
      },
    });
  });

  it("adds a suppression with its SUPPRESSION_ADDED row in one transaction", async () => {
    const { prisma, addSuppression } = mods();
    const result = await addSuppression({ email: ADDRESS, reason: "MANUAL", note: "Client asked us to stop." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await prisma.requesterSuppression.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.email).toBe(ADDRESS);
    expect(row.reason).toBe("MANUAL");
    expect(row.removedAt).toBeNull();
    expect(row.createdById).toBe(USER_ID);

    const rows = await auditRows(prisma, result.data.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("SUPPRESSION_ADDED");
    expect(rows[0].fieldChanged).toBe("email");
    expect(rows[0].oldValue).toBeNull();
    expect(rows[0].newValue).toBe(ADDRESS);
    expect((rows[0].metadata as Record<string, unknown>).reason).toBe("MANUAL");
  });

  it("is a no-op when the same address is already live — no second ledger row", async () => {
    const { prisma, addSuppression } = mods();
    const first = await addSuppression({ email: ADDRESS, reason: "MANUAL" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const before = (await auditRows(prisma, first.data.id)).length;
    const again = await addSuppression({ email: ADDRESS, reason: "COMPLAINT", note: "different" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.id).toBe(first.data.id);
    expect(await auditRows(prisma, first.data.id)).toHaveLength(before);

    // The reason did NOT move either: an existing live decision is not silently re-characterised.
    const row = await prisma.requesterSuppression.findUniqueOrThrow({ where: { id: first.data.id } });
    expect(row.reason).toBe("MANUAL");
  });

  it("refuses to enqueue to a suppressed address: the row is born FAILED_SUPPRESSED and is never leased", async () => {
    const { prisma, withTx, enqueueDelivery, SUPPRESSED_DELIVERY_ERROR } = mods();

    const enqueued = await withTx(async (tx) => {
      const comment = await tx.comment.create({
        data: {
          ticketId: TICKET_ID,
          authorId: USER_ID,
          authorKind: "STAFF",
          visibility: "PUBLIC",
          body: `Suppressed reply ${RUN}`,
          disclaimerKey: "GENERAL_SERVICE",
        },
        select: { id: true },
      });
      return enqueueDelivery(tx, {
        ticketId: TICKET_ID,
        ticketNumber: 1,
        brand: "CEDAR_RIDGE_WEALTH",
        toAddress: ADDRESS,
        subject: "Suppression probe",
        commentId: comment.id,
        body: `Suppressed reply ${RUN}`,
      });
    });

    expect(enqueued.status).toBe("FAILED_SUPPRESSED");
    expect(enqueued.suppression).not.toBeNull();
    expect(enqueued.auditEntry.action).toBe("MESSAGE_FAILED");

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id: enqueued.deliveryId } });
    // The record of what the desk WOULD have sent is complete — only the state differs.
    expect(row.status).toBe("FAILED_SUPPRESSED");
    expect(row.lastError).toBe(SUPPRESSED_DELIVERY_ERROR);
    expect(row.textBody).toContain(`Suppressed reply ${RUN}`);
    expect(row.attempts).toBe(0);

    // And it is not a lease candidate, on this sweep or any other.
    //
    // Asserted as a SCOPED READ of this suite's own row rather than by calling
    // `leaseQueuedDeliveries`. The lease is a global FIFO with no filter, so leasing 50 rows here
    // reached across the shared test database and took whatever other suites had queued — including
    // `src/server/outbox.integration.test.ts`'s deliberately-oldest backdated row, whose retry test
    // then failed because its delivery had already been handed to this one. A test must not mutate
    // rows it did not create (shared convention 10), and "is it a candidate" is a question about THIS
    // row that does not need the queue to be drained to answer.
    //
    // The predicate is `leaseQueuedDeliveries`'s own candidate set, verbatim: QUEUED, or LEASED with
    // an expired lease. A FAILED_SUPPRESSED row is neither, which is the fact under test.
    const candidate = await prisma.messageDelivery.findFirst({
      where: {
        id: enqueued.deliveryId,
        OR: [{ status: "QUEUED" }, { status: "LEASED", leaseExpiresAt: { lte: new Date() } }],
      },
      select: { id: true },
    });
    expect(candidate, "a suppressed delivery must never be handed to the poller").toBeNull();
  });

  it("soft-removes with a recorded reason, and the row survives", async () => {
    const { prisma, addSuppression, removeSuppression } = mods();
    const added = await addSuppression({ email: ADDRESS, reason: "MANUAL" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const removed = await removeSuppression({
      suppressionId: added.data.id,
      reason: "Client confirmed the mailbox works on a recorded call",
    });
    expect(removed.ok).toBe(true);

    const row = await prisma.requesterSuppression.findUniqueOrThrow({ where: { id: added.data.id } });
    expect(row.removedAt).not.toBeNull();
    expect(row.removedById).toBe(USER_ID);

    const rows = await auditRows(prisma, added.data.id);
    const lift = rows.filter((r) => r.action === "SUPPRESSION_REMOVED");
    expect(lift).toHaveLength(1);
    expect(lift[0].oldValue).toBe(ADDRESS);
    expect(lift[0].newValue).toBeNull();
    expect((lift[0].metadata as Record<string, unknown>).reason).toContain("recorded call");
  });

  it("lifting twice writes no second ledger row", async () => {
    const { prisma, addSuppression, removeSuppression } = mods();
    const added = await addSuppression({ email: ADDRESS, reason: "MANUAL" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    await removeSuppression({ suppressionId: added.data.id, reason: "First lift, recorded properly" });
    const before = (await auditRows(prisma, added.data.id)).filter((r) => r.action === "SUPPRESSION_REMOVED").length;
    await removeSuppression({ suppressionId: added.data.id, reason: "Second lift, should be a no-op" });
    const after = (await auditRows(prisma, added.data.id)).filter((r) => r.action === "SUPPRESSION_REMOVED").length;
    expect(after).toBe(before);
  });

  it("re-adds a removed address by updating the SAME row, and says so in the ledger", async () => {
    const { prisma, addSuppression } = mods();
    const before = await prisma.requesterSuppression.count({ where: { email: ADDRESS } });
    expect(before).toBe(1);

    const again = await addSuppression({ email: ADDRESS, reason: "COMPLAINT", note: "Reported us again." });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(await prisma.requesterSuppression.count({ where: { email: ADDRESS } })).toBe(1);

    const row = await prisma.requesterSuppression.findUniqueOrThrow({ where: { id: again.data.id } });
    expect(row.removedAt).toBeNull();
    expect(row.reason).toBe("COMPLAINT");

    const rows = await auditRows(prisma, again.data.id);
    const last = rows[rows.length - 1];
    expect(last.action).toBe("SUPPRESSION_ADDED");
    expect((last.metadata as Record<string, unknown>).resuppressed).toBe(true);
  });

  it("offers a hard bounce as a candidate and suppresses nothing until it is confirmed", async () => {
    const { prisma, listSuppressionCandidates, confirmBounceSuppression } = mods();

    // A delivery that a DSN marked as hard-bounced, standing in for what `recordBounce` writes.
    await prisma.comment.create({
      data: {
        ticketId: TICKET_ID,
        authorId: USER_ID,
        authorKind: "STAFF",
        visibility: "PUBLIC",
        body: `Bounced reply ${RUN}`,
        disclaimerKey: "GENERAL_SERVICE",
        delivery: {
          create: {
            ticketId: TICKET_ID,
            brand: "CEDAR_RIDGE_WEALTH",
            fromAddress: "service@example.com",
            fromName: "Cedar Ridge Wealth Client Service",
            replyTo: "service@example.com",
            toAddress: BOUNCED_ADDRESS,
            subject: `[HD-1] Bounced probe ${RUN}`,
            textBody: "body",
            htmlBody: "<p>body</p>",
            messageId: `<wm.it_bounce_${RUN}.aa@example.com>`,
            status: "BOUNCED",
            bouncedAt: new Date(),
            bounceType: "hard",
          },
        },
      },
    });

    const before = await listSuppressionCandidates();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const candidate = before.data.find((c) => c.email === BOUNCED_ADDRESS);
    expect(candidate, "the hard bounce should be offered as a candidate").toBeDefined();
    expect(candidate?.bounces).toBeGreaterThanOrEqual(1);
    // Nothing was suppressed by the bounce itself.
    expect(await prisma.requesterSuppression.count({ where: { email: BOUNCED_ADDRESS } })).toBe(0);

    const confirmed = await confirmBounceSuppression({ email: BOUNCED_ADDRESS });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    const row = await prisma.requesterSuppression.findUniqueOrThrow({ where: { id: confirmed.data.id } });
    expect(row.reason).toBe("HARD_BOUNCE");
    expect(row.note).toContain("hard bounce");

    // Confirmed addresses drop off the candidate list — there is nothing left to decide.
    const after = await listSuppressionCandidates();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.some((c) => c.email === BOUNCED_ADDRESS)).toBe(false);
  });

  it("refuses to confirm an address with no recorded hard bounce", async () => {
    const { confirmBounceSuppression } = mods();
    const result = await confirmBounceSuppression({ email: `never.bounced.${RUN}@suppression.test` });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("VALIDATION");
  });

  it("lists this run's rows through listSuppressions", async () => {
    const { listSuppressions } = mods();
    const result = await listSuppressions();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mine = result.data.filter((s) => s.email.includes(RUN));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const row of mine) {
      expect(row.createdBy?.id).toBe(USER_ID);
    }
  });
});
