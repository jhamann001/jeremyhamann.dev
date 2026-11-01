/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make every row written here permanent).
 *
 * Proves the whole of the S8 offboarding path against a real database and a real transaction:
 *  - `isActive` flips, every OPEN assignment is cleared, and each cleared ticket gets its own
 *    `TICKET_ASSIGNED` row with `newValue: null` — in ONE transaction, `USER_DEACTIVATED` last.
 *  - RESOLVED and CLOSED assignments are left alone (they are the historical owner).
 *  - `version` moves on every cleared ticket, so a stale editor gets a CONFLICT rather than
 *    re-assigning a departed colleague.
 *  - Re-running is a no-op that writes no second row; reactivation restores the account and NOT the
 *    assignments; self-deactivation and the machine identities are refused; a caller without
 *    `user:admin` is denied and the denial is in the ledger.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer and
 * context against the real test database, exactly as `comments-race.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const ADMIN_ID = `it_users_admin_${RUN}`;
const TARGET_ID = `it_users_target_${RUN}`;
const BYSTANDER_ID = `it_users_bystander_${RUN}`;
const MACHINE_ID = `it_users_machine_${RUN}`;
const OPEN_A = `it_users_open_a_${RUN}`;
const OPEN_B = `it_users_open_b_${RUN}`;
const RESOLVED_T = `it_users_resolved_${RUN}`;
const CLOSED_T = `it_users_closed_${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: ADMIN_ID,
  email: `users.admin.${RUN}@wm-helpdesk.local`,
  name: "Olivia Admin",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.11",
  userAgent: `it-users/${RUN}`,
  requestId: `it-users-${RUN}`,
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
const actionsModule = TEST_URL ? await import("@/server/users.actions") : null;
const readsModule = TEST_URL ? await import("@/server/users") : null;

function mods() {
  if (!dbModule || !actionsModule || !readsModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...actionsModule, ...readsModule };
}

/** Runs `fn` with the viewer temporarily holding `groups`, then restores it. */
async function asGroups<T>(groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer.groups;
  hoisted.viewer = { ...hoisted.viewer, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = { ...hoisted.viewer, groups: before };
  }
}

async function auditFor(entityId: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, entityId },
    orderBy: { seq: "asc" },
    select: {
      seq: true,
      action: true,
      entityType: true,
      ticketId: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      metadata: true,
      actorId: true,
    },
  });
}

describe.skipIf(!TEST_URL)("deactivateUser / reactivateUser (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma, MACHINE_ACTOR_EMAILS } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "users fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });

    const people: Array<{ id: string; email: string; name: string; groups: OktaGroup[] }> = [
      { id: ADMIN_ID, email: hoisted.viewer.email, name: "Olivia Admin", groups: ["ops_team"] },
      { id: TARGET_ID, email: `users.target.${RUN}@wm-helpdesk.local`, name: "Terry Target", groups: ["ops_team"] },
      {
        id: BYSTANDER_ID,
        email: `users.bystander.${RUN}@wm-helpdesk.local`,
        name: "Bea Bystander",
        groups: ["client_services"],
      },
    ];
    for (const p of people) {
      await prisma.user.upsert({
        where: { id: p.id },
        update: { groups: p.groups, isActive: true, name: p.name },
        create: { id: p.id, email: p.email, name: p.name, groups: p.groups, emailVerified: new Date(), isActive: true },
      });
    }
    // A stand-in for a seeded machine identity: the real seed may not have run in this database.
    await prisma.user.upsert({
      where: { email: MACHINE_ACTOR_EMAILS[0] },
      update: { isActive: true },
      create: { id: MACHINE_ID, email: MACHINE_ACTOR_EMAILS[0], name: "Integration", groups: [], isActive: true },
    });

    const createdAt = new Date("2026-09-18T12:00:00.000Z");
    const tickets: Array<{ id: string; status: "OPEN" | "PENDING_CLIENT" | "RESOLVED" | "CLOSED" }> = [
      { id: OPEN_A, status: "OPEN" },
      { id: OPEN_B, status: "PENDING_CLIENT" },
      { id: RESOLVED_T, status: "RESOLVED" },
      { id: CLOSED_T, status: "CLOSED" },
    ];
    for (const t of tickets) {
      const terminal = t.status === "RESOLVED" || t.status === "CLOSED";
      await prisma.ticket.upsert({
        where: { id: t.id },
        update: { assigneeId: TARGET_ID, status: t.status },
        create: {
          id: t.id,
          subject: `Offboarding fixture ${t.id}`,
          description: "Offboarding fixture description",
          requesterName: "Fixture Requester",
          requesterEmail: `users.${RUN}@example.com`,
          category: "TRADE_CORRECTION",
          priority: "STANDARD",
          status: t.status,
          queue: { connect: { id: queue.id } },
          createdBy: { connect: { id: ADMIN_ID } },
          assignee: { connect: { id: TARGET_ID } },
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
          resolvedAt: terminal ? createdAt : null,
          closedAt: t.status === "CLOSED" ? createdAt : null,
        },
      });
    }
  });

  it("refuses a caller without user:admin and records the denial", async () => {
    const { deactivateUser, prisma } = mods();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: BYSTANDER_ID }, select: { isActive: true } });

    for (const groups of [["client_services"], ["advisors"], ["compliance_officers"], []] as OktaGroup[][]) {
      const denied = await asGroups(groups, () => deactivateUser({ userId: BYSTANDER_ID, isActive: false }));
      expect(denied.ok, groups.join("+") || "no groups").toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: BYSTANDER_ID }, select: { isActive: true } });
    expect(after.isActive).toBe(before.isActive);

    const denials = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
      select: { newValue: true },
    });
    expect(denials.length).toBeGreaterThanOrEqual(4);
    expect(denials.every((d) => (d.newValue ?? "").includes("user:admin deactivate"))).toBe(true);
  });

  it("refuses self-deactivation and the machine identities without touching a row", async () => {
    const { deactivateUser, prisma, MACHINE_ACTOR_EMAILS } = mods();

    const self = await deactivateUser({ userId: ADMIN_ID, isActive: false });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe("VALIDATION");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_ID } })).isActive).toBe(true);

    const machine = await prisma.user.findUniqueOrThrow({ where: { email: MACHINE_ACTOR_EMAILS[0] } });
    const refused = await deactivateUser({ userId: machine.id, isActive: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("VALIDATION");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: machine.id } })).isActive).toBe(true);
  });

  it("refuses a missing user and an input that contradicts the action", async () => {
    const { deactivateUser, reactivateUser } = mods();

    const missing = await deactivateUser({ userId: `it_users_nobody_${RUN}`, isActive: false });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("NOT_FOUND");

    const wrongWay = await deactivateUser({ userId: TARGET_ID, isActive: true });
    expect(wrongWay.ok).toBe(false);
    if (!wrongWay.ok) expect(wrongWay.code).toBe("VALIDATION");

    const alsoWrong = await reactivateUser({ userId: TARGET_ID, isActive: false });
    expect(alsoWrong.ok).toBe(false);
    if (!alsoWrong.ok) expect(alsoWrong.code).toBe("VALIDATION");
  });

  it("deactivates, clears only the OPEN assignments, and audits each one in the same transaction", async () => {
    const { deactivateUser, prisma } = mods();
    const versionsBefore = new Map(
      (
        await prisma.ticket.findMany({
          where: { id: { in: [OPEN_A, OPEN_B, RESOLVED_T, CLOSED_T] } },
          select: { id: true, version: true },
        })
      ).map((t) => [t.id, t.version] as const),
    );

    const result = await deactivateUser({ userId: TARGET_ID, isActive: false, reason: "Left the firm 2026-09-19" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ id: TARGET_ID, clearedAssignments: 2 });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: TARGET_ID } })).isActive).toBe(false);

    const tickets = await prisma.ticket.findMany({
      where: { id: { in: [OPEN_A, OPEN_B, RESOLVED_T, CLOSED_T] } },
      select: { id: true, assigneeId: true, version: true },
    });
    const byId = new Map(tickets.map((t) => [t.id, t] as const));
    // Open work is handed back to the queue; the historical owner of a finished ticket is kept.
    expect(byId.get(OPEN_A)?.assigneeId).toBeNull();
    expect(byId.get(OPEN_B)?.assigneeId).toBeNull();
    expect(byId.get(RESOLVED_T)?.assigneeId).toBe(TARGET_ID);
    expect(byId.get(CLOSED_T)?.assigneeId).toBe(TARGET_ID);
    // The concurrency token moves only where the row changed.
    expect(byId.get(OPEN_A)?.version).toBe((versionsBefore.get(OPEN_A) ?? 0) + 1);
    expect(byId.get(OPEN_B)?.version).toBe((versionsBefore.get(OPEN_B) ?? 0) + 1);
    expect(byId.get(RESOLVED_T)?.version).toBe(versionsBefore.get(RESOLVED_T));
    expect(byId.get(CLOSED_T)?.version).toBe(versionsBefore.get(CLOSED_T));

    const userRows = await auditFor(TARGET_ID);
    const deactivation = userRows.filter((r) => r.action === "USER_DEACTIVATED");
    expect(deactivation).toHaveLength(1);
    expect(deactivation[0]).toMatchObject({
      entityType: "USER",
      ticketId: null,
      fieldChanged: "isActive",
      oldValue: "true",
      newValue: "false",
      actorId: ADMIN_ID,
    });
    expect(deactivation[0].metadata).toMatchObject({ clearedAssignments: 2, reason: "Left the firm 2026-09-19" });

    for (const ticketId of [OPEN_A, OPEN_B]) {
      const rows = (await auditFor(ticketId)).filter((r) => r.action === "TICKET_ASSIGNED");
      expect(rows, ticketId).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entityType: "TICKET",
        ticketId,
        fieldChanged: "assigneeId",
        oldValue: TARGET_ID,
        newValue: null,
      });
      // Audit last: the USER_DEACTIVATED row is the final statement of the transaction.
      expect(rows[0].seq < deactivation[0].seq).toBe(true);
    }
    for (const ticketId of [RESOLVED_T, CLOSED_T]) {
      expect((await auditFor(ticketId)).filter((r) => r.action === "TICKET_ASSIGNED")).toHaveLength(0);
    }
  });

  it("is idempotent: a second deactivation changes nothing and writes no second row", async () => {
    const { deactivateUser } = mods();
    const before = (await auditFor(TARGET_ID)).length;

    const again = await deactivateUser({ userId: TARGET_ID, isActive: false });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data).toEqual({ id: TARGET_ID, clearedAssignments: 0 });

    expect((await auditFor(TARGET_ID)).length).toBe(before);
  });

  it("keeps a deactivated user in the admin list and out of every assignable lookup", async () => {
    const { listStaffUsers, prisma } = mods();
    const rows = await listStaffUsers(hoisted.viewer, {});
    const target = rows.find((r) => r.id === TARGET_ID);
    expect(target).toBeDefined();
    expect(target?.isActive).toBe(false);
    // Every open assignment was cleared, so the row no longer claims work it cannot do.
    expect(target?.openAssignments).toBe(0);

    const stillAssignable = await prisma.user.findMany({
      where: { id: TARGET_ID, isActive: true },
      select: { id: true },
    });
    expect(stillAssignable).toEqual([]);
  });

  it("reactivates the account and never re-assigns the tickets it handed back", async () => {
    const { reactivateUser, prisma } = mods();

    const result = await reactivateUser({ userId: TARGET_ID, isActive: true, reason: "Rejoined" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ id: TARGET_ID });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: TARGET_ID } })).isActive).toBe(true);
    const reassigned = await prisma.ticket.findMany({
      where: { id: { in: [OPEN_A, OPEN_B] } },
      select: { id: true, assigneeId: true },
    });
    expect(reassigned.every((t) => t.assigneeId === null)).toBe(true);

    const rows = (await auditFor(TARGET_ID)).filter((r) => r.action === "USER_REACTIVATED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: "USER",
      fieldChanged: "isActive",
      oldValue: "false",
      newValue: "true",
    });

    const noop = await reactivateUser({ userId: TARGET_ID, isActive: true });
    expect(noop.ok).toBe(true);
    expect((await auditFor(TARGET_ID)).filter((r) => r.action === "USER_REACTIVATED")).toHaveLength(1);
  });
});

describe.skipIf(!TEST_URL)("listStaffUsers (TEST_DATABASE_URL)", () => {
  it("denies a caller without user:admin", async () => {
    const { listStaffUsers } = mods();
    await asGroups(["compliance_officers"], async () => {
      await expect(listStaffUsers(hoisted.viewer, {})).rejects.toThrow(/Forbidden/);
    });
  });

  it("never lists a machine identity", async () => {
    const { listStaffUsers, MACHINE_ACTOR_EMAILS } = mods();
    const rows = await listStaffUsers(hoisted.viewer, {});
    for (const email of MACHINE_ACTOR_EMAILS) {
      expect(
        rows.some((r) => r.email === email),
        email,
      ).toBe(false);
    }
  });

  it("filters by search over name and email, case-insensitively", async () => {
    const { listStaffUsers } = mods();
    const byName = await listStaffUsers(hoisted.viewer, { search: "bea bystander" });
    expect(byName.map((r) => r.id)).toContain(BYSTANDER_ID);

    const byEmail = await listStaffUsers(hoisted.viewer, { search: `USERS.BYSTANDER.${RUN}` });
    expect(byEmail.map((r) => r.id)).toEqual([BYSTANDER_ID]);

    const none = await listStaffUsers(hoisted.viewer, { search: `no-such-person-${RUN}` });
    expect(none).toEqual([]);
  });

  it("filters by isActive and counts only OPEN assignments", async () => {
    const { listStaffUsers, prisma } = mods();
    await prisma.ticket.update({ where: { id: OPEN_A }, data: { assigneeId: BYSTANDER_ID } });

    const active = await listStaffUsers(hoisted.viewer, { isActive: true, search: RUN });
    expect(active.every((r) => r.isActive)).toBe(true);
    const bystander = active.find((r) => r.id === BYSTANDER_ID);
    // One OPEN ticket; the RESOLVED and CLOSED ones still belong to someone else and are not counted.
    expect(bystander?.openAssignments).toBe(1);

    const inactive = await listStaffUsers(hoisted.viewer, { isActive: false, search: RUN });
    expect(inactive.every((r) => !r.isActive)).toBe(true);
  });

  it("returns rows ordered by name then email", async () => {
    const { listStaffUsers } = mods();
    const rows = await listStaffUsers(hoisted.viewer, { search: RUN });
    const keys = rows.map((r) => `${r.name ?? ""}|${r.email}`);
    expect(keys).toEqual([...keys].sort());
  });
});
