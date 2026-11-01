/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — rows are permanent).
 *
 * Proves the three bars on `voidTicket` against a real database, and proves the
 * arithmetic that makes a void mean anything: the ticket leaves the counters.
 *
 *  - ops_team AND queue WRITE: every other group is refused and the denial is in the ledger;
 *  - a reason of at least 12 characters, on the ROW and on the `TICKET_VOIDED` audit row;
 *  - refused once a PUBLIC comment exists, because the ticket is then correspondence — in TWO wordings,
 *    because a reply that has already been withdrawn is off the client's view but still on the record,
 *    and repeating "withdraw the reply" at that operator states something false and offers a step they
 *    have already taken;
 *  - `status: VOIDED` + `resolution: ENTERED_IN_ERROR` + the void triple, in ONE transaction, guarded
 *    by the version token; VOIDED is terminal and a second void is refused;
 *  - `METRICS_EXCLUDED_STATUSES` removes it from a counter that applies the filter, and would NOT
 *    remove it from one that forgets — the check the dev seed's BREACHED voided fixture exists for.
 *
 * Every assertion is scoped to rows this run created.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";
import { METRICS_EXCLUDED_STATUSES } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_void_ops_${RUN}`;
const PLAIN = `it_void_plain_${RUN}`;
const ANSWERED = `it_void_answered_${RUN}`;
const WITHDRAWN = `it_void_withdrawn_${RUN}`;
const GUARDED = `it_void_guarded_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));
hoisted.viewer = {
  id: OPS_ID,
  email: `void.ops.${RUN}@wm-helpdesk.local`,
  name: "Otto Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = { ipAddress: "203.0.113.23", userAgent: `it-void/${RUN}`, requestId: `it-void-${RUN}`, isPrefetch: false };

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
const actions = TEST_URL ? await import("@/server/void.actions") : null;

function mods() {
  if (!dbModule || !actions) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...actions };
}

async function asGroups<T>(groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer.groups;
  hoisted.viewer = { ...hoisted.viewer, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = { ...hoisted.viewer, groups: before };
  }
}

describe.skipIf(!TEST_URL)("voidTicket (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "void fixture", sortOrder: 1 },
    });
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.user.upsert({
      where: { id: OPS_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: { id: OPS_ID, email: hoisted.viewer.email, name: "Otto Ops", groups: ["ops_team"], isActive: true, emailVerified: new Date() },
    });

    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    for (const id of [PLAIN, ANSWERED, WITHDRAWN, GUARDED]) {
      await prisma.ticket.upsert({
        where: { id },
        update: {},
        create: {
          id,
          subject: `Void fixture ${id}`,
          description: "Void fixture description",
          requesterName: "Dana Requester",
          requesterEmail: `void.${RUN}@example.com`,
          category: "OTHER",
          priority: "STANDARD",
          status: "OPEN",
          queueId: ops.id,
          createdById: OPS_ID,
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
        },
      });
    }
    // `comment.upsert` is forbidden by the Prisma extension: comments are append-only. A plain
    // create is the only way to seed one, and the run marker keeps it unique.
    await prisma.comment.create({
      data: {
        id: `it_void_pub_${RUN}`,
        ticketId: ANSWERED,
        authorId: OPS_ID,
        authorKind: "STAFF",
        visibility: "PUBLIC",
        body: `We are looking into this. ${RUN}`,
        disclaimerKey: "GENERAL_SERVICE",
      },
    });
    // The WITHDRAWN fixture's ONLY public reply carries a retraction, so the client app serves the
    // withdrawal placeholder for it and nothing of the reply is visible there.
    await prisma.comment.create({
      data: {
        id: `it_void_pub_retracted_${RUN}`,
        ticketId: WITHDRAWN,
        authorId: OPS_ID,
        authorKind: "STAFF",
        visibility: "PUBLIC",
        body: `Sent to the wrong household. ${RUN}`,
        disclaimerKey: "GENERAL_SERVICE",
      },
    });
    // `commentRetraction.upsert` is forbidden by the Prisma extension for the same reason as
    // `comment.upsert` (a retraction is append-only and cannot be undone); the run marker on the
    // comment id is what keeps a plain create unique across runs.
    await prisma.commentRetraction.create({
      data: {
        commentId: `it_void_pub_retracted_${RUN}`,
        retractedById: OPS_ID,
        reason: "went to the wrong household",
      },
    });
  });

  it("refuses every group that is not ops_team with queue WRITE, and records each denial", async () => {
    const { voidTicket, prisma } = mods();
    for (const groups of [["client_services"], ["advisors"], ["compliance_officers"], []] as OktaGroup[][]) {
      const denied = await asGroups(groups, () =>
        voidTicket({ ticketId: GUARDED, version: 1, reason: "raised against the wrong household", confirm: true }),
      );
      expect(denied.ok, groups.join("+") || "no groups").toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
    }
    expect(
      await prisma.auditLog.count({ where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED", ticketId: GUARDED } }),
    ).toBeGreaterThanOrEqual(4);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: GUARDED } })).status).toBe("OPEN");
  });

  it("refuses a reason shorter than the floor, and writes nothing", async () => {
    const { voidTicket, prisma } = mods();
    const short = await voidTicket({ ticketId: GUARDED, version: 1, reason: "oops", confirm: true });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.code).toBe("VALIDATION");
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: GUARDED } });
    expect(t.status).toBe("OPEN");
    expect(t.voidedAt).toBeNull();
  });

  it("REFUSES once the ticket carries a client-visible reply — a correction, not a deletion", async () => {
    const { voidTicket, prisma } = mods();
    const refused = await voidTicket({
      ticketId: ANSWERED,
      version: 1,
      reason: "should never have been raised at all",
      confirm: true,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("VALIDATION");
      const form = refused.fieldErrors?._form?.join(" ") ?? "";
      expect(form).toMatch(/correspondence/i);
      // The refusal names the fact the code tested (a client-visible reply), never a delivery: the
      // reply may have been suppressed or never emailed at all.
      expect(form).not.toMatch(/\bsent\b/i);
      // This reply is still live, so the remedy it names is one the operator has NOT yet carried out.
      expect(form).toMatch(/withdraw the reply/i);
    }
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ANSWERED } });
    expect(t.status).toBe("OPEN");
    expect(t.voidReason).toBeNull();
  });

  it("REFUSES after the only reply was withdrawn — but does not claim it is visible, or ask for it twice", async () => {
    const { voidTicket, prisma } = mods();
    const refused = await voidTicket({
      ticketId: WITHDRAWN,
      version: 1,
      reason: "raised against the wrong household",
      confirm: true,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("VALIDATION");
      const form = refused.fieldErrors?._form?.join(" ") ?? "";
      // The policy is unchanged — a public comment is correspondence whether or not it was delivered.
      expect(form).toMatch(/correspondence/i);
      expect(form).not.toMatch(/\bsent\b/i);
      // What changes is the sentence: the reply is NOT something the client can see any more, and the
      // remedy the live wording names has already been carried out on this ticket.
      expect(form).not.toMatch(/the client can see/i);
      expect(form).not.toMatch(/withdraw the reply/i);
      // A next step is still offered, and it is one the operator has not already taken.
      expect(form).toMatch(/withdrawn outcome/i);
    }
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: WITHDRAWN } });
    expect(t.status).toBe("OPEN");
    expect(t.voidedAt).toBeNull();
    expect(t.voidReason).toBeNull();
  });

  it("voids in one transaction: the triple, the resolution and TICKET_VOIDED with the reason", async () => {
    const { voidTicket, prisma } = mods();
    const reason = "duplicate of my own keystroke, nothing was sent";
    const result = await voidTicket({ ticketId: PLAIN, version: 1, reason, confirm: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.version).toBe(2);

    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: PLAIN } });
    expect(t.status).toBe("VOIDED");
    expect(t.resolution).toBe("ENTERED_IN_ERROR");
    expect(t.voidedById).toBe(OPS_ID);
    expect(t.voidedAt).not.toBeNull();
    expect(t.voidReason).toBe(reason);

    const rows = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, ticketId: PLAIN },
      orderBy: { seq: "asc" },
      select: { action: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
    });
    const voided = rows.filter((r) => r.action === "TICKET_VOIDED");
    expect(voided).toHaveLength(1);
    expect(voided[0]).toMatchObject({ fieldChanged: "status", oldValue: "OPEN", newValue: "VOIDED" });
    expect((voided[0]?.metadata as { reason?: string } | null)?.reason).toBe(reason);
    expect(rows.filter((r) => r.action === "TICKET_FIELD_CHANGED" && r.fieldChanged === "resolution")).toHaveLength(1);
  });

  it("is terminal: a second void, and every other write, is refused", async () => {
    const { voidTicket } = mods();
    const again = await voidTicket({ ticketId: PLAIN, version: 2, reason: "trying to void it twice over", confirm: true });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("VALIDATION");
      expect(again.message).toMatch(/voided/i);
    }
  });

  it("leaves every counter that applies METRICS_EXCLUDED_STATUSES, and only those", async () => {
    const { prisma } = mods();
    const mine = { queue: { key: "OPERATIONS" as const }, id: { in: [PLAIN, ANSWERED, GUARDED] } };

    const naive = await prisma.ticket.count({ where: mine });
    const correct = await prisma.ticket.count({
      where: { ...mine, status: { notIn: [...METRICS_EXCLUDED_STATUSES] } },
    });
    expect(naive).toBe(3);
    // The one voided above is gone from the filtered count — and a surface that forgets the filter
    // shows it immediately, which is exactly what the seed's BREACHED voided fixture is for.
    expect(correct).toBe(2);
  });

  it("refuses a stale version rather than voiding what somebody else just changed", async () => {
    const { voidTicket, prisma } = mods();
    const stale = await voidTicket({ ticketId: GUARDED, version: 999, reason: "this must never be written", confirm: true });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("CONFLICT");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: GUARDED } })).status).toBe("OPEN");
  });
});
