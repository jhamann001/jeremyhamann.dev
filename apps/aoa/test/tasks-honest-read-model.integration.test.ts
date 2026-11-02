import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ticket against real PostgreSQL + RLS: the Tasks read model resolves linked
// transfers/decisions under the viewer's own scope, derives system-closed rows
// without touching stored status, and the task writer refuses the same rows
// the page shows as read-only. Synthetic fixtures only.

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { updateDecisionTask } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import { listDecisionCases, listDecisionTasks, type DecisionTaskRow } from "@/lib/data/decision-cases";
import { INACTIVE_REASON_WRITE_ERROR } from "@/lib/data/decision-task-context";
import { countTasks, partitionPersistedTasks, toPersistedTaskView } from "@/components/tasks/tasks-model";
import { prisma } from "@/lib/db";

const RUN = process.env.AUDIT_TEST_CLEANUP_URL ? describe : describe.skip;
const PREFIX = "ticket-TASKS-";
const EMAIL = "ticket-tasks-synthetic@example.test";
const OPS = { role: "OPERATIONS", email: EMAIL };
const VIEWER = { role: "VIEWER", email: EMAIL };
const T = { partial: `${PREFIX}partial`, wire: `${PREFIX}wire`, archived: `${PREFIX}archived` };
const TRANSFERS = Object.values(T);
const D = { legacy: `${PREFIX}legacy-case`, legacyManual: `${PREFIX}legacy-manual-case`, listed: `${PREFIX}listed-case` };
const K = {
  active: `${PREFIX}task-active`, routeChanged: `${PREFIX}task-route`, archived: `${PREFIX}task-archived`,
  archivedDone: `${PREFIX}task-archived-done`,
  legacyResolve: `${PREFIX}task-legacy-resolve`, legacyFollowUp: `${PREFIX}task-legacy-follow-up`,
  legacyManualResolve: `${PREFIX}task-legacy-manual-resolve`,
  listedFollowUp: `${PREFIX}task-listed-follow-up`,
};
const standardKey = (transferId: string, key: string) => `asset-transfer:${transferId}:standard-partial-acat:${key}`;

RUN("ticket Tasks read model and write guard with PostgreSQL/RLS", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    await owner.decisionCaseEvent.deleteMany({ where: { decision_id: { in: Object.values(D) } } });
    await owner.decisionTask.deleteMany({ where: { id: { in: Object.values(K) } } });
    await owner.decisionCase.deleteMany({ where: { id: { in: Object.values(D) } } });
    await owner.transfer.deleteMany({ where: { id: { in: TRANSFERS } } });
    await owner.auditLog.deleteMany({ where: { actorEmail: EMAIL } });
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${`${PREFIX}%`}`;
  }

  async function ours(identity: typeof OPS): Promise<Record<string, DecisionTaskRow>> {
    const rows = await listDecisionTasks(identity);
    return Object.fromEntries(rows.filter((row) => row.id.startsWith(PREFIX)).map((row) => [row.id, row]));
  }

  const storedTasks = () => owner!.decisionTask.findMany({ where: { id: { in: Object.values(K) } }, orderBy: { id: "asc" } });

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const ownerUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!appUrl || !ownerUrl) throw new Error("Explicit local synthetic database URLs required");
    const target = new URL(ownerUrl);
    for (const value of [appUrl, ownerUrl]) {
      const url = new URL(value);
      const syntheticDatabase = url.pathname.endsWith("_synthetic") ||
        (process.env.CI === "true" && url.pathname === "/aoa");
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.host !== target.host || url.pathname !== target.pathname ||
        !syntheticDatabase ||
        ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
      ) throw new Error("Tasks acceptance requires one loopback synthetic database");
    }
    if (new URL(appUrl).username !== "app_rw") throw new Error("RLS reads must use app_rw");
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    await cleanup();

    const transfer = (id: string, fundingType: "ACAT_PARTIAL" | "WIRE", archived = false) => owner!.transfer.create({ data: {
      id, source: "APP", client_first_name: "Synthetic", client_last_name: "Tasks",
      household_name: `Synthetic Tasks ${id}`, value: 100, stage: "DECISION", owner_kind: "OPERATIONS",
      funding_type: fundingType, funding_plan_complete: true, funding_plan_version: 1,
      ...(archived ? { archived_at: new Date("2026-09-20T12:00:00Z"), archived_by: EMAIL, archived_reason: "manual" } : {}),
    } });
    await transfer(T.partial, "ACAT_PARTIAL");
    await transfer(T.wire, "WIRE");
    await transfer(T.archived, "ACAT_PARTIAL", true);

    await owner.decisionCase.create({ data: {
      id: D.legacy, source: "ASSET_TRANSFER", source_key: `asset-transfer:${T.partial}:excluded-positions`,
      transfer_id: T.partial, household_name: "Synthetic Tasks legacy", category: "Asset transfer",
      question: "Synthetic legacy excluded positions", owner_team: "OPERATIONS", status: "RESOLVED",
      resolution_code: "STANDARD_PARTIAL_ACAT", resolution_summary: "Synthetic legacy route.", resolved_by: EMAIL, resolved_at: new Date(), version: 1, created_by: EMAIL,
    } });
    // A legacy excluded-positions decision a person resolved before the backfill: never replaced.
    await owner.decisionCase.create({ data: {
      id: D.legacyManual, source: "ASSET_TRANSFER", source_key: `asset-transfer:${T.wire}:excluded-positions`,
      transfer_id: T.wire, household_name: "Synthetic Tasks legacy manual", category: "Asset transfer",
      question: "Synthetic legacy excluded positions resolved by a person", owner_team: "OPERATIONS", status: "RESOLVED",
      resolution_code: "RETAIN_AT_CONTRA", resolution_summary: "Synthetic: kept at contra.", resolved_by: EMAIL, resolved_at: new Date(), version: 1, created_by: EMAIL,
    } });
    await owner.decisionCase.create({ data: {
      id: D.listed, source: "ASSET_TRANSFER", source_key: `${PREFIX}listed-source`,
      transfer_id: T.partial, household_name: "Synthetic Tasks listed", category: "Asset transfer",
      question: "Synthetic listed exception", owner_team: "OPERATIONS", status: "RESOLVED",
      resolution_code: "TRANSFER_EXCEPTION_APPROVED", resolution_summary: "Synthetic: retain at contra.", resolved_by: EMAIL, resolved_at: new Date(), version: 1, created_by: EMAIL,
    } });

    const standard = (id: string, transferId: string, key: string, status: "TODO" | "DONE") => owner!.decisionTask.create({ data: {
      id, source_key: standardKey(transferId, key), decision_id: null, transfer_id: transferId, task_key: key,
      title: `Synthetic ${key}`, owner_team: "OPERATIONS", status, priority: "HIGH", created_by: EMAIL,
      ...(status === "DONE" ? { completed_by: EMAIL, completed_at: new Date() } : {}),
    } });
    await standard(K.active, T.partial, "track-partial-acat", "TODO");
    await standard(K.routeChanged, T.wire, "track-partial-acat", "DONE");
    await standard(K.archived, T.archived, "track-partial-acat", "TODO");
    await standard(K.archivedDone, T.archived, "submit-partial-acat", "DONE");
    const decisionTask = (id: string, decisionId: string, key: string, status: "TODO" | "DONE") => owner!.decisionTask.create({ data: {
      id, decision_id: decisionId, transfer_id: T.partial, task_key: key, title: `Synthetic ${key}`,
      owner_team: "OPERATIONS", status, priority: "NORMAL", created_by: EMAIL,
      ...(status === "DONE" ? { completed_by: "system@ops-portal", completed_at: new Date() } : {}),
    } });
    await decisionTask(K.legacyResolve, D.legacy, "resolve-excluded-positions", "DONE");
    await decisionTask(K.legacyFollowUp, D.legacy, "execute-resolution", "TODO");
    await owner.decisionTask.create({ data: {
      id: K.legacyManualResolve, decision_id: D.legacyManual, transfer_id: T.wire, task_key: "resolve-excluded-positions",
      title: "Synthetic person-resolved legacy task", owner_team: "OPERATIONS", status: "DONE", priority: "NORMAL",
      created_by: EMAIL, completed_by: EMAIL, completed_at: new Date(),
    } });
    await decisionTask(K.listedFollowUp, D.listed, "execute-resolution", "TODO");
  });

  beforeEach(() => authSpy.mockResolvedValue({ user: OPS }));

  afterAll(async () => {
    try { await cleanup(); } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
    }
  });

  it("derives link context and system-closed rows at read time without changing stored rows", async () => {
    const before = await storedTasks();
    const rows = await ours(OPS);
    expect(Object.keys(rows).sort()).toEqual(Object.values(K).sort());

    expect(rows[K.active].context).toEqual({
      transfer: { id: T.partial, visible: true, archived: false, fundingType: "ACAT_PARTIAL" },
      decision: null, inactiveReason: null,
    });
    expect(rows[K.routeChanged]).toMatchObject({ status: "DONE", context: {
      transfer: { id: T.wire, visible: true, archived: false, fundingType: "WIRE" }, inactiveReason: "ROUTE_CHANGED",
    } });
    // Archiving never touches tasks: the unfinished one keeps its stored TODO
    // but is derived out of active work; the finished one stays done work.
    expect(rows[K.archived]).toMatchObject({ status: "TODO", context: {
      transfer: { id: T.archived, visible: true, archived: true }, inactiveReason: "TRANSFER_ARCHIVED",
    } });
    expect(rows[K.archivedDone]).toMatchObject({ status: "DONE", context: {
      transfer: { id: T.archived, visible: true, archived: true }, inactiveReason: null,
    } });
    expect(rows[K.legacyResolve].context).toMatchObject({
      decision: { id: D.legacy, visible: true, listed: false, status: "RESOLVED" }, inactiveReason: "REPLACED_LEGACY",
    });
    // A person's resolution of a hidden legacy decision stays ordinary done work (no link, not "replaced").
    expect(rows[K.legacyManualResolve].context).toMatchObject({
      decision: { id: D.legacyManual, visible: true, listed: false, status: "RESOLVED" }, inactiveReason: null,
    });
    // Other work on the hidden legacy decision stays active, just without a decision link.
    expect(rows[K.legacyFollowUp].context).toMatchObject({
      decision: { id: D.legacy, listed: false }, inactiveReason: null,
    });
    expect(rows[K.listedFollowUp].context).toMatchObject({
      decision: { id: D.listed, visible: true, listed: true, status: "RESOLVED",
        resolutionSummary: "Synthetic: retain at contra." },
      inactiveReason: null,
    });

    // "listed" matches exactly what Decision Center lists, so a link can select it.
    const listedIds = new Set((await listDecisionCases(OPS)).map((row) => row.id));
    expect(listedIds.has(D.listed)).toBe(true);
    expect(listedIds.has(D.legacy)).toBe(false);

    expect(await storedTasks()).toEqual(before);
  });

  it("keeps an archived transfer's open task out of the Tasks totals end to end", async () => {
    const rows = await ours(OPS);
    const { active, inactive } = partitionPersistedTasks(Object.values(rows).map((row) => toPersistedTaskView(row, "OPERATIONS")));
    expect(inactive.map((view) => view.persistentId).sort()).toEqual([K.archived, K.legacyResolve, K.routeChanged].sort());
    // Open work is the live partial-ACAT step and the two decision follow-ups;
    // the archived transfer's finished step and the person-resolved legacy task are still counted as done.
    expect(countTasks(active)).toEqual({ all: 5, todo: 3, in_progress: 0, blocked: 0, done: 2 });
    expect(active.find((view) => view.persistentId === K.archivedDone)).toMatchObject({ canUpdate: false });
  });

  it("gives a VIEWER the same RLS-resolved links the target pages allow", async () => {
    const rows = await ours(VIEWER);
    expect(rows[K.listedFollowUp].context?.decision).toMatchObject({ visible: true, listed: true });
    expect(rows[K.active].context?.transfer).toMatchObject({ visible: true });
  });

  it("refuses writes to rows the page shows as read-only and keeps active rows writable", async () => {
    const before = await storedTasks();
    expect(await updateDecisionTask({ taskId: K.routeChanged, status: "TODO", priority: "HIGH" }))
      .toEqual({ ok: false, message: INACTIVE_REASON_WRITE_ERROR.ROUTE_CHANGED });
    expect(await updateDecisionTask({ taskId: K.legacyResolve, status: "TODO", priority: "NORMAL" }))
      .toEqual({ ok: false, message: INACTIVE_REASON_WRITE_ERROR.REPLACED_LEGACY });
    expect(await updateDecisionTask({ taskId: K.archived, status: "DONE", priority: "HIGH" }))
      .toEqual({ ok: false, message: INACTIVE_REASON_WRITE_ERROR.TRANSFER_ARCHIVED });
    expect(await updateDecisionTask({ taskId: K.archivedDone, status: "TODO", priority: "HIGH" }))
      .toEqual({ ok: false, message: INACTIVE_REASON_WRITE_ERROR.TRANSFER_ARCHIVED });
    expect(await storedTasks()).toEqual(before);
    expect(await owner!.auditLog.count({ where: { actorEmail: EMAIL } })).toBe(0);

    expect(await updateDecisionTask({ taskId: K.active, status: "IN_PROGRESS", priority: "HIGH" }))
      .toEqual({ ok: true, id: K.active });
    expect(await updateDecisionTask({ taskId: K.legacyFollowUp, status: "DONE", priority: "NORMAL" }))
      .toEqual({ ok: true, id: K.legacyFollowUp });
    const after = await owner!.decisionTask.findMany({ where: { id: { in: [K.active, K.legacyFollowUp] } }, orderBy: { id: "asc" } });
    expect(after.map((row) => [row.id, row.status, row.completed_by])).toEqual([
      [K.active, "IN_PROGRESS", null], [K.legacyFollowUp, "DONE", EMAIL],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });
});
