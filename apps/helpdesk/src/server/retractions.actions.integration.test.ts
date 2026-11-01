/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB;
 * `CommentRetraction` is append-only at the database, so every row written here is permanent).
 *
 * Proves comment retraction:
 *
 *  - One transaction writes `CommentRetraction`, `COMMENT_RETRACTED`, and — when there is a QUEUED
 *    delivery — the `CANCELLED` transition plus `MESSAGE_CANCELLED`.
 *  - **The comment row is never touched**: the body, its macro and its timestamps are identical
 *    before and after, because a staff surface has to be able to read what the desk actually sent.
 *  - A SENT delivery is NOT cancelled and the result says so, so no UI can claim mail was unsent.
 *  - The `ClientVisibleComment` view blanks the body and reports `retracted = true` — the client role
 *    cannot reach the withdrawn text at the privilege layer, not merely at the render layer.
 *  - A second retraction is a CONFLICT, enforced by the UNIQUE on `commentId` rather than by a read.
 *  - INTERNAL notes and a requester's own message are refused.
 *  - A reason under twelve characters is refused in the app, before the DB CHECK sees it.
 *  - `queue:write` is required and every refusal is in the ledger.
 *
 * Every assertion is scoped to rows this run created.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult, OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_retract_ops_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: "Olivia Ops", image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(OPS_ID, ["ops_team"]);
hoisted.ctx = {
  ipAddress: "203.0.113.44",
  userAgent: `it-retract/${RUN}`,
  requestId: `it-retract-${RUN}`,
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
const retractions = TEST_URL ? await import("@/server/retractions.actions") : null;
const commentActions = TEST_URL ? await import("@/server/comments.actions") : null;
const commentReads = TEST_URL ? await import("@/server/comments") : null;

function mods() {
  if (!dbModule || !retractions || !commentActions || !commentReads) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { prisma: dbModule.prisma, ...retractions, ...commentActions, ...commentReads };
}

function ok<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data;
}

const REASON = "sent to the wrong ticket — the settlement date quoted was incorrect";

let seq = 0;

async function newTicket(opts: { requesterEmail?: string | null } = {}): Promise<string> {
  const { prisma } = mods();
  const id = `it_retract_ticket_${RUN}_${seq++}`;
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
  const createdAt = new Date("2026-09-19T09:00:00.000Z");
  await prisma.ticket.create({
    data: {
      id,
      subject: `Retraction fixture ${id}`,
      description: "A ticket for the retraction tests.",
      requesterName: "Margaret Thompson",
      requesterEmail: opts.requesterEmail === undefined ? `retract.${id}@example.com` : opts.requesterEmail,
      requesterPhone: opts.requesterEmail === null ? "+1 555 0100" : null,
      category: "ACAT",
      priority: "STANDARD",
      status: "OPEN",
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: OPS_ID } },
      slaFirstResponseMinutes: 240,
      slaResolutionMinutes: 1440,
      firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      createdAt,
    },
    select: { id: true },
  });
  return id;
}

async function auditFor(entityId: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, entityId },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("comment retraction (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "retraction fixture", sortOrder: 1 },
    });
    await prisma.user.upsert({
      where: { id: OPS_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: {
        id: OPS_ID,
        email: `${OPS_ID}@wm-helpdesk.local`,
        name: "Olivia Ops",
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
  });

  it("writes the retraction, the audit row and the delivery cancellation in one transaction", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "Your funds settled on Tuesday.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );
    expect(reply.deliveryQueued).toBe(true);

    const result = ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));
    expect(result.deliveryCancelled).toBe(true);

    const row = await prisma.commentRetraction.findUniqueOrThrow({ where: { commentId: reply.id } });
    expect(row.reason).toBe(REASON);
    expect(row.retractedById).toBe(OPS_ID);

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: reply.id } });
    expect(delivery.status).toBe("CANCELLED");
    expect(delivery.cancelledAt).not.toBeNull();

    const commentRows = await auditFor(reply.id);
    const retracted = commentRows.find((r) => r.action === "COMMENT_RETRACTED");
    expect(retracted).toMatchObject({ entityType: "COMMENT", fieldChanged: "body", oldValue: null, newValue: "withdrawn" });
    expect((retracted?.metadata as { reason?: string })?.reason).toBe(REASON);

    const deliveryRows = await auditFor(delivery.id);
    expect(deliveryRows.find((r) => r.action === "MESSAGE_CANCELLED")).toMatchObject({
      entityType: "MESSAGE_DELIVERY",
      fieldChanged: "status",
      oldValue: "QUEUED",
      newValue: "CANCELLED",
    });
  });

  it("never touches the comment row itself (I8)", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "The original wording, preserved.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );
    const before = await prisma.comment.findUniqueOrThrow({ where: { id: reply.id } });

    ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));

    const after = await prisma.comment.findUniqueOrThrow({ where: { id: reply.id } });
    expect(after).toEqual(before);
    expect(after.body).toContain("The original wording, preserved.");
  });

  it("shows staff the original with the retraction attached", async () => {
    const { addPublicReply, retractComment, listComments } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "Struck through, still readable.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );
    ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));

    const comments = await listComments(hoisted.viewer, ticketId, hoisted.ctx);
    const dto = comments.find((c) => c.id === reply.id);
    expect(dto?.body).toContain("Struck through, still readable.");
    expect(dto?.retraction).toMatchObject({ reason: REASON });
    expect(dto?.retraction?.retractedBy.id).toBe(OPS_ID);
  });

  it("blanks the body in the CLIENT view and reports retracted = true", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "The client must not be able to reach this.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );

    const beforeRows = await prisma.$queryRaw<
      Array<{ body: string; retracted: boolean }>
    >`SELECT body, retracted FROM "ClientVisibleComment" WHERE id = ${reply.id}`;
    expect(beforeRows[0]?.retracted).toBe(false);
    expect(beforeRows[0]?.body).toContain("must not be able to reach this");

    ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));

    const afterRows = await prisma.$queryRaw<
      Array<{ body: string; retracted: boolean }>
    >`SELECT body, retracted FROM "ClientVisibleComment" WHERE id = ${reply.id}`;
    expect(afterRows[0]?.retracted).toBe(true);
    // Blanked at the DATABASE: unreachable, not merely unrendered.
    expect(afterRows[0]?.body).toBe("");
  });

  it("does not claim to unsend a delivery that has already gone", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "Already in their inbox.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );
    await prisma.messageDelivery.update({
      where: { commentId: reply.id },
      data: { status: "SENT", sentAt: new Date() },
    });

    const result = ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));
    expect(result.deliveryCancelled).toBe(false);

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: reply.id } });
    expect(delivery.status).toBe("SENT");
    expect(delivery.cancelledAt).toBeNull();
    // And no row claims a cancellation that did not happen.
    expect((await auditFor(delivery.id)).some((r) => r.action === "MESSAGE_CANCELLED")).toBe(false);
  });

  it("withdraws a reply on a phone-only ticket, which never had a delivery at all", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket({ requesterEmail: null });
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "A desk record with nowhere to go.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );
    expect(reply.deliveryQueued).toBe(false);

    const result = ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));
    expect(result.deliveryCancelled).toBe(false);
    expect(await prisma.commentRetraction.count({ where: { commentId: reply.id } })).toBe(1);
  });

  it("refuses a second withdrawal as a CONFLICT", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "Withdrawn once.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );
    ok(await retractComment({ commentId: reply.id, reason: REASON, confirm: true }));

    const second = await retractComment({ commentId: reply.id, reason: `${REASON} (again)`, confirm: true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("CONFLICT");
    expect(await prisma.commentRetraction.count({ where: { commentId: reply.id } })).toBe(1);
  });

  it("refuses an INTERNAL note — nobody outside the desk has seen it", async () => {
    const { addInternalNote, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const note = ok(await addInternalNote({ ticketId, body: "For staff only." }));

    const refused = await retractComment({ commentId: note.id, reason: REASON, confirm: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("VALIDATION");
    expect(await prisma.commentRetraction.count({ where: { commentId: note.id } })).toBe(0);
  });

  it("refuses a client's OWN message — it is not the desk's to withdraw", async () => {
    const { retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const inbound = await prisma.comment.create({
      data: {
        ticketId,
        visibility: "PUBLIC",
        authorKind: "REQUESTER",
        body: "The client's own words.",
        disclaimerKey: "NONE",
      },
      select: { id: true },
    });

    const refused = await retractComment({ commentId: inbound.id, reason: REASON, confirm: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("VALIDATION");
    expect(await prisma.commentRetraction.count({ where: { commentId: inbound.id } })).toBe(0);
  });

  it("refuses a reason shorter than the DB floor, in the app, with a field error", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "Needs a real reason.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );

    const refused = await retractComment({ commentId: reply.id, reason: "oops", confirm: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("VALIDATION");
      expect(refused.fieldErrors?.reason?.[0] ?? "").toMatch(/at least 12/i);
    }
    expect(await prisma.commentRetraction.count({ where: { commentId: reply.id } })).toBe(0);
  });

  it("requires queue:write and records the denial", async () => {
    const { addPublicReply, retractComment, prisma } = mods();
    const ticketId = await newTicket();
    const reply = ok(
      await addPublicReply({
        ticketId,
        body: "Only a writer may withdraw this.",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );

    const before = hoisted.viewer;
    hoisted.viewer = viewerOf(OPS_ID, ["compliance_officers"]);
    try {
      const denied = await retractComment({ commentId: reply.id, reason: REASON, confirm: true });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
      expect(await prisma.commentRetraction.count({ where: { commentId: reply.id } })).toBe(0);

      const denials = await prisma.auditLog.findMany({
        where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
        select: { newValue: true },
      });
      expect(denials.some((d) => (d.newValue ?? "").includes("comment:retract"))).toBe(true);
    } finally {
      hoisted.viewer = before;
    }
  });
});
