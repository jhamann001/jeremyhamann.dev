/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * Proves the `/admin/sla` write path against a real database and a real transaction:
 *  - `saveSlaPolicy` writes ONE `SLA_POLICY_CHANGED` row per field that actually moved, carrying the
 *    old and new minutes;
 *  - a save that changes nothing writes no row at all;
 *  - `setQueueAutoAssign` flips conditionally and is audited against the QUEUE;
 *  - `sla:admin` is ops_team and nobody else, and every refusal is in the ledger.
 *
 * SHARED ROWS, HANDLED DELIBERATELY. `SLA` has exactly one row per priority and `Queue` one per key —
 * neither can be namespaced by run id the way a ticket can. So this file edits the LOW policy and the
 * ADVICE queue (the two least-used fixtures in the suite), restores both in `afterAll` with a direct
 * write that leaves no audit row, and scopes every ledger assertion to this run's `requestId`. What
 * it asserts is therefore about rows THIS RUN wrote, even though the row it edited is shared.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer and
 * context against the real test database, exactly as `macros.actions.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const ADMIN_ID = `it_sla_admin_${RUN}`;
const REQUEST_ID = `it-sla-${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: ADMIN_ID,
  email: `sla.admin.${RUN}@wm-helpdesk.local`,
  name: "Ops Admin",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.31",
  userAgent: `it-sla/${RUN}`,
  requestId: REQUEST_ID,
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
const actionsModule = TEST_URL ? await import("@/server/sla-policies.actions") : null;
const readsModule = TEST_URL ? await import("@/server/sla-policies") : null;

function mods() {
  if (!dbModule || !actionsModule || !readsModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...actionsModule, ...readsModule };
}

type Snapshot = { firstResponseMinutes: number; resolutionMinutes: number; warningMinutes: number } | null;

describe.skipIf(!TEST_URL)("SLA policy administration (DB-gated)", () => {
  let lowBefore: Snapshot = null;
  let adviceBefore = false;

  /** Every `SLA_POLICY_CHANGED` row this run wrote, newest last. Scoped by requestId, not by time. */
  async function myPolicyRows() {
    const { prisma } = mods();
    return prisma.auditLog.findMany({
      where: { action: "SLA_POLICY_CHANGED", requestId: REQUEST_ID },
      select: { entityType: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true, seq: true },
      orderBy: { seq: "asc" },
    });
  }

  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.user.upsert({
      where: { id: ADMIN_ID },
      update: { isActive: true, groups: ["ops_team"] },
      create: {
        id: ADMIN_ID,
        email: hoisted.viewer.email,
        name: hoisted.viewer.name,
        groups: ["ops_team"],
        isActive: true,
      },
    });
    await prisma.queue.upsert({
      where: { key: "ADVICE" },
      update: {},
      create: { key: "ADVICE", name: "Advice", description: "sla-policy fixture", sortOrder: 3 },
    });

    const low = await prisma.sLA.findUnique({
      where: { priority: "LOW" },
      select: { firstResponseMinutes: true, resolutionMinutes: true, warningMinutes: true },
    });
    lowBefore = low;
    const advice = await prisma.queue.findUniqueOrThrow({
      where: { key: "ADVICE" },
      select: { autoAssign: true },
    });
    adviceBefore = advice.autoAssign;
  });

  afterAll(async () => {
    if (!dbModule) return;
    const { prisma } = dbModule;
    // Direct writes: restoring the shared fixtures is housekeeping, not a desk decision, and it must
    // not leave `SLA_POLICY_CHANGED` rows claiming somebody changed the policy back.
    if (lowBefore !== null) {
      await prisma.sLA.update({ where: { priority: "LOW" }, data: lowBefore });
    }
    await prisma.queue.updateMany({ where: { key: "ADVICE" }, data: { autoAssign: adviceBefore } });
    await prisma.$disconnect();
  });

  it("writes one audit row per field that actually moved, with old and new minutes", async () => {
    const { saveSlaPolicy, prisma } = mods();
    const before = await prisma.sLA.findUniqueOrThrow({
      where: { priority: "LOW" },
      select: { firstResponseMinutes: true, resolutionMinutes: true, warningMinutes: true },
    });

    const result = await saveSlaPolicy({
      priority: "LOW",
      firstResponseMinutes: before.firstResponseMinutes,
      resolutionMinutes: before.resolutionMinutes + 7,
      warningMinutes: before.warningMinutes === 45 ? 44 : 45,
    });
    expect(result.ok).toBe(true);

    const rows = await myPolicyRows();
    expect(rows.map((r) => r.fieldChanged).sort()).toEqual(["resolutionMinutes", "warningMinutes"]);
    const resolution = rows.find((r) => r.fieldChanged === "resolutionMinutes");
    expect(resolution?.entityType).toBe("SLA_POLICY");
    expect(resolution?.oldValue).toBe(String(before.resolutionMinutes));
    expect(resolution?.newValue).toBe(String(before.resolutionMinutes + 7));
    // The reader's shortcut for "does this move existing due stamps?" — only the warning band is live.
    expect((resolution?.metadata as { liveReading?: boolean } | null)?.liveReading).toBe(false);
    const warning = rows.find((r) => r.fieldChanged === "warningMinutes");
    expect((warning?.metadata as { liveReading?: boolean } | null)?.liveReading).toBe(true);
  });

  it("stores what it audited — the board and the DTO read back the new numbers", async () => {
    const { slaPolicyBoard, listSlaPolicies, prisma } = mods();
    const stored = await prisma.sLA.findUniqueOrThrow({
      where: { priority: "LOW" },
      select: { resolutionMinutes: true, warningMinutes: true },
    });
    const board = await slaPolicyBoard(hoisted.viewer, hoisted.ctx);
    const low = board.find((p) => p.priority === "LOW");
    expect(low?.configured).toBe(true);
    expect(low?.resolutionMinutes).toBe(stored.resolutionMinutes);
    expect(low?.warningMinutes).toBe(stored.warningMinutes);

    // The board covers every priority; the DTO list covers only the ones that exist.
    expect(board.map((p) => p.priority)).toEqual(["URGENT", "HIGH", "STANDARD", "LOW"]);
    const dtos = await listSlaPolicies(hoisted.viewer, hoisted.ctx);
    expect(dtos.every((d) => d.id.length > 0)).toBe(true);
    expect(dtos.map((d) => d.priority)).toEqual(board.filter((b) => b.configured).map((b) => b.priority));
  });

  it("writes nothing at all when the form is submitted unchanged", async () => {
    const { saveSlaPolicy, prisma } = mods();
    const before = await prisma.sLA.findUniqueOrThrow({
      where: { priority: "LOW" },
      select: { firstResponseMinutes: true, resolutionMinutes: true, warningMinutes: true },
    });
    const rowsBefore = (await myPolicyRows()).length;

    const result = await saveSlaPolicy({ priority: "LOW", ...before });
    expect(result.ok).toBe(true);
    expect((await myPolicyRows()).length).toBe(rowsBefore);
  });

  it("refuses a resolution clock that expires before the first-response clock", async () => {
    const { saveSlaPolicy } = mods();
    const rowsBefore = (await myPolicyRows()).length;
    const result = await saveSlaPolicy({
      priority: "LOW",
      firstResponseMinutes: 480,
      resolutionMinutes: 60,
      warningMinutes: 30,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("VALIDATION");
    expect((await myPolicyRows()).length).toBe(rowsBefore);
  });

  it("refuses a warning band outside the bounds without touching the row", async () => {
    const { saveSlaPolicy, prisma } = mods();
    const before = await prisma.sLA.findUniqueOrThrow({
      where: { priority: "LOW" },
      select: { warningMinutes: true },
    });
    const result = await saveSlaPolicy({
      priority: "LOW",
      firstResponseMinutes: 480,
      resolutionMinutes: 4320,
      warningMinutes: 10_081,
    });
    expect(result.ok).toBe(false);
    const after = await prisma.sLA.findUniqueOrThrow({
      where: { priority: "LOW" },
      select: { warningMinutes: true },
    });
    expect(after.warningMinutes).toBe(before.warningMinutes);
  });

  it("flips Queue.autoAssign conditionally and audits it against the QUEUE", async () => {
    const { setQueueAutoAssign, prisma } = mods();
    const start = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" }, select: { autoAssign: true } });
    const target = !start.autoAssign;

    const first = await setQueueAutoAssign({ queueKey: "ADVICE", autoAssign: target });
    expect(first.ok).toBe(true);

    const queueRows = (await myPolicyRows()).filter((r) => r.entityType === "QUEUE");
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0].fieldChanged).toBe("autoAssign");
    expect(queueRows[0].oldValue).toBe(String(start.autoAssign));
    expect(queueRows[0].newValue).toBe(String(target));

    // Asking for the state it is already in is a successful no-op, not a second row.
    const second = await setQueueAutoAssign({ queueKey: "ADVICE", autoAssign: target });
    expect(second.ok).toBe(true);
    expect((await myPolicyRows()).filter((r) => r.entityType === "QUEUE")).toHaveLength(1);

    // Put it straight back, so the window in which a concurrent file could see the flag is one test.
    const back = await setQueueAutoAssign({ queueKey: "ADVICE", autoAssign: start.autoAssign });
    expect(back.ok).toBe(true);
    const end = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" }, select: { autoAssign: true } });
    expect(end.autoAssign).toBe(start.autoAssign);
  });

  it("refuses a viewer without sla:admin, records the denial, and changes nothing", async () => {
    const { saveSlaPolicy, setQueueAutoAssign, slaPolicyBoard, prisma } = mods();
    const original = hoisted.viewer;
    hoisted.viewer = { ...original, groups: ["client_services"] };
    try {
      const write = await saveSlaPolicy({
        priority: "LOW",
        firstResponseMinutes: 1,
        resolutionMinutes: 1,
        warningMinutes: 0,
      });
      expect(write.ok).toBe(false);
      if (!write.ok) expect(write.code).toBe("FORBIDDEN");

      const toggle = await setQueueAutoAssign({ queueKey: "ADVICE", autoAssign: true });
      expect(toggle.ok).toBe(false);

      await expect(slaPolicyBoard(hoisted.viewer, hoisted.ctx)).rejects.toThrow(/Forbidden/);

      const denials = await prisma.auditLog.count({
        where: { action: "AUTHZ_DENIED", requestId: REQUEST_ID },
      });
      expect(denials).toBeGreaterThanOrEqual(3);
    } finally {
      hoisted.viewer = original;
    }

    const low = await prisma.sLA.findUniqueOrThrow({
      where: { priority: "LOW" },
      select: { firstResponseMinutes: true },
    });
    expect(low.firstResponseMinutes).not.toBe(1);
  });
});
