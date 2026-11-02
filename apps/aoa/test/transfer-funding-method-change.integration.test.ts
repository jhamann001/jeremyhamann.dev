import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordedFundingMethod, type FundingMethodChangeInput } from "@/lib/data/transfer-funding-method-change";
import { DRS_TASKS } from "@/lib/data/drs-workflow";

const { authSpy, revalidateSpy, assetMapSpy, webhookSpy, legacyReadinessSpy, checklistGateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), revalidateSpy: vi.fn(), assetMapSpy: vi.fn(), webhookSpy: vi.fn(),
  legacyReadinessSpy: vi.fn(), checklistGateSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
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
  transferDealSourcedRedesignEnabled: legacyReadinessSpy,
  checklistStageGateEnabled: checklistGateSpy,
}));

// Never inherit an ambient dev/production database. Every connection is checked
// before importing lib/db, and cleanup is scoped to this suite's synthetic IDs.
const RUN = process.env.DRS_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-METHOD-CORRECTION";
const OPS = { role: "OPERATIONS", email: "zztest-method-ops@example.invalid" };
const REASON = "ZZTEST private note: confirmed incoming ACH instead of the planned wire";
const IDS = new Set<string>();

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

RUN("funding method changes under app_rw and RLS on isolated PostgreSQL", () => {
  let owner: PrismaClient | undefined;
  let appPrisma: typeof import("@/lib/db").prisma;
  let withUserScope: typeof import("@/lib/rls").withUserScope;
  let changeFundingMethod: typeof import("@/app/(authenticated)/asset-transfer/funding-method-actions").changeFundingMethod;
  let prepareFundingMethodChange: typeof import("@/app/(authenticated)/asset-transfer/funding-method-actions").prepareFundingMethodChange;
  let confirmFundingMethodInitiated: typeof import("@/app/(authenticated)/asset-transfer/funding-method-actions").confirmFundingMethodInitiated;
  let approveFundingPlan: typeof import("@/app/(authenticated)/asset-transfer/actions").approveFundingPlan;
  let setStage: typeof import("@/app/(authenticated)/asset-transfer/actions").setStage;
  let updateDecisionTask: typeof import("@/app/(authenticated)/(workflow)/decision-center/actions").updateDecisionTask;
  let getDrsWorkflowTasks: typeof import("@/lib/data/drs-workflow-store").getDrsWorkflowTasks;
  let listDecisionTasks: typeof import("@/lib/data/decision-cases").listDecisionTasks;
  let syncPartialAcatExecutionTasks: typeof import("@/lib/data/decision-case-workflow").syncPartialAcatExecutionTasks;

  const input = (stage: FundingMethodChangeInput["expectedStage"], overrides: Partial<FundingMethodChangeInput> = {}): FundingMethodChangeInput => ({
    expectedStage: stage, basePlanVersion: 1, baseMethodRevision: 0,
    fundingType: "ACH", reason: `  ${REASON}  `, affectedWorkReviewed: true, ...overrides,
  });

  async function dropAuditFailureTrigger() {
    if (!owner) return;
    await owner.$executeRawUnsafe('DROP TRIGGER IF EXISTS zztest_method_correction_audit_failure ON audit."AuditLog"');
    await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS audit.zztest_method_correction_audit_failure()");
  }

  async function cleanup() {
    if (!owner) return;
    await dropAuditFailureTrigger();
    const ids = (await owner.transfer.findMany({ where: { id: { startsWith: `${PREFIX}-` } }, select: { id: true } })).map((row) => row.id);
    const taskIds = (await owner.decisionTask.findMany({ where: { transfer_id: { in: ids } }, select: { id: true } })).map((row) => row.id);
    await owner.decisionTask.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.decisionCaseEvent.deleteMany({ where: { decision: { transfer_id: { in: ids } } } });
    await owner.decisionCase.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferFundingMethodCorrection.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferFundingPlanApproval.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferPositionFlag.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferDecision.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferSlackItem.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferSlackCloseout.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transferTask.deleteMany({ where: { transfer_id: { in: ids } } });
    await owner.transfer.deleteMany({ where: { id: { in: ids } } });
    await owner.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${`${PREFIX}-%`}`;
    if (taskIds.length) await owner.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE row_pk IN (${Prisma.join(taskIds)})`);
  }

  async function seed(suffix: string, stage: FundingMethodChangeInput["expectedStage"] = "IN_TRANSFER", exception = true) {
    const id = `${PREFIX}-${suffix}`;
    if (IDS.has(id)) throw new Error(`duplicate_synthetic_id:${id}`);
    IDS.add(id);
    const approvedAt = new Date("2026-09-20T12:00:00.000Z");
    await owner!.transfer.create({ data: {
      id, source: "APP", client_first_name: "ZZTEST", client_last_name: "Funding Method Synthetic",
      value: "100.00", stage, stage_entered_at: approvedAt, owner_kind: "OPERATIONS", owner_name: "Synthetic Owner",
      next_step: "Preserve next step", next_step_owner: "Operations",
      acat_record_id: `${id}-tracker`, funding_type: "WIRE", funding_plan_version: 1,
      funding_plan_complete: true, funding_plan_approved_at: approvedAt, funding_plan_approved_by: OPS.email,
      accounts_opened_at_apex: true, funding_initiated: true, cash_in_flight: true,
      tasks: { create: { id: `${id}-task`, title: "Synthetic completed work", sort_order: 1,
        done: true, completed_at: approvedAt, completed_by: OPS.email } },
      funding_plan_approvals: { create: { id: `${id}-approval`, version: 1, funding_type: "WIRE",
        snapshot: { source: "none", positions: [], originalMarker: "DO NOT OVERWRITE" },
        note: "Original approved wire plan", approved_at: approvedAt, approved_by: OPS.email } },
      ...(exception ? { decision_cases: { create: { id: `${id}-exception`, source: "MANUAL", source_key: `${id}-exception`,
        question: "Synthetic blocking exception must survive correction", owner_team: "OPERATIONS", blocks_transfer: true } } } : {}),
    } });
    return id;
  }

  async function reload(id: string) {
    return withUserScope(OPS, async (tx) => ({
      transfer: await tx.transfer.findUniqueOrThrow({ where: { id }, include: {
        tasks: { orderBy: { id: "asc" } }, decision_tasks: { orderBy: { id: "asc" } },
        decision_cases: { orderBy: { id: "asc" } }, funding_plan_approvals: { orderBy: { version: "asc" } },
      } }),
      corrections: await tx.transferFundingMethodCorrection.findMany({ where: { transfer_id: id }, orderBy: { revision: "asc" } }),
      audits: await tx.auditLog.findMany({ where: { entityId: id, entityType: "transfer" }, orderBy: { id: "asc" } }),
    }));
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
    ({ changeFundingMethod, prepareFundingMethodChange, confirmFundingMethodInitiated } = await import("@/app/(authenticated)/asset-transfer/funding-method-actions"));
    ({ approveFundingPlan, setStage } = await import("@/app/(authenticated)/asset-transfer/actions"));
    ({ updateDecisionTask } = await import("@/app/(authenticated)/(workflow)/decision-center/actions"));
    ({ getDrsWorkflowTasks } = await import("@/lib/data/drs-workflow-store"));
    ({ listDecisionTasks } = await import("@/lib/data/decision-cases"));
    ({ syncPartialAcatExecutionTasks } = await import("@/lib/data/decision-case-workflow"));
    ({ prisma: appPrisma } = await import("@/lib/db"));
    const [scope] = await withUserScope(OPS, (tx) => tx.$queryRaw<Array<{ username: string; superuser: boolean; bypassrls: boolean; role: string }>>`
      SELECT current_user AS username, rolsuper AS superuser, rolbypassrls AS bypassrls,
      current_setting('app.user_role') AS role FROM pg_roles WHERE rolname = current_user`);
    expect(scope).toEqual({ username: "app_rw", superuser: false, bypassrls: false, role: "OPERATIONS" });
    await cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authSpy.mockResolvedValue({ user: OPS });
    assetMapSpy.mockRejectedValue(new Error("Cash/DRS corrections must not read ACAT asset maps"));
    legacyReadinessSpy.mockReturnValue(false);
    checklistGateSpy.mockReturnValue(false);
  });

  afterAll(async () => {
    try { await cleanup(); } finally { await owner?.$disconnect(); await appPrisma?.$disconnect(); }
  });

  it.each(["DECISION", "IN_TRANSFER", "FUNDED"] as const)("corrects WIRE to ACH during %s and preserves the existing work and history", async (stage) => {
    const id = await seed(`cash-${stage}`, stage);
    const before = await reload(id);
    expect(await changeFundingMethod(id, input(stage))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({
      stage, stage_entered_at: before.transfer.stage_entered_at, owner_kind: before.transfer.owner_kind,
      owner_name: before.transfer.owner_name, next_step: before.transfer.next_step, next_step_owner: before.transfer.next_step_owner,
      acat_record_id: before.transfer.acat_record_id, acat_transfer_id: before.transfer.acat_transfer_id,
      funding_method_revision: 1,
    });
    expect(after.transfer.tasks).toEqual(before.transfer.tasks);
    expect(after.transfer.decision_tasks).toEqual(before.transfer.decision_tasks);
    expect(after.transfer.decision_cases).toEqual(before.transfer.decision_cases);
    expect(after.transfer.funding_plan_approvals[0]).toEqual(before.transfer.funding_plan_approvals[0]);
    expect(after.corrections).toHaveLength(1);
    expect(after.corrections[0]).toMatchObject({
      revision: 1, stage, previous_funding_type: "WIRE", funding_type: "ACH", reason: REASON, changed_by: OPS.email,
      kind: stage === "FUNDED" ? "RECORDED_CORRECTION" : "PLAN_REVISION", base_plan_version: 1,
      plan_version: stage === "FUNDED" ? 1 : 2,
    });
    expect(after.corrections[0].changed_at).toBeInstanceOf(Date);
    if (stage === "FUNDED") {
      const { recorded_funding_type: _recorded, funding_method_revision: _revision, updated_at: _updated, updated_by: _actor, ...preserved } = after.transfer;
      const { recorded_funding_type: _oldRecorded, funding_method_revision: _oldRevision, updated_at: _oldUpdated, updated_by: _oldActor, ...original } = before.transfer;
      expect(preserved).toEqual(original);
      expect(after.transfer.recorded_funding_type).toBe("ACH");
    } else {
      expect(after.transfer.funding_type).toBe("ACH");
      expect(after.transfer.funding_plan_version).toBe(2);
      expect(after.transfer.funding_plan_complete).toBe(true);
      expect(after.transfer.funding_plan_approvals).toHaveLength(2);
      expect(after.transfer.funding_plan_approvals[1]).toMatchObject({ version: 2, funding_type: "ACH", approved_by: OPS.email });
      expect(after.transfer.funding_initiated).toBe(before.transfer.funding_initiated);
      expect(after.transfer.cash_in_flight).toBe(before.transfer.cash_in_flight);
    }
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].detail).not.toContain(REASON);
    const auditRows = await owner!.$queryRaw<Array<{ entry: unknown }>>`
      SELECT to_jsonb(r) AS entry FROM audit.row_change r WHERE row_pk IN (${id}, ${after.corrections[0].id})`;
    expect(JSON.stringify(auditRows)).not.toContain(REASON);
    expect(revalidateSpy).toHaveBeenCalledWith(`/asset-transfer/${id}`);
    expect(assetMapSpy).not.toHaveBeenCalled();
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it.each([
    { name: "reason", patch: { reason: "  " } },
    { name: "review", patch: { affectedWorkReviewed: false } },
    { name: "stale-stage", patch: { expectedStage: "DECISION" as const } },
    { name: "stale-plan", patch: { basePlanVersion: 0 } },
    { name: "stale-method", patch: { baseMethodRevision: 1 } },
    { name: "same-method", patch: { fundingType: "WIRE" as const } },
  ])("rejects $name without writing anything", async ({ name, patch }) => {
    const id = await seed(name);
    const before = await reload(id);
    expect(await changeFundingMethod(id, input("IN_TRANSFER", patch))).toMatchObject({ ok: false });
    expect(await reload(id)).toEqual(before);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it.each(["CLIENT_SERVICE", "ADVISOR", "VIEWER", "unknown"])("rejects %s and keeps restricted correction history hidden", async (role) => {
    const id = await seed(`role-${role}`, "FUNDED");
    expect(await changeFundingMethod(id, input("FUNDED"))).toEqual({ ok: true });
    const before = await reload(id);
    authSpy.mockResolvedValue({ user: { email: "zztest-unprivileged@example.invalid", role } });
    expect(await changeFundingMethod(id, input("FUNDED", { baseMethodRevision: 1, fundingType: "CHECK" }))).toMatchObject({ ok: false });
    expect(await reload(id)).toEqual(before);
    expect(await withUserScope({ role, email: "zztest-unprivileged@example.invalid" }, (tx) =>
      tx.transferFundingMethodCorrection.findMany({ where: { transfer_id: id } }))).toEqual([]);
    await expect(withUserScope({ role, email: "zztest-unprivileged@example.invalid" }, (tx) => tx.transferFundingMethodCorrection.create({
      data: { transfer_id: id, revision: 2, kind: "RECORDED_CORRECTION", previous_funding_type: "ACH", funding_type: "CHECK",
        stage: "FUNDED", base_plan_version: 1, plan_version: 1, reason: "Forbidden direct write", affected_work_snapshot: {},
        changed_by: "zztest-unprivileged@example.invalid" },
    }))).rejects.toThrow();
  });

  it("allows an authenticated administrator", async () => {
    const id = await seed("admin", "FUNDED");
    authSpy.mockResolvedValue({ user: { email: "zztest-admin@example.invalid", role: "ADMIN" } });
    expect(await changeFundingMethod(id, input("FUNDED"))).toEqual({ ok: true });
    expect((await reload(id)).corrections[0].changed_by).toBe("zztest-admin@example.invalid");
  });

  it("rejects missing authentication, missing actor identity, archived and missing records", async () => {
    const id = await seed("ineligible");
    const before = await reload(id);
    for (const session of [null, { user: { role: "OPERATIONS" } }]) {
      authSpy.mockResolvedValue(session);
      expect(await changeFundingMethod(id, input("IN_TRANSFER"))).toMatchObject({ ok: false });
    }
    expect(await reload(id)).toEqual(before);
    authSpy.mockResolvedValue({ user: OPS });
    await owner!.transfer.update({ where: { id }, data: { archived_at: new Date() } });
    const archived = await reload(id);
    expect(await changeFundingMethod(id, input("IN_TRANSFER"))).toMatchObject({ ok: false });
    expect(await reload(id)).toEqual(archived);
    expect(await changeFundingMethod(`${PREFIX}-missing`, input("IN_TRANSFER"))).toMatchObject({ ok: false });
  });

  it("retains append-only correction history and protects the recorded actor", async () => {
    const id = await seed("immutable", "FUNDED");
    expect(await changeFundingMethod(id, input("FUNDED"))).toEqual({ ok: true });
    const first = (await reload(id)).corrections[0];
    await expect(withUserScope(OPS, (tx) => tx.transferFundingMethodCorrection.update({
      where: { id: first.id }, data: { reason: "attempt to rewrite history" },
    }))).rejects.toThrow(/permission denied/i);
    await expect(withUserScope(OPS, (tx) => tx.transferFundingMethodCorrection.delete({ where: { id: first.id } })))
      .rejects.toThrow(/permission denied/i);
    await expect(withUserScope(OPS, (tx) => tx.transferFundingMethodCorrection.create({ data: {
      transfer_id: id, revision: 2, kind: "RECORDED_CORRECTION", previous_funding_type: "ACH", funding_type: "CHECK",
      stage: "FUNDED", base_plan_version: 1, plan_version: 1, reason: "Impersonation attempt", affected_work_snapshot: {},
      changed_by: "someone-else@example.invalid",
    } }))).rejects.toThrow();
    expect(await changeFundingMethod(id, input("FUNDED", { baseMethodRevision: 1, fundingType: "CHECK" }))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.corrections[0]).toEqual(first);
    expect(after.corrections[1]).toMatchObject({ revision: 2, previous_funding_type: "ACH", funding_type: "CHECK" });
    expect(after.transfer.funding_type).toBe("WIRE");
    expect(after.transfer.recorded_funding_type).toBe("CHECK");
  });

  it("serializes competing corrections so only one revision and one audit commit", async () => {
    const id = await seed("race", "FUNDED");
    const results = await Promise.all([
      changeFundingMethod(id, input("FUNDED")),
      changeFundingMethod(id, input("FUNDED", { fundingType: "CHECK" })),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const after = await reload(id);
    expect(after.corrections).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
    expect(after.transfer.funding_method_revision).toBe(1);
    expect(after.transfer.recorded_funding_type).toBe(after.corrections[0].funding_type);
  });

  it("rolls back the method, approval, route tasks and correction if the audit insert fails", async () => {
    const id = await seed("audit-rollback");
    const before = await reload(id);
    // The trigger targets only this suite's one synthetic transfer, on the
    // allowlisted local database; it is removed in finally and suite cleanup.
    await owner!.$executeRawUnsafe(`CREATE FUNCTION audit.zztest_method_correction_audit_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."entityId" = '${PREFIX}-audit-rollback' THEN RAISE EXCEPTION 'synthetic correction audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await owner!.$executeRawUnsafe('CREATE TRIGGER zztest_method_correction_audit_failure BEFORE INSERT ON audit."AuditLog" FOR EACH ROW EXECUTE FUNCTION audit.zztest_method_correction_audit_failure()');
    try {
      const result = await changeFundingMethod(id, input("IN_TRANSFER", { fundingType: "DRS" })).catch(() => ({ ok: false }));
      expect(result).toMatchObject({ ok: false });
      expect(await reload(id)).toEqual(before);
      expect(revalidateSpy).not.toHaveBeenCalled();
    } finally { await dropAuditFailureTrigger(); }
    // The identical reviewed request succeeds once audit persistence is
    // available, proving the rollback path was not just invalid input.
    expect(await changeFundingMethod(id, input("IN_TRANSFER", { fundingType: "DRS" }))).toEqual({ ok: true });
    expect((await reload(id)).transfer.decision_tasks).toHaveLength(DRS_TASKS.length);
  });

  it("records a Funded DRS correction without initiating DRS execution or changing completed work", async () => {
    const id = await seed("funded-drs", "FUNDED");
    const before = await reload(id);
    expect(await changeFundingMethod(id, input("FUNDED", { fundingType: "DRS" }))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({ stage: "FUNDED", funding_type: "WIRE", recorded_funding_type: "DRS", funding_plan_version: 1 });
    expect(after.transfer.funding_plan_approvals).toEqual(before.transfer.funding_plan_approvals);
    expect(after.transfer.tasks).toEqual(before.transfer.tasks);
    expect(after.transfer.decision_tasks).toEqual([]);
    expect(await getDrsWorkflowTasks(OPS, id)).toEqual([]);
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it("advances a confirmed manual plan from Preparation under the legacy readiness gate without a cash flag", async () => {
    legacyReadinessSpy.mockReturnValue(true);
    checklistGateSpy.mockReturnValue(false);
    const id = await seed("preparation-manual-gate", "DECISION", false);
    expect(await changeFundingMethod(id, input("DECISION", { fundingType: "MANUAL" }))).toEqual({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ stage: "DECISION", funding_type: "MANUAL",
      funding_route_change_pending: true, funding_initiated: false, cash_in_flight: false });
    expect(await setStage(id, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });
    expect(await confirmFundingMethodInitiated(id, { expectedStage: "DECISION", basePlanVersion: 2, baseMethodRevision: 1 }))
      .toEqual({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ funding_route_change_pending: false,
      funding_initiated: true, cash_in_flight: false });
    expect(await setStage(id, "IN_TRANSFER")).toMatchObject({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ stage: "IN_TRANSFER", cash_in_flight: false });
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it("allows DRS preparation catch-up while In transfer and blocks Funded until every prerequisite is done", async () => {
    const id = await seed("active-drs", "IN_TRANSFER", false);
    expect(await changeFundingMethod(id, input("IN_TRANSFER", { fundingType: "DRS" }))).toEqual({ ok: true });
    let rows = await getDrsWorkflowTasks(OPS, id);
    expect(rows).toHaveLength(DRS_TASKS.length);
    expect(rows.every((row) => row.status === "TODO")).toBe(true);
    const update = (row: typeof rows[number]) => updateDecisionTask({ taskId: row.id, status: "DONE", priority: row.priority,
      expectedUpdatedAt: row.updatedAt, expectedFundingPlanVersion: row.fundingPlanVersion });
    // Recording movement alone must not bypass the newly required paperwork.
    expect(await update(rows.find((row) => row.key === "apex-confirmed")!)).toMatchObject({ ok: true });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    expect((await reload(id)).transfer.stage).toBe("IN_TRANSFER");
    rows = await getDrsWorkflowTasks(OPS, id);
    for (const task of rows.filter((row) => DRS_TASKS.find((definition) => definition.key === row.key)?.requiredBefore === "IN_TRANSFER")) {
      expect(await update(task)).toMatchObject({ ok: true });
      expect((await reload(id)).transfer.stage).toBe("IN_TRANSFER");
    }
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: true });
    expect((await reload(id)).transfer.stage).toBe("FUNDED");
  });

  it("preserves inactive partial-ACAT tasks instead of falsely completing them", async () => {
    const id = await seed("retired-partial");
    await owner!.transfer.update({ where: { id }, data: { funding_type: "ACAT_PARTIAL" } });
    await owner!.transferFundingPlanApproval.update({ where: { id: `${id}-approval` }, data: { funding_type: "ACAT_PARTIAL" } });
    await withUserScope(OPS, (tx) => syncPartialAcatExecutionTasks(tx, OPS, { transferId: id, active: true }));
    const before = await reload(id);
    expect(before.transfer.decision_tasks).toHaveLength(3);
    expect(await changeFundingMethod(id, input("IN_TRANSFER"))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer.decision_tasks).toEqual(before.transfer.decision_tasks);
    expect(after.transfer.decision_tasks.every((task) => task.status === "TODO" && task.completed_at === null && task.completed_by === null)).toBe(true);
    expect(after.corrections).toHaveLength(1);
    expect(after.corrections[0].affected_work_snapshot).toEqual({
      reviewed: true, acatLinked: true, assetMapLinked: false,
      readinessBefore: { fundingInitiated: true, cashInFlight: true },
      tasksBefore: before.transfer.decision_tasks.map((task) => ({
        id: task.id, taskKey: task.task_key, status: task.status,
        completedAt: task.completed_at?.toISOString() ?? null, completedBy: task.completed_by,
      })),
    });
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      action: "transfer.funding_method_change", actorEmail: OPS.email, actorRole: OPS.role,
      entityType: "transfer", entityId: id,
    });
    // The replacement business audit carries controlled metadata only. The
    // populated prior-task snapshot remains in the restricted correction row.
    expect(JSON.parse(after.audits[0].detail ?? "null")).toEqual({
      revision: 1, kind: "PLAN_REVISION", fromFundingType: "ACAT_PARTIAL", fundingType: "ACH",
      stage: "IN_TRANSFER", basePlanVersion: 1, planVersion: 2, source: "none",
      executionTaskCount: 0, drsTaskCount: 0, affectedWorkReviewed: true, hasReason: true,
    });
    const genericRows = await owner!.$queryRaw<Array<{ table_name: string; row_pk: string; changed: unknown }>>`
      SELECT table_name, row_pk, changed FROM audit.row_change
      WHERE row_pk IN (${id}, ${after.corrections[0].id})`;
    expect(genericRows.filter((row) => row.row_pk === after.corrections[0].id)).toEqual([]);
    const generalAudit = JSON.stringify({
      business: after.audits.map(({ action, actorEmail, actorRole, entityId, detail }) =>
        ({ action, actorEmail, actorRole, entityId, detail })),
      generic: genericRows,
    });
    expect(generalAudit).not.toContain(REASON);
    expect(generalAudit).not.toContain("affected_work_snapshot");
    expect(generalAudit).not.toContain("tasksBefore");
    for (const task of before.transfer.decision_tasks) expect(generalAudit).not.toContain(task.id);
    const projected = (await listDecisionTasks(OPS)).filter((task) => task.transferId === id && !task.decisionId);
    expect(projected).toHaveLength(3);
    expect(projected.every((task) => task.context?.inactiveReason === "ROUTE_CHANGED" && task.status === "TODO")).toBe(true);
    expect(await updateDecisionTask({ taskId: projected[0].id, status: "DONE", priority: projected[0].priority,
      expectedUpdatedAt: projected[0].fundingMethod?.updatedAt, expectedFundingPlanVersion: 2, expectedFundingMethodRevision: 1 }))
      .toMatchObject({ ok: false });
    expect((await reload(id)).transfer.decision_tasks).toEqual(before.transfer.decision_tasks);
  });

  it("requires a new initiation confirmation after switching from ACAT to cash", async () => {
    const id = await seed("new-cash-initiation", "IN_TRANSFER", false);
    await owner!.transfer.update({ where: { id }, data: { funding_type: "ACAT_FULL" } });
    expect(await changeFundingMethod(id, input("IN_TRANSFER"))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({ funding_type: "ACH", funding_route_change_pending: true,
      funding_initiated: false, cash_in_flight: false, stage: "IN_TRANSFER" });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    const confirmation = { expectedStage: "IN_TRANSFER" as const, basePlanVersion: 2, baseMethodRevision: 1 };
    expect(await confirmFundingMethodInitiated(id, { ...confirmation, baseMethodRevision: 0 })).toMatchObject({ ok: false });
    expect((await reload(id)).transfer.funding_route_change_pending).toBe(true);
    expect(await confirmFundingMethodInitiated(id, confirmation)).toEqual({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ funding_route_change_pending: false, funding_initiated: true, cash_in_flight: true });
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it.each([
    { previous: "WIRE" as const, next: "MANUAL" as const, cashInFlight: false },
    { previous: "MANUAL" as const, next: "ACH" as const, cashInFlight: true },
  ])("requires fresh initiation for $previous to $next because manual transfers are not cash", async ({ previous, next, cashInFlight }) => {
    const id = await seed(`manual-family-${previous}`, "IN_TRANSFER", false);
    await owner!.transfer.update({ where: { id }, data: { funding_type: previous } });
    expect(await changeFundingMethod(id, input("IN_TRANSFER", { fundingType: next }))).toEqual({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ funding_type: next, funding_route_change_pending: true,
      funding_initiated: false, cash_in_flight: false, stage: "IN_TRANSFER" });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    expect(await confirmFundingMethodInitiated(id, { expectedStage: "IN_TRANSFER", basePlanVersion: 2, baseMethodRevision: 1 }))
      .toEqual({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ funding_route_change_pending: false,
      funding_initiated: true, cash_in_flight: cashInFlight });
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it("requires explicit new full-ACAT initiation after a partial-to-full change", async () => {
    const id = await seed("partial-to-full", "IN_TRANSFER", false);
    await owner!.transfer.update({ where: { id }, data: { funding_type: "ACAT_PARTIAL" } });
    await owner!.transferFundingPlanApproval.update({ where: { id: `${id}-approval` }, data: { funding_type: "ACAT_PARTIAL" } });
    await withUserScope(OPS, (tx) => syncPartialAcatExecutionTasks(tx, OPS, { transferId: id, active: true }));
    const before = await reload(id);
    expect(await changeFundingMethod(id, input("IN_TRANSFER", { fundingType: "ACAT_FULL" }))).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({ stage: "IN_TRANSFER", funding_type: "ACAT_FULL", funding_route_change_pending: true,
      funding_initiated: false, cash_in_flight: false });
    expect(after.transfer.decision_tasks).toEqual(before.transfer.decision_tasks);
    expect(after.transfer.funding_plan_approvals[0]).toEqual(before.transfer.funding_plan_approvals[0]);
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    expect(await confirmFundingMethodInitiated(id, { expectedStage: "IN_TRANSFER", basePlanVersion: 2, baseMethodRevision: 1 }))
      .toEqual({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ funding_route_change_pending: false,
      funding_initiated: true, cash_in_flight: false });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: true });
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it("clears an old factual override when a reopened transfer receives a new ordinary approved plan", async () => {
    const id = await seed("reopened-plan", "FUNDED", false);
    expect(await changeFundingMethod(id, input("FUNDED"))).toEqual({ ok: true });
    const corrected = await reload(id);
    expect(recordedFundingMethod(corrected.transfer)).toBe("ACH");
    expect(await setStage(id, "DECISION")).toMatchObject({ ok: true });
    expect(await approveFundingPlan(id, { baseVersion: 1, fundingType: "DRS", basisDecisions: [], partialPositions: [], note: "Reviewed reopened synthetic transfer" }))
      .toMatchObject({ ok: true, version: 2 });
    const revised = await reload(id);
    expect(revised.transfer).toMatchObject({ stage: "DECISION", funding_type: "DRS", recorded_funding_type: null, funding_plan_version: 2 });
    expect(revised.corrections).toEqual(corrected.corrections);
    expect(revised.transfer.funding_plan_approvals[0]).toEqual(corrected.transfer.funding_plan_approvals[0]);
    const update = (row: Awaited<ReturnType<typeof getDrsWorkflowTasks>>[number]) => updateDecisionTask({
      taskId: row.id, status: "DONE", priority: row.priority,
      expectedUpdatedAt: row.updatedAt, expectedFundingPlanVersion: row.fundingPlanVersion,
    });
    let rows = await getDrsWorkflowTasks(OPS, id);
    for (const task of rows.filter((row) => DRS_TASKS.find((definition) => definition.key === row.key)?.requiredBefore === "IN_TRANSFER")) {
      expect(await update(task)).toMatchObject({ ok: true });
    }
    expect(await setStage(id, "IN_TRANSFER")).toMatchObject({ ok: true });
    rows = await getDrsWorkflowTasks(OPS, id);
    expect(await update(rows.find((row) => row.key === "apex-confirmed")!)).toMatchObject({ ok: true });
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: true });
    const funded = await reload(id);
    expect(recordedFundingMethod(funded.transfer)).toBe("DRS");
    expect(funded.transfer.recorded_funding_type).toBeNull();
    expect(funded.corrections).toEqual(corrected.corrections);
    expect(funded.transfer.funding_plan_approvals).toHaveLength(2);
    expect(webhookSpy).not.toHaveBeenCalled();
  });

  it("reviews current partial-ACAT positions and creates new required work without marking it complete", async () => {
    const id = await seed("new-partial", "IN_TRANSFER", false);
    await owner!.transferDecision.create({ data: { id: `${id}-position`, transfer_id: id,
      symbol: "ZZTEST", description: "Synthetic security", value: "100", cost_basis: "50" } });
    const prepared = await prepareFundingMethodChange(id);
    if (!prepared.ok) throw new Error("expected synthetic preparation");
    const reviewed = input("IN_TRANSFER", { fundingType: "ACAT_PARTIAL", sourceFingerprint: prepared.sourceFingerprint,
      basisDecisions: [{ decisionId: `${id}-position`, decision: "BRING_IN" }] });
    expect(await changeFundingMethod(id, { ...reviewed, sourceFingerprint: undefined })).toMatchObject({ ok: false });
    expect(await changeFundingMethod(id, reviewed)).toEqual({ ok: true });
    const after = await reload(id);
    expect(after.transfer).toMatchObject({ funding_type: "ACAT_PARTIAL", stage: "IN_TRANSFER", funding_route_change_pending: true,
      funding_initiated: false, cash_in_flight: false, funding_plan_version: 2 });
    expect(after.transfer.funding_plan_approvals[1].snapshot).toMatchObject({ source: "transfer-decisions",
      positions: [expect.objectContaining({ decisionId: `${id}-position`, decision: "BRING_IN" })] });
    expect(after.transfer.decision_tasks).toHaveLength(3);
    expect(after.transfer.decision_tasks.every((task) => task.status === "TODO" && task.completed_at === null)).toBe(true);
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    expect(await confirmFundingMethodInitiated(id, { expectedStage: "IN_TRANSFER", basePlanVersion: 2, baseMethodRevision: 1 }))
      .toMatchObject({ ok: false });
    const rows = (await listDecisionTasks(OPS)).filter((task) => task.transferId === id && !task.decisionId);
    const submission = rows.find((task) => task.ownerTeam === "OPERATIONS")!;
    const reviewedTask = { taskId: submission.id, status: "DONE" as const, priority: submission.priority,
      expectedUpdatedAt: submission.fundingMethod!.updatedAt, expectedFundingPlanVersion: 2, expectedFundingMethodRevision: 1 };
    expect(await updateDecisionTask({ ...reviewedTask, expectedFundingMethodRevision: undefined })).toMatchObject({ ok: false });
    expect(await updateDecisionTask({ ...reviewedTask, expectedFundingPlanVersion: 1 })).toMatchObject({ ok: false });
    authSpy.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "zztest-method-cs@example.invalid" } });
    expect(await updateDecisionTask(reviewedTask)).toMatchObject({ ok: false });
    authSpy.mockResolvedValue({ user: OPS });
    for (const row of rows) {
      expect(await updateDecisionTask({ taskId: row.id, status: "DONE", priority: row.priority,
        expectedUpdatedAt: row.fundingMethod!.updatedAt, expectedFundingPlanVersion: 2, expectedFundingMethodRevision: 1 }))
        .toMatchObject({ ok: true });
    }
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: true });
    expect((await reload(id)).transfer).toMatchObject({ stage: "FUNDED", funding_route_change_pending: false, funding_initiated: true });
  });

  it("rejects a stale reviewed position source and keeps the ordinary approval action stage-restricted", async () => {
    const id = await seed("partial-source");
    await owner!.transferDecision.create({ data: { id: `${id}-position`, transfer_id: id, symbol: "ZZTEST", description: "Synthetic security", value: "100", cost_basis: "50" } });
    const prepared = await prepareFundingMethodChange(id);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected synthetic preparation");
    await owner!.transferDecision.create({ data: { id: `${id}-new-position`, transfer_id: id, symbol: "ZZNEW", description: "Added after review", value: "25", cost_basis: "10" } });
    const before = await reload(id);
    expect(await changeFundingMethod(id, input("IN_TRANSFER", {
      fundingType: "ACAT_PARTIAL", sourceFingerprint: prepared.sourceFingerprint,
      basisDecisions: [{ decisionId: `${id}-position`, decision: "BRING_IN" }],
    }))).toMatchObject({ ok: false });
    expect(await reload(id)).toEqual(before);
    expect(await approveFundingPlan(id, { baseVersion: 1, fundingType: "ACH", basisDecisions: [], partialPositions: [], note: "" }))
      .toMatchObject({ ok: false });
    expect(await reload(id)).toEqual(before);
  });
});
