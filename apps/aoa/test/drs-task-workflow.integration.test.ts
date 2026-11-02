import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DRS_TASKS, type DrsTaskStatus, type DrsWorkflowTaskRow } from "@/lib/data/drs-workflow";

const { authSpy, webhookSpy, assetMapSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), webhookSpy: vi.fn(), assetMapSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  getAssetMapApprovalSnapshot: assetMapSpy, listAssignableAssetMapAccounts: vi.fn(),
}));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: vi.fn(), getAcatStatusByRecordId: vi.fn(), AcatStatusError: class extends Error {},
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: webhookSpy }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/flags")>()),
  slackCloseoutEnabled: () => true, checklistStageGateEnabled: () => true,
  transferDealSourcedRedesignEnabled: () => true,
}));

const RUN = process.env.DRS_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-DRS-TASK";
const IDS = ["lifecycle", "route", "race"].map((suffix) => `${PREFIX}-${suffix}`);
const OPS = { role: "OPERATIONS", email: "zztest-drs-task-ops@example.invalid" };
const CS = { role: "CLIENT_SERVICE", email: "zztest-drs-task-cs@example.invalid" };

function syntheticUrl(raw: string | undefined, roles: string[]): URL {
  if (!raw) throw new Error("explicit_drs_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "55439" || url.pathname !== "/aoa_drs_synthetic" || !roles.includes(url.username)
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_drs_synthetic_database_required");
  }
  return url;
}

RUN("DRS tasks under app_rw and RLS on isolated synthetic PostgreSQL", () => {
  let owner: PrismaClient | undefined;
  let appPrisma: typeof import("@/lib/db").prisma;
  let withUserScope: typeof import("@/lib/rls").withUserScope;
  let approveFundingPlan: typeof import("@/app/(authenticated)/asset-transfer/actions").approveFundingPlan;
  let setStage: typeof import("@/app/(authenticated)/asset-transfer/actions").setStage;
  let updateDecisionTask: typeof import("@/app/(authenticated)/(workflow)/decision-center/actions").updateDecisionTask;
  let getDrsWorkflowTasks: typeof import("@/lib/data/drs-workflow-store").getDrsWorkflowTasks;
  let listDecisionTasks: typeof import("@/lib/data/decision-cases").listDecisionTasks;

  async function cleanup() {
    if (!owner) return;
    const taskIds = (await owner.decisionTask.findMany({ where: { transfer_id: { in: IDS } }, select: { id: true } })).map((row) => row.id);
    await owner.decisionTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferFundingPlanApproval.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferSlackItem.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferSlackCloseout.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transfer.deleteMany({ where: { id: { in: IDS } } });
    await owner.auditLog.deleteMany({ where: { entityId: { in: IDS }, actorEmail: { in: [OPS.email, CS.email] } } });
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${`${PREFIX}-%`}`;
    if (taskIds.length) await owner.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(taskIds)})`);
  }

  async function seed(id: string) {
    await owner!.transfer.create({ data: {
      id, source: "APP", client_first_name: "ZZTEST", client_last_name: "DRS Task Synthetic",
      household_name: "ZZTEST DRS Task Synthetic", value: "199.00", stage: "DECISION", owner_kind: "OPERATIONS",
    } });
    expect(await approveFundingPlan(id, { baseVersion: 0, fundingType: "DRS", basisDecisions: [], partialPositions: [], note: "" }))
      .toMatchObject({ ok: true, version: 1 });
  }

  function as(identity: typeof OPS) {
    authSpy.mockResolvedValue({ user: { email: identity.email, role: identity.role } });
  }

  async function update(row: DrsWorkflowTaskRow, status: DrsTaskStatus = "DONE") {
    return updateDecisionTask({ taskId: row.id, status, priority: row.priority,
      expectedUpdatedAt: row.updatedAt, expectedFundingPlanVersion: row.fundingPlanVersion });
  }

  beforeAll(async () => {
    const explicit = syntheticUrl(process.env.DRS_TEST_DATABASE_URL, ["app_rw"]);
    const runtime = syntheticUrl(process.env.DATABASE_URL, ["app_rw"]);
    const cleanupUrl = syntheticUrl(process.env.DRS_TEST_CLEANUP_URL, ["aoa", "postgres"]);
    if (runtime.href !== explicit.href || runtime.host !== cleanupUrl.host || runtime.pathname !== cleanupUrl.pathname) {
      throw new Error("drs_synthetic_connections_must_match");
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl.href });
    ({ withUserScope } = await import("@/lib/rls"));
    ({ approveFundingPlan, setStage } = await import("@/app/(authenticated)/asset-transfer/actions"));
    ({ updateDecisionTask } = await import("@/app/(authenticated)/(workflow)/decision-center/actions"));
    ({ getDrsWorkflowTasks } = await import("@/lib/data/drs-workflow-store"));
    ({ listDecisionTasks } = await import("@/lib/data/decision-cases"));
    ({ prisma: appPrisma } = await import("@/lib/db"));
    const [scope] = await withUserScope(OPS, (tx) => tx.$queryRaw<Array<{ username: string; superuser: boolean; bypassrls: boolean }>>`
      SELECT current_user AS username, rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(scope).toEqual({ username: "app_rw", superuser: false, bypassrls: false });
    await cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    as(OPS);
    assetMapSpy.mockRejectedValue(new Error("DRS must not read ACAT asset maps"));
  });

  afterAll(async () => {
    try { await cleanup(); } finally { await owner?.$disconnect(); await appPrisma?.$disconnect(); }
  });

  it("runs CS and Ops preparation, Apex confirmation, and Funded follow-ups without legacy Slack", async () => {
    const id = IDS[0];
    await seed(id);
    let rows = await getDrsWorkflowTasks(OPS, id);
    expect(rows).toHaveLength(8);
    expect(await setStage(id, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    as(CS);
    expect(await update(rows[3])).toMatchObject({ ok: false, message: expect.stringMatching(/Operations/) });
    for (const task of rows.slice(0, 3)) expect(await update(task)).toMatchObject({ ok: true });
    as(OPS);
    for (const task of rows.slice(3, 5)) expect(await update(task)).toMatchObject({ ok: true });
    expect(await update(rows[5])).toMatchObject({ ok: false, message: expect.stringMatching(/In transfer/) });
    expect(await setStage(id, "IN_TRANSFER")).toEqual({ ok: true, warnings: [] });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    rows = await getDrsWorkflowTasks(OPS, id);
    expect(await update(rows[0], "TODO")).toMatchObject({ ok: false, message: expect.stringMatching(/Preparation/) });
    expect(await update(rows[5])).toMatchObject({ ok: true });
    expect(await setStage(id, "FUNDED")).toEqual({ ok: true, warnings: [] });
    const funded = await getDrsWorkflowTasks(OPS, id);
    expect(funded.slice(6).map((task) => task.status)).toEqual(["TODO", "TODO"]);
    const active = (await listDecisionTasks(CS)).filter((task) => task.transferId === id && task.status !== "DONE");
    expect(active.map((task) => task.drs?.key).sort()).toEqual(["client-communication", "reconciliation"]);
    expect(active.every((task) => task.drs?.stage === "FUNDED")).toBe(true);
    expect(await update(funded[6])).toMatchObject({ ok: true });
    as(CS);
    expect(await update(funded[7])).toMatchObject({ ok: true });
    const persisted = await owner!.transfer.findUniqueOrThrow({ where: { id }, include: { decision_tasks: true, tasks: true } });
    expect(persisted.stage).toBe("FUNDED");
    expect(persisted.decision_tasks.every((task) => task.status === "DONE" && task.completed_at !== null)).toBe(true);
    expect(persisted.tasks).toEqual([]);
    expect(await owner!.transferSlackCloseout.count({ where: { transfer_id: id } })).toBe(0);
    expect(webhookSpy).not.toHaveBeenCalled();
    expect(assetMapSpy).not.toHaveBeenCalled();
  });

  it("preserves same-route work, rejects stale versions, and restarts only after a different approved route", async () => {
    const id = IDS[1];
    await seed(id);
    const first = await getDrsWorkflowTasks(OPS, id);
    expect(await update(first[0])).toMatchObject({ ok: true });
    const done = (await getDrsWorkflowTasks(OPS, id))[0];
    expect(await approveFundingPlan(id, { baseVersion: 1, fundingType: "DRS", basisDecisions: [], partialPositions: [], note: "" }))
      .toMatchObject({ ok: true, version: 2 });
    const reapproved = await getDrsWorkflowTasks(OPS, id);
    expect(reapproved[0]).toMatchObject({ id: done.id, status: "DONE", completedAt: done.completedAt, fundingPlanVersion: 2 });
    expect(await update(first[1])).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(await approveFundingPlan(id, { baseVersion: 2, fundingType: "CHECK", basisDecisions: [], partialPositions: [], note: "" }))
      .toMatchObject({ ok: true, version: 3 });
    expect((await listDecisionTasks(OPS)).filter((task) => task.transferId === id)).toEqual([]);
    expect(await update(reapproved[1])).toMatchObject({ ok: false, message: expect.stringMatching(/no longer uses DRS/) });
    expect((await owner!.decisionTask.findUniqueOrThrow({ where: { id: done.id } })).status).toBe("DONE");
    expect(await approveFundingPlan(id, { baseVersion: 3, fundingType: "DRS", basisDecisions: [], partialPositions: [], note: "" }))
      .toMatchObject({ ok: true, version: 4 });
    const restarted = await getDrsWorkflowTasks(OPS, id);
    expect(restarted.map((task) => task.id)).toEqual(first.map((task) => task.id));
    expect(restarted.every((task) => task.status === "TODO" && task.completedAt === null && task.completedBy === null)).toBe(true);
    await owner!.transfer.update({ where: { id }, data: { archived_at: new Date() } });
    expect(await update(restarted[0])).toMatchObject({ ok: false, message: expect.stringMatching(/Archived/) });
  });

  it("serializes competing task updates and only audits the successful write", async () => {
    const id = IDS[2];
    await seed(id);
    const task = (await getDrsWorkflowTasks(OPS, id))[0];
    const results = await Promise.all([update(task, "IN_PROGRESS"), update(task, "DONE")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, message: expect.stringMatching(/changed/) }]);
    const audits = await owner!.auditLog.findMany({ where: { entityId: id, action: "decision.task_update" } });
    expect(audits).toHaveLength(1);
    const row = await owner!.decisionTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(JSON.parse(audits[0].detail!).toStatus).toBe(row.status);
    expect((await getDrsWorkflowTasks(OPS, id))).toHaveLength(DRS_TASKS.length);
  });
});
