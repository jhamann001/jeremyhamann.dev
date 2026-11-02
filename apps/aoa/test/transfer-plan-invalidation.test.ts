import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, scopeSpy, resolveAccountSpy, assetMapSnapshotSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), scopeSpy: vi.fn(), resolveAccountSpy: vi.fn(), assetMapSnapshotSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/flags", () => ({
  transferDealSourcedRedesignEnabled: () => false,
  assetMapTransferLinkEnabled: () => true,
  checklistStageGateEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  listAssignableAssetMapAccounts: vi.fn(),
  resolveAssignableAssetMapAccount: resolveAccountSpy,
  getAssetMapApprovalSnapshot: assetMapSnapshotSpy,
}));
vi.mock("@/lib/data/decision-case-workflow", () => ({
  syncPartialAcatExecutionTasks: vi.fn(async () => 0),
}));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: vi.fn(), getAcatStatusByRecordId: vi.fn(), AcatStatusError: class extends Error {},
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));

import {
  approveFundingPlan,
  linkAssetMapToTransfer, unlinkAssetMapFromTransfer,
} from "@/app/(authenticated)/asset-transfer/actions";

function wire(overrides: Record<string, unknown> = {}) {
  const current: Record<string, unknown> = {
    id: "t1", stage: "DECISION", archived_at: null,
    funding_type: "ACAT_PARTIAL", funding_plan_version: 4,
    funding_plan_approvals: [{ funding_type: "ACAT_PARTIAL" }],
    funding_plan_complete: true, funding_plan_approved_at: new Date(),
    funding_plan_approved_by: "ops@example.test",
    asset_map_folder_id: "folder-1", asset_map_custodian: "Synthetic Custodian",
    asset_map_account_number: "synthetic-0001", asset_map_account_type: "Individual",
    decisions: [], ...overrides,
  };
  const tx = {
    $queryRaw: vi.fn(async (_query: unknown) => [{ id: "t1" }]),
    transfer: {
      findUnique: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          current[key] = typeof value === "object" && value && "increment" in value
            ? Number(current[key]) + Number(value.increment) : value;
        }
        return current;
      }),
    },
    transferDecision: {
      findUnique: vi.fn(async () => ({ id: "d1", transfer_id: "t1", symbol: "VTI", decision: "BRING_IN" })),
      update: vi.fn(async () => ({})),
    },
    transferPositionFlag: {
      findUnique: vi.fn(async () => ({ is_transferring: true })),
      upsert: vi.fn(async () => ({})),
    },
    transferFundingPlanApproval: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  scopeSpy.mockImplementation(async (_identity: unknown, fn: (client: typeof tx) => unknown) => fn(tx));
  return { current, tx };
}

beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.test" } });
  resolveAccountSpy.mockResolvedValue({
    sourceFolderId: "folder-2", custodian: "Synthetic Custodian",
    accountNumber: "synthetic-0002", accountType: "Individual",
  });
});

describe("material funding-plan edits", () => {
  const mutations = [
    ["source account", () => linkAssetMapToTransfer("t1", "opaque-account-2")],
    ["source unlink", () => unlinkAssetMapFromTransfer("t1")],
  ] as const;

  it.each(mutations)("invalidates approval after changing the %s and rejects the old draft", async (_label, mutate) => {
    const { current, tx } = wire();
    expect(await mutate()).toBeUndefined();
    expect(current).toMatchObject({
      funding_plan_complete: false, funding_plan_version: 5,
      funding_plan_approved_at: null, funding_plan_approved_by: null,
    });
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    tx.transfer.update.mockClear();
    tx.auditLog.create.mockClear();

    const result = await approveFundingPlan("t1", {
      baseVersion: 4, fundingType: "MANUAL", basisDecisions: [], partialPositions: [], note: "",
    });
    expect(result).toMatchObject({ ok: false, errors: [expect.objectContaining({
      field: "form", message: expect.stringMatching(/changed or was approved/i),
    })] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("invalidates a pre-approval draft when another account with the same symbols is linked", async () => {
    const { current, tx } = wire({ funding_plan_version: 0, funding_plan_complete: false });
    await linkAssetMapToTransfer("t1", "opaque-account-2");
    expect(current.funding_plan_version).toBe(1);
    const result = await approveFundingPlan("t1", {
      baseVersion: 0, fundingType: "ACAT_PARTIAL", basisDecisions: [],
      partialPositions: [{ symbol: "VTI", isTransferring: true }], note: "",
    });
    expect(result).toMatchObject({ ok: false });
    expect(assetMapSnapshotSpy).not.toHaveBeenCalled();
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
  });

  it("allows a refreshed explicit approval without rewriting historical versions", async () => {
    const { current, tx } = wire();
    await unlinkAssetMapFromTransfer("t1");
    const result = await approveFundingPlan("t1", {
      baseVersion: 5, fundingType: "MANUAL", basisDecisions: [], partialPositions: [], note: "Reviewed revised plan.",
    });
    expect(result).toMatchObject({ ok: true, version: 6 });
    expect(current).toMatchObject({ funding_plan_version: 6, funding_plan_complete: true });
    expect(tx.transferFundingPlanApproval.create).toHaveBeenCalledTimes(1);
    expect(tx.transferFundingPlanApproval.create).toHaveBeenCalledWith({ data: expect.objectContaining({ version: 6 }) });
  });

  it("locks the transfer within the authenticated scope before reading plan state", async () => {
    const { tx } = wire();
    await unlinkAssetMapFromTransfer("t1");
    expect(scopeSpy).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.test" }, expect.any(Function),
    );
    const sql = tx.$queryRaw.mock.calls[0][0] as unknown as { sql: string; values: unknown[] };
    expect(sql.sql).toMatch(/SELECT id FROM app\.transfer WHERE id = \? FOR UPDATE/);
    expect(sql.values).toEqual(["t1"]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.transfer.findUnique.mock.invocationCallOrder[0]);
  });

  it("fails closed without reading or writing transfer data when RLS cannot lock the row", async () => {
    const { tx } = wire();
    tx.$queryRaw.mockResolvedValue([]);
    expect(await unlinkAssetMapFromTransfer("t1")).toMatchObject({ ok: false });
    expect(tx.transfer.findUnique).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("funding-plan no-ops", () => {
  it.each([
    ["same source account", () => linkAssetMapToTransfer("t1", "opaque-account-1")],
  ] as const)("preserves approval, revision and audit silence for the %s", async (_label, mutate) => {
    const { current, tx } = wire();
    resolveAccountSpy.mockResolvedValue({
      sourceFolderId: "folder-1", custodian: "Synthetic Custodian",
      accountNumber: "synthetic-0001", accountType: "Individual",
    });
    expect(await mutate()).toBeUndefined();
    expect(current).toMatchObject({ funding_plan_complete: true, funding_plan_version: 4 });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferDecision.update).not.toHaveBeenCalled();
    expect(tx.transferPositionFlag.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
