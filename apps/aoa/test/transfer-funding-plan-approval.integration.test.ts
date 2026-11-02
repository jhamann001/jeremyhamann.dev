import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FundingPlanDraftInput } from "@/lib/data/transfer-plan-approval";
import { DRS_TASKS } from "@/lib/data/drs-workflow";

const { authSpy, revalidateSpy, assetMapSnapshotSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  assetMapSnapshotSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  getAssetMapApprovalSnapshot: assetMapSnapshotSpy,
  listAssignableAssetMapAccounts: vi.fn(),
}));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: vi.fn(),
  getAcatStatusByRecordId: vi.fn(),
  AcatStatusError: class extends Error {},
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: vi.fn(),
}));

// Opt in explicitly. Never fall back to an ambient dev/production DATABASE_URL.
// Both connections must point to the isolated, synthetic PostgreSQL container.
const RUN = process.env.DRS_TEST_DATABASE_URL ? describe : describe.skip;
const PREFIX = "ZZTEST-DRS-199";
const IDS = ["persist", "retire", "IN_TRANSFER", "FUNDED", "ARCHIVED"]
  .map((suffix) => `${PREFIX}-${suffix}`);
const OPS = { role: "OPERATIONS", email: "zztest-drs-199@example.invalid" };
const NOTE = "ZZTEST-DRS-199 private synthetic approval note";
const ACCOUNT = "ZZTEST-DRS-199-ACCOUNT-1234";

function syntheticUrl(raw: string | undefined, roles: string[]): URL {
  if (!raw) throw new Error("explicit_drs_synthetic_database_required");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "55439"
    || url.pathname !== "/aoa_drs_synthetic"
    || !roles.includes(url.username)
    || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
    || url.hash
    || process.env.K_SERVICE
    || process.env.CLOUD_RUN_SERVICE
    || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
    throw new Error("isolated_drs_synthetic_database_required");
  }
  return url;
}

RUN("DRS funding approval on an isolated synthetic database", () => {
  let owner: PrismaClient | undefined;
  let withUserScope: typeof import("@/lib/rls").withUserScope;
  let approveFundingPlan: typeof import("@/app/(authenticated)/asset-transfer/actions").approveFundingPlan;
  let syncPartialAcatExecutionTasks: typeof import("@/lib/data/decision-case-workflow").syncPartialAcatExecutionTasks;
  let appPrisma: typeof import("@/lib/db").prisma;

  async function cleanup() {
    if (!owner) return;
    await owner.decisionTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferFundingPlanApproval.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferPositionFlag.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferDecision.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transferTask.deleteMany({ where: { transfer_id: { in: IDS } } });
    await owner.transfer.deleteMany({ where: { id: { in: IDS } } });
    await owner.auditLog.deleteMany({ where: { entityId: { in: IDS }, actorEmail: OPS.email } });
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${`${PREFIX}-%`}`;
  }

  async function seed(id: string) {
    return owner!.transfer.create({
      data: {
        id,
        source: "APP",
        client_first_name: "ZZTEST",
        client_last_name: "DRS-199 Synthetic",
        value: "199.00",
        stage: "DECISION",
        owner_kind: "OPERATIONS",
        asset_map_folder_id: `${id}-FOLDER`,
        asset_map_custodian: "ZZTEST Synthetic Custodian",
        asset_map_account_number: ACCOUNT,
        decisions: {
          create: {
            id: `${id}-decision`,
            symbol: "ZZTEST",
            description: "Synthetic position, never a real holding",
            value: "199.00",
            cost_basis: "100.00",
          },
        },
      },
    });
  }

  function input(): FundingPlanDraftInput {
    return {
      baseVersion: 0,
      fundingType: "DRS",
      basisDecisions: [],
      partialPositions: [],
      note: `  ${NOTE}  `,
    };
  }

  // A new transaction/query reloads committed state; no action response or mock
  // is used as evidence of persistence.
  async function reload(id: string) {
    return withUserScope(OPS, async (tx) => ({
      transfer: await tx.transfer.findUniqueOrThrow({
        where: { id },
        include: {
          decisions: true,
          position_flags: true,
          decision_tasks: { orderBy: { source_key: "asc" } },
          funding_plan_approvals: { orderBy: { version: "asc" } },
        },
      }),
      audits: await tx.auditLog.findMany({
        where: { entityType: "transfer", entityId: id },
        orderBy: { id: "asc" },
      }),
    }));
  }

  beforeAll(async () => {
    const explicit = syntheticUrl(process.env.DRS_TEST_DATABASE_URL, ["app_rw"]);
    const runtime = syntheticUrl(process.env.DATABASE_URL, ["app_rw"]);
    const cleanupUrl = syntheticUrl(process.env.DRS_TEST_CLEANUP_URL, ["aoa", "postgres"]);
    if (runtime.href !== explicit.href
      || runtime.host !== cleanupUrl.host
      || runtime.pathname !== cleanupUrl.pathname) {
      throw new Error("drs_synthetic_connections_must_match");
    }

    owner = new PrismaClient({ datasourceUrl: cleanupUrl.href });
    // Import only after validating every target; lib/db captures DATABASE_URL.
    ({ withUserScope } = await import("@/lib/rls"));
    ({ approveFundingPlan } = await import("@/app/(authenticated)/asset-transfer/actions"));
    ({ syncPartialAcatExecutionTasks } = await import("@/lib/data/decision-case-workflow"));
    ({ prisma: appPrisma } = await import("@/lib/db"));
    const [scope] = await withUserScope(OPS, (tx) => tx.$queryRaw<Array<{
      database: string; username: string; superuser: boolean; bypassrls: boolean; role: string;
    }>>`SELECT current_database() AS database, current_user AS username,
      rolsuper AS superuser, rolbypassrls AS bypassrls,
      current_setting('app.user_role') AS role
      FROM pg_roles WHERE rolname = current_user`);
    expect(scope).toEqual({
      database: "aoa_drs_synthetic", username: "app_rw",
      superuser: false, bypassrls: false, role: "OPERATIONS",
    });
    await cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authSpy.mockResolvedValue({ user: { email: OPS.email, role: OPS.role } });
    assetMapSnapshotSpy.mockRejectedValue(new Error("DRS must not read the ACAT asset map"));
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await owner?.$disconnect();
      await appPrisma?.$disconnect();
    }
  });

  it("persists DRS on reload with an immutable snapshot, redacted audit, and no partial-ACAT tasks", async () => {
    const id = `${PREFIX}-persist`;
    await seed(id);
    const result = await approveFundingPlan(id, input());
    expect(result).toMatchObject({ ok: true, version: 1, approvedBy: OPS.email });

    const { transfer, audits } = await reload(id);
    expect(transfer).toMatchObject({
      funding_type: "DRS", funding_plan_complete: true,
      funding_plan_version: 1, funding_plan_approved_by: OPS.email,
    });
    expect(transfer.funding_plan_approved_at?.toISOString()).toBe(result.ok ? result.approvedAt : null);
    expect(transfer.decisions[0].decision).toBe("UNDECIDED");
    expect(transfer.position_flags).toEqual([]);
    expect(transfer.decision_tasks).toHaveLength(DRS_TASKS.length);
    expect(transfer.decision_tasks.every((task) => task.status === "TODO" && task.decision_id === null)).toBe(true);
    expect(transfer.decision_tasks.map((task) => task.task_key).sort())
      .toEqual(DRS_TASKS.map((task) => task.taskKey).sort());
    expect(assetMapSnapshotSpy).not.toHaveBeenCalled();
    expect(transfer.funding_plan_approvals).toHaveLength(1);
    const approval = transfer.funding_plan_approvals[0];
    expect(approval).toMatchObject({
      version: 1, funding_type: "DRS", approved_by: OPS.email,
      snapshot: { source: "none", positions: [] }, note: NOTE,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "transfer.funding_plan_approve", actorEmail: OPS.email, actorRole: OPS.role,
    });
    expect(JSON.parse(audits[0].detail!)).toEqual({
      version: 1, fundingType: "DRS", source: "none", positionCount: 0,
      transferringCount: 0, executionTaskCount: 0, drsTaskCount: 8, hasNote: true,
    });
    expect(audits[0].detail).not.toContain(NOTE);
    expect(audits[0].detail).not.toContain(ACCOUNT);
    const rowChanges = await owner!.$queryRaw<Array<{ entry: unknown }>>`
      SELECT to_jsonb(r) AS entry FROM audit.row_change r WHERE row_pk IN (${id}, ${approval.id})`;
    expect(JSON.stringify(rowChanges)).not.toContain(NOTE);
    expect(revalidateSpy).toHaveBeenCalledWith(`/asset-transfer/${id}`);

    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`
      UPDATE app.transfer_funding_plan_approval SET snapshot = '{}'::jsonb WHERE id = ${approval.id}`))
      .rejects.toThrow(/permission denied/i);
    await expect(withUserScope(OPS, (tx) => tx.$executeRaw`
      DELETE FROM app.transfer_funding_plan_approval WHERE id = ${approval.id}`))
      .rejects.toThrow(/permission denied/i);
    expect((await reload(id)).transfer.funding_plan_approvals).toEqual([approval]);
  });

  it("retires existing partial-ACAT tasks when a new DRS plan is approved", async () => {
    const id = `${PREFIX}-retire`;
    await seed(id);
    await withUserScope(OPS, (tx) => syncPartialAcatExecutionTasks(tx, OPS, { transferId: id, active: true }));
    const before = await reload(id);
    expect(before.transfer.decision_tasks).toHaveLength(3);
    expect(before.transfer.decision_tasks.every((task) => task.status === "TODO")).toBe(true);

    expect(await approveFundingPlan(id, input())).toMatchObject({ ok: true, version: 1 });

    const after = await reload(id);
    const retired = after.transfer.decision_tasks.filter((task) => task.source_key?.includes(":standard-partial-acat:"));
    expect(retired.map((task) => task.id))
      .toEqual(before.transfer.decision_tasks.map((task) => task.id));
    expect(retired.every((task) => task.status === "DONE"
      && task.completed_by === OPS.email && task.completed_at !== null)).toBe(true);
    expect(after.transfer.position_flags).toEqual([]);
    expect(JSON.parse(after.audits[0].detail!).executionTaskCount).toBe(3);
  });

  it.each([
    { label: "IN_TRANSFER", data: { stage: "IN_TRANSFER" as const } },
    { label: "FUNDED", data: { stage: "FUNDED" as const } },
    { label: "ARCHIVED", data: { archived_at: new Date("2026-09-24T00:00:00Z") } },
  ])(
    "rejects an already-open DRS draft after the transfer becomes $label without any writes",
    async ({ label, data }) => {
      const id = `${PREFIX}-${label}`;
      await seed(id);
      const openDraft = input();
      await owner!.transfer.update({ where: { id }, data });
      const before = await reload(id);
      const changesBefore = await owner!.$queryRaw<Array<{ entry: unknown }>>`
        SELECT to_jsonb(r) AS entry FROM audit.row_change r WHERE row_pk = ${id} ORDER BY id`;

      const result = await approveFundingPlan(id, openDraft);

      expect(result).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ message: expect.stringMatching(/Preparation/) })],
      });
      expect(await reload(id)).toEqual(before);
      const changesAfter = await owner!.$queryRaw<Array<{ entry: unknown }>>`
        SELECT to_jsonb(r) AS entry FROM audit.row_change r WHERE row_pk = ${id} ORDER BY id`;
      expect(changesAfter).toEqual(changesBefore);
      expect(assetMapSnapshotSpy).not.toHaveBeenCalled();
      expect(revalidateSpy).not.toHaveBeenCalled();
    },
  );
});
