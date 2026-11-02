import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authSpy,
  withUserScopeSpy,
  revalidateSpy,
  assetMapSnapshotSpy,
  executionTaskSyncSpy,
  drsTaskSyncSpy,
} = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  assetMapSnapshotSpy: vi.fn(),
  executionTaskSyncSpy: vi.fn(async () => 3),
  drsTaskSyncSpy: vi.fn(async () => 8),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
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
  getAssetMapApprovalSnapshot: assetMapSnapshotSpy,
}));
vi.mock("@/lib/data/decision-case-workflow", () => ({
  syncPartialAcatExecutionTasks: executionTaskSyncSpy,
}));
vi.mock("@/lib/data/drs-workflow-store", () => ({
  syncDrsWorkflowTasks: drsTaskSyncSpy,
  readDrsWorkflowTasks: vi.fn(),
}));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: vi.fn(),
  getAcatStatusByRecordId: vi.fn(),
  AcatStatusError: class extends Error {},
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: vi.fn(),
}));

import { approveFundingPlan } from "@/app/(authenticated)/asset-transfer/actions";
import { TRANSFER_FUNDING_PLAN_APPROVE } from "@/lib/audit";

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  transferDecision: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  transferPositionFlag: { upsert: ReturnType<typeof vi.fn> };
  transferFundingPlanApproval: { create: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

let tx: FakeTx;

const approvedAssetMap = {
  folderId: "folder-1", custodian: "Schwab", accountLast4: "6643", accountType: "Traditional IRA",
  sourceAccountFingerprint: createHash("sha256")
    .update(JSON.stringify(["folder-1", "Schwab", "562501056643", "Traditional IRA"]))
    .digest("hex"),
};

function wire(current: Record<string, unknown>) {
  tx = {
    $queryRaw: vi.fn(async () => [{ id: "t1" }]),
    transfer: {
      findUnique: vi.fn(async () => current),
      update: vi.fn(async () => ({})),
    },
    transferDecision: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
    transferPositionFlag: { upsert: vi.fn(async () => ({})) },
    transferFundingPlanApproval: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  withUserScopeSpy.mockImplementation(
    async (_identity: unknown, fn: (client: FakeTx) => Promise<unknown>) =>
      fn(tx),
  );
}

function current(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    stage: "DECISION",
    archived_at: null,
    funding_plan_version: 1,
    asset_map_folder_id: "folder-1",
    asset_map_custodian: "Schwab",
    asset_map_account_number: "562501056643",
    asset_map_account_type: "Traditional IRA",
    decisions: [],
    funding_plan_approvals: [],
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue({
    user: { email: "ops@example.com", role: "OPERATIONS" },
  });
});

describe("approveFundingPlan", () => {
  it.each([
    { previousApproved: "WIRE", savedRail: "ACAT_PARTIAL", restart: true },
    { previousApproved: "ACAT_PARTIAL", savedRail: "WIRE", restart: false },
    { previousApproved: null, savedRail: "ACAT_PARTIAL", restart: false },
  ])("uses the last approved route ($previousApproved), not a draft rail ($savedRail), to restart partial tasks", async ({ previousApproved, savedRail, restart }) => {
    wire(current({
      funding_type: savedRail,
      funding_plan_approvals: previousApproved ? [{
        funding_type: previousApproved,
        snapshot: {
          source: "asset-map",
          assetMap: approvedAssetMap,
          positions: [{ symbol: "SYN", isTransferring: true }],
        },
      }] : [],
    }));
    assetMapSnapshotSpy.mockResolvedValue({
      statementDate: "2026-08-31",
      positions: [{ symbol: "SYN", description: null, marketValue: 100, costBasis: 90, ineligible: false }],
    });
    executionTaskSyncSpy.mockResolvedValueOnce(3);

    const result = await approveFundingPlan("t1", {
      baseVersion: 1, fundingType: "ACAT_PARTIAL", basisDecisions: [],
      partialPositions: [{ symbol: "SYN", isTransferring: true }], note: "",
    });

    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx, expect.objectContaining({ role: "OPERATIONS" }),
      { transferId: "t1", active: true, ...(restart ? { restartExistingTasks: true } : {}) },
    );
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0][0].data.detail);
    expect(detail.restartedPartialAcatRoute).toBe(restart ? true : undefined);
  });

  it.each([
    {
      name: "changed inclusion", restart: true,
      previous: [{ symbol: "SYNIN", isTransferring: true }, { symbol: "SYNOUT", isTransferring: false }],
      next: [{ symbol: "SYNIN", isTransferring: true }, { symbol: "SYNOUT", isTransferring: true }],
    },
    {
      name: "added security", restart: true,
      previous: [{ symbol: "SYNIN", isTransferring: true }, { symbol: "SYNOUT", isTransferring: false }],
      next: [{ symbol: "SYNIN", isTransferring: true }, { symbol: "SYNOUT", isTransferring: false }, { symbol: "SYNNEW", isTransferring: false }],
    },
    {
      name: "removed security", restart: true,
      previous: [{ symbol: "SYNIN", isTransferring: true }, { symbol: "SYNOUT", isTransferring: false }],
      next: [{ symbol: "SYNIN", isTransferring: true }],
    },
    {
      name: "reordered securities and refreshed prices only", restart: false,
      previous: [{ symbol: "SYNIN", isTransferring: true }, { symbol: "SYNOUT", isTransferring: false }],
      next: [{ symbol: "SYNOUT", isTransferring: false }, { symbol: "SYNIN", isTransferring: true }],
    },
  ])("restarts same-route partial tasks only for changed approved instructions: $name", async ({ previous, next, restart }) => {
    const priorSnapshot = {
      source: "asset-map",
      assetMap: approvedAssetMap,
      positions: previous.map((position) => ({ ...position, marketValue: 100, costBasis: 90 })),
    };
    wire(current({ funding_plan_approvals: [{ funding_type: "ACAT_PARTIAL", snapshot: priorSnapshot }] }));
    assetMapSnapshotSpy.mockResolvedValue({
      statementDate: "2026-09-24",
      positions: next.map((position) => ({ symbol: position.symbol, description: "Current synthetic security", marketValue: 125, costBasis: 95, ineligible: false })),
    });
    executionTaskSyncSpy.mockResolvedValueOnce(3);

    expect(await approveFundingPlan("t1", {
      baseVersion: 1, fundingType: "ACAT_PARTIAL", basisDecisions: [],
      partialPositions: next, note: "Reviewed current securities.",
    })).toMatchObject({ ok: true, version: 2 });
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx, expect.anything(),
      { transferId: "t1", active: true, ...(restart ? { restartExistingTasks: true } : {}) },
    );
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0][0].data.detail);
    expect(detail.restartedPartialAcatInstructions).toBe(restart ? true : undefined);
    expect(detail.restartedPartialAcatRoute).toBeUndefined();
    expect(tx.transferFundingPlanApproval.create.mock.calls[0][0].data.snapshot.positions).toEqual(
      expect.arrayContaining(next.map((position) => expect.objectContaining(position))),
    );
    expect(priorSnapshot.positions).toEqual(previous.map((position) => ({ ...position, marketValue: 100, costBasis: 90 })));
  });

  it("restarts instructions when the source account changes despite identical last four digits and securities", async () => {
    const currentAccountNumber = "313196886643";
    const currentFingerprint = createHash("sha256")
      .update(JSON.stringify(["folder-1", "Schwab", currentAccountNumber, "Traditional IRA"]))
      .digest("hex");
    wire(current({
      asset_map_account_number: currentAccountNumber,
      funding_plan_approvals: [{ funding_type: "ACAT_PARTIAL", snapshot: {
        source: "asset-map", assetMap: approvedAssetMap,
        positions: [{ symbol: "SYNIN", isTransferring: true }],
      } }],
    }));
    assetMapSnapshotSpy.mockResolvedValue({
      statementDate: "2026-09-24",
      positions: [{ symbol: "SYNIN", description: null, marketValue: 100, costBasis: 90, ineligible: false }],
    });
    executionTaskSyncSpy.mockResolvedValueOnce(3);

    expect(await approveFundingPlan("t1", {
      baseVersion: 1, fundingType: "ACAT_PARTIAL", basisDecisions: [],
      partialPositions: [{ symbol: "SYNIN", isTransferring: true }], note: "",
    })).toMatchObject({ ok: true, version: 2 });
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx, expect.anything(), { transferId: "t1", active: true, restartExistingTasks: true },
    );
    const savedSnapshot = tx.transferFundingPlanApproval.create.mock.calls[0][0].data.snapshot;
    expect(savedSnapshot.assetMap).toMatchObject({
      folderId: approvedAssetMap.folderId, custodian: approvedAssetMap.custodian,
      accountLast4: approvedAssetMap.accountLast4, accountType: approvedAssetMap.accountType,
      sourceAccountFingerprint: currentFingerprint,
    });
    expect(currentFingerprint).not.toBe(approvedAssetMap.sourceAccountFingerprint);
    const audit = tx.auditLog.create.mock.calls[0][0].data.detail;
    const detail = JSON.parse(audit);
    expect(detail.restartedPartialAcatInstructions).toBe(true);
    expect(detail.restartedPartialAcatRoute).toBeUndefined();
    expect(JSON.stringify(savedSnapshot)).not.toContain(currentAccountNumber);
    expect(audit).not.toContain(currentAccountNumber);
    expect(audit).not.toContain(currentFingerprint);
  });

  it.each([undefined, null, { source: "asset-map" }])("restarts conservatively when the previous partial snapshot cannot establish instructions (%j)", async (snapshot) => {
    wire(current({ funding_plan_approvals: [{ funding_type: "ACAT_PARTIAL", snapshot }] }));
    assetMapSnapshotSpy.mockResolvedValue({
      statementDate: "2026-09-24",
      positions: [{ symbol: "SYNIN", description: null, marketValue: 100, costBasis: 90, ineligible: false }],
    });
    executionTaskSyncSpy.mockResolvedValueOnce(3);
    expect(await approveFundingPlan("t1", {
      baseVersion: 1, fundingType: "ACAT_PARTIAL", basisDecisions: [],
      partialPositions: [{ symbol: "SYNIN", isTransferring: true }], note: "",
    })).toMatchObject({ ok: true, version: 2 });
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx, expect.anything(), { transferId: "t1", active: true, restartExistingTasks: true },
    );
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0][0].data.detail);
    expect(detail.restartedPartialAcatInstructions).toBe(true);
    expect(detail.restartedPartialAcatRoute).toBeUndefined();
  });

  it("compares basis instructions with immutable approval even when saved mutable choices already match the new draft", async () => {
    wire(current({
      asset_map_folder_id: null, asset_map_custodian: null,
      decisions: [
        { id: "d1", symbol: "SYNIN", description: null, value: 100, cost_basis: 90, decision: "BRING_IN" },
        { id: "d2", symbol: "SYNOUT", description: null, value: 50, cost_basis: 40, decision: "BRING_IN" },
      ],
      funding_plan_approvals: [{ funding_type: "ACAT_PARTIAL", snapshot: {
        source: "transfer-decisions",
        positions: [
          { decisionId: "d1", symbol: "SYNIN", decision: "BRING_IN" },
          { decisionId: "d2", symbol: "SYNOUT", decision: "LEAVE_GIFT" },
        ],
      } }],
    }));
    executionTaskSyncSpy.mockResolvedValueOnce(3);
    expect(await approveFundingPlan("t1", {
      baseVersion: 1, fundingType: "ACAT_PARTIAL", partialPositions: [], note: "",
      basisDecisions: [{ decisionId: "d1", decision: "BRING_IN" }, { decisionId: "d2", decision: "BRING_IN" }],
    })).toMatchObject({ ok: true, version: 2 });
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx, expect.anything(), { transferId: "t1", active: true, restartExistingTasks: true },
    );
    const detail = JSON.parse(tx.auditLog.create.mock.calls[0][0].data.detail);
    expect(detail.restartedPartialAcatInstructions).toBe(true);
    expect(detail.restartedPartialAcatRoute).toBeUndefined();
  });

  it("persists and audits a DRS plan without activating partial-ACAT execution", async () => {
    wire(current());
    executionTaskSyncSpy.mockResolvedValueOnce(0);
    drsTaskSyncSpy.mockResolvedValueOnce(8);

    const result = await approveFundingPlan("t1", {
      baseVersion: 1,
      fundingType: "DRS",
      basisDecisions: [],
      partialPositions: [],
      note: "",
    });

    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(tx.transfer.update).toHaveBeenCalledWith({
      where: { id: "t1", stage: "DECISION", archived_at: null, funding_plan_version: 1 },
      data: expect.objectContaining({
        funding_type: "DRS",
        funding_plan_complete: true,
        funding_plan_version: 2,
        funding_plan_approved_by: "ops@example.com",
      }),
    });
    expect(tx.transferFundingPlanApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        transfer_id: "t1",
        version: 2,
        funding_type: "DRS",
        snapshot: { source: "none", positions: [] },
      }),
    });
    expect(assetMapSnapshotSpy).not.toHaveBeenCalled();
    expect(tx.transferPositionFlag.upsert).not.toHaveBeenCalled();
    expect(tx.transferDecision.update).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).toHaveBeenCalledTimes(1);
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ email: "ops@example.com" }),
      { transferId: "t1", active: false },
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0][0].data as {
      action: string;
      detail: string;
    };
    expect(audit.action).toBe(TRANSFER_FUNDING_PLAN_APPROVE);
    expect(JSON.parse(audit.detail)).toEqual({
      version: 2,
      fundingType: "DRS",
      source: "none",
      positionCount: 0,
      transferringCount: 0,
      executionTaskCount: 0,
      drsTaskCount: 8,
      hasNote: false,
    });
    expect(drsTaskSyncSpy).toHaveBeenCalledWith(tx, expect.anything(), {
      transferId: "t1", restartExistingTasks: false,
    });
  });

  it.each([
    { previous: "WIRE", restart: true },
    { previous: "DRS", restart: false },
  ])("restarts DRS tasks only when returning from an approved $previous route", async ({ previous, restart }) => {
    wire(current({ funding_plan_approvals: [{ funding_type: previous, snapshot: { source: "none", positions: [] } }] }));
    drsTaskSyncSpy.mockResolvedValueOnce(8);
    expect(await approveFundingPlan("t1", {
      baseVersion: 1, fundingType: "DRS", basisDecisions: [], partialPositions: [], note: "",
    })).toMatchObject({ ok: true });
    expect(drsTaskSyncSpy).toHaveBeenCalledWith(tx, expect.anything(), {
      transferId: "t1", restartExistingTasks: restart,
    });
  });

  it.each([
    { stage: "IN_TRANSFER", archived_at: null },
    { stage: "FUNDED", archived_at: null },
    { stage: "DECISION", archived_at: new Date("2026-09-23T12:00:00Z") },
  ])(
    "rejects a stale DRS approval when the transfer is $stage (archived: $archived_at) without any writes",
    async (status) => {
      wire(current(status));

      const result = await approveFundingPlan("t1", {
        baseVersion: 1,
        fundingType: "DRS",
        basisDecisions: [],
        partialPositions: [],
        note: "",
      });

      expect(result).toMatchObject({
        ok: false,
        errors: [expect.objectContaining({ message: expect.stringMatching(/Preparation/) })],
      });
      expect(tx.transfer.update).not.toHaveBeenCalled();
      expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
      expect(tx.transferPositionFlag.upsert).not.toHaveBeenCalled();
      expect(tx.transferDecision.update).not.toHaveBeenCalled();
      expect(executionTaskSyncSpy).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(assetMapSnapshotSpy).not.toHaveBeenCalled();
      expect(revalidateSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects a DRS approval if its guarded write loses a concurrent stage or version change", async () => {
    wire(current());
    tx.transfer.update.mockRejectedValueOnce(new Error("Record no longer matches"));

    const result = await approveFundingPlan("t1", {
      baseVersion: 1,
      fundingType: "DRS",
      basisDecisions: [],
      partialPositions: [],
      note: "",
    });

    expect(result).toMatchObject({ ok: false });
    expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "t1", stage: "DECISION", archived_at: null, funding_plan_version: 1 },
    }));
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("rejects non-Operations roles before opening a write transaction", async () => {
    authSpy.mockResolvedValue({
      user: { email: "advisor@example.com", role: "ADVISOR" },
    });

    const result = await approveFundingPlan("t1", {
      baseVersion: 0,
      fundingType: "MANUAL",
      basisDecisions: [],
      partialPositions: [],
      note: "",
    });

    expect(result).toMatchObject({ ok: false });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("rejects an approval based on an older version", async () => {
    wire(current({ funding_plan_version: 3 }));

    const result = await approveFundingPlan("t1", {
      baseVersion: 2,
      fundingType: "MANUAL",
      basisDecisions: [],
      partialPositions: [],
      note: "",
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors[0]?.message).toMatch(/someone else/i);
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("commits a linked partial-ACAT plan, frozen snapshot, and one audit event", async () => {
    wire(current());
    assetMapSnapshotSpy.mockResolvedValue({
      statementDate: "2026-08-31",
      positions: [
        {
          symbol: "VTI",
          description: "Vanguard Total Stock Market ETF",
          marketValue: 125000,
          costBasis: 90000,
          ineligible: false,
        },
        {
          symbol: "XYZIX",
          description: "Restricted fund",
          marketValue: 25000,
          costBasis: 20000,
          ineligible: true,
        },
      ],
    });

    const result = await approveFundingPlan("t1", {
      baseVersion: 1,
      fundingType: "ACAT_PARTIAL",
      basisDecisions: [],
      partialPositions: [
        { symbol: "VTI", isTransferring: true },
        { symbol: "XYZIX", isTransferring: false },
      ],
      note: "Proceed with transferable assets only.",
    });

    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(tx.transferPositionFlag.upsert).toHaveBeenCalledTimes(2);
    expect(tx.transferDecision.update).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ email: "ops@example.com" }),
      { transferId: "t1", active: true },
    );

    const data = tx.transfer.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      funding_type: "ACAT_PARTIAL",
      funding_plan_complete: true,
      funding_plan_version: 2,
      funding_plan_approved_by: "ops@example.com",
    });
    const approval = tx.transferFundingPlanApproval.create.mock.calls[0][0]
      .data as Record<string, unknown>;
    const serializedSnapshot = JSON.stringify(approval.snapshot);
    expect(serializedSnapshot).toContain('"accountLast4":"6643"');
    expect(serializedSnapshot).toContain('"statementDate":"2026-08-31"');
    expect(serializedSnapshot).not.toContain("562501056643");
    expect(approval.snapshot).toMatchObject({ assetMap: { sourceAccountFingerprint: approvedAssetMap.sourceAccountFingerprint } });

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0][0].data as {
      action: string;
      detail: string;
    };
    expect(audit.action).toBe(TRANSFER_FUNDING_PLAN_APPROVE);
    expect(JSON.parse(audit.detail)).toEqual({
      version: 2,
      fundingType: "ACAT_PARTIAL",
      source: "asset-map",
      positionCount: 2,
      transferringCount: 1,
      executionTaskCount: 3,
      hasNote: true,
    });
  });

  it("fails closed when the asset-map symbol set changed during review", async () => {
    wire(current());
    assetMapSnapshotSpy.mockResolvedValue({
      statementDate: "2026-08-31",
      positions: [
        { symbol: "VTI", description: null, marketValue: 1, costBasis: 1, ineligible: false },
        { symbol: "VXUS", description: null, marketValue: 1, costBasis: 1, ineligible: false },
      ],
    });

    const result = await approveFundingPlan("t1", {
      baseVersion: 1,
      fundingType: "ACAT_PARTIAL",
      basisDecisions: [],
      partialPositions: [{ symbol: "VTI", isTransferring: true }],
      note: "",
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors[0]?.message).toMatch(/asset map changed/i);
    }
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferPositionFlag.upsert).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).not.toHaveBeenCalled();
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("commits seeded basis decisions only when the complete list is resolved", async () => {
    wire(
      current({
        asset_map_folder_id: null,
        asset_map_custodian: null,
        asset_map_account_number: null,
        asset_map_account_type: null,
        funding_plan_version: 0,
        decisions: [
          { id: "d1", symbol: "VTI", description: "VTI", value: 10, cost_basis: 8 },
          { id: "d2", symbol: "AAPL", description: "Apple", value: 5, cost_basis: 1 },
        ],
      }),
    );

    const result = await approveFundingPlan("t1", {
      baseVersion: 0,
      fundingType: "ACAT_PARTIAL",
      basisDecisions: [
        { decisionId: "d1", decision: "BRING_IN" },
        { decisionId: "d2", decision: "LEAVE_GIFT" },
      ],
      partialPositions: [],
      note: "",
    });

    expect(result).toMatchObject({ ok: true, version: 1 });
    expect(tx.transferDecision.update).toHaveBeenCalledTimes(2);
    expect(tx.transferPositionFlag.upsert).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      { transferId: "t1", active: true },
    );
  });

  it("retires unfinished partial-ACAT tasks when a revised plan changes routes", async () => {
    wire(current());
    executionTaskSyncSpy.mockResolvedValueOnce(2);

    const result = await approveFundingPlan("t1", {
      baseVersion: 1,
      fundingType: "MANUAL",
      basisDecisions: [],
      partialPositions: [],
      note: "Use the reviewed manual-transfer route.",
    });

    expect(result).toMatchObject({ ok: true, version: 2 });
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ email: "ops@example.com" }),
      { transferId: "t1", active: false },
    );
    const audit = tx.auditLog.create.mock.calls[0][0].data as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({
      fundingType: "MANUAL",
      executionTaskCount: 2,
    });
  });
});

describe("explicit legacy In transfer review", () => {
  const legacyInput = (overrides: Record<string, unknown> = {}) => ({
    baseVersion: 0, approvalMode: "LEGACY_IN_TRANSFER_REVIEW" as const,
    fundingType: "WIRE" as const, basisDecisions: [], partialPositions: [],
    note: "Reviewed the saved legacy instructions.", ...overrides,
  });
  const legacyCurrent = (overrides: Record<string, unknown> = {}) => current({
    stage: "IN_TRANSFER", funding_type: "WIRE", funding_plan_version: 0,
    funding_plan_complete: false, funding_plan_approvals: [],
    ...overrides,
  });
  const noApprovalWrites = () => {
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferPositionFlag.upsert).not.toHaveBeenCalled();
    expect(tx.transferDecision.update).not.toHaveBeenCalled();
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).not.toHaveBeenCalled();
    expect(drsTaskSyncSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  };

  it.each(["OPERATIONS", "ADMIN"])("lets %s approve saved cash instructions without moving stage or retiring tasks", async (role) => {
    authSpy.mockResolvedValue({ user: { role, email: "legacy-ops@example.test" } });
    wire(legacyCurrent());
    expect(await approveFundingPlan("t1", legacyInput())).toMatchObject({ ok: true, version: 1 });
    expect(tx.transfer.update).toHaveBeenCalledWith({
      where: { id: "t1", stage: "IN_TRANSFER", archived_at: null, funding_plan_version: 0 },
      data: expect.objectContaining({ funding_type: "WIRE", funding_plan_complete: true, funding_plan_version: 1 }),
    });
    const data = tx.transfer.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("stage");
    expect(data).not.toHaveProperty("stage_entered_at");
    expect(tx.transferFundingPlanApproval.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      version: 1, funding_type: "WIRE", snapshot: { source: "none", positions: [] },
    }) });
    expect(executionTaskSyncSpy).not.toHaveBeenCalled();
    expect(drsTaskSyncSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it("uses server-resolved saved map selections and preserves existing partial-task progress", async () => {
    wire(legacyCurrent({ funding_type: "ACAT_PARTIAL" }));
    const positions = [{ symbol: "SYN", isTransferring: true }, { symbol: "ALT", isTransferring: false }];
    assetMapSnapshotSpy.mockResolvedValue({ statementDate: "2026-09-25", positions: positions.map(position => ({
      ...position, description: null, marketValue: 10, costBasis: 9, ineligible: false,
    })) });
    expect(await approveFundingPlan("t1", legacyInput({ fundingType: "ACAT_PARTIAL", partialPositions: positions })))
      .toMatchObject({ ok: true, version: 1 });
    expect(assetMapSnapshotSpy).toHaveBeenCalledWith(tx, expect.objectContaining({ transferId: "t1" }));
    expect(tx.transferFundingPlanApproval.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      snapshot: expect.objectContaining({ source: "asset-map", positions: expect.arrayContaining(positions.map(position => expect.objectContaining(position))) }),
    }) });
    expect(tx.transferPositionFlag.upsert).toHaveBeenCalledTimes(2);
    for (const [mutation] of tx.transferPositionFlag.upsert.mock.calls) {
      expect(mutation.update).toEqual({});
    }
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ transferId: "t1", active: true }));
    expect(executionTaskSyncSpy).not.toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ restartExistingTasks: true }));
    expect(drsTaskSyncSpy).not.toHaveBeenCalled();
  });

  it("approves a complete unchanged saved basis instruction set", async () => {
    const decisions = [
      { id: "d1", symbol: "SYN", decision: "BRING_IN", value: 10, cost_basis: 9, description: null },
      { id: "d2", symbol: "ALT", decision: "LEAVE_GIFT", value: 5, cost_basis: 2, description: null },
    ];
    wire(legacyCurrent({ funding_type: "ACAT_PARTIAL", asset_map_folder_id: null, asset_map_custodian: null, decisions }));
    expect(await approveFundingPlan("t1", legacyInput({ fundingType: "ACAT_PARTIAL", basisDecisions: decisions.map(row => ({ decisionId: row.id, decision: row.decision })) })))
      .toMatchObject({ ok: true, version: 1 });
    expect(tx.transferDecision.update).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ transferId: "t1", active: true }));
    expect(executionTaskSyncSpy).not.toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ restartExistingTasks: true }));
  });

  it.each([
    { stage: "DECISION" }, { stage: "FUNDED" }, { archived_at: new Date("2026-09-25T12:00:00Z") },
    { funding_plan_version: 1 }, { funding_plan_approvals: [{ funding_type: "WIRE", snapshot: { source: "none", positions: [] } }] },
    { funding_type: "DRS" }, { funding_type: null },
  ])("rejects legacy review for ineligible saved state %j without writes", async (overrides) => {
    wire(legacyCurrent(overrides));
    expect(await approveFundingPlan("t1", legacyInput())).toMatchObject({ ok: false });
    noApprovalWrites();
  });

  it("does not reinterpret a stale Preparation draft as a legacy review", async () => {
    wire(legacyCurrent());
    expect(await approveFundingPlan("t1", { baseVersion: 0, fundingType: "WIRE", basisDecisions: [], partialPositions: [], note: "Stale Preparation review." })).toMatchObject({ ok: false });
    noApprovalWrites();
  });

  it("keeps an unchanged legacy DRS review on its Preparation workflow", async () => {
    wire(legacyCurrent({ funding_type: "DRS" }));
    expect(await approveFundingPlan("t1", legacyInput({ fundingType: "DRS" }))).toMatchObject({ ok: false });
    noApprovalWrites();
  });

  it("does not silently substitute basis rows when a linked legacy asset map disappears", async () => {
    wire(legacyCurrent({ funding_type: "ACAT_PARTIAL", decisions: [
      { id: "d1", symbol: "SYN", decision: "BRING_IN", value: 10, cost_basis: 9, description: null },
    ] }));
    assetMapSnapshotSpy.mockResolvedValue(null);
    expect(await approveFundingPlan("t1", legacyInput({
      fundingType: "ACAT_PARTIAL", basisDecisions: [{ decisionId: "d1", decision: "BRING_IN" }],
    }))).toMatchObject({ ok: false });
    noApprovalWrites();
  });

  it("rejects a funding-route change instead of converting the legacy review into a revision", async () => {
    wire(legacyCurrent());
    const result = await approveFundingPlan("t1", legacyInput({ fundingType: "MANUAL" }));
    expect(result).toMatchObject({ ok: false, errors: [expect.objectContaining({ message: expect.stringMatching(/Preparation/) })] });
    noApprovalWrites();
  });

  it.each(["changed", "missing", "undecided"])("rejects %s saved basis instructions before writing", async reason => {
    wire(legacyCurrent({ funding_type: "ACAT_PARTIAL", asset_map_folder_id: null, asset_map_custodian: null, decisions: [
      { id: "d1", symbol: "SYN", decision: reason === "undecided" ? "UNDECIDED" : "BRING_IN", value: 10, cost_basis: 9, description: null },
    ] }));
    const basisDecisions = reason === "missing" ? [] : [{ decisionId: "d1", decision: reason === "changed" ? "LEAVE_GIFT" : "BRING_IN" }];
    expect(await approveFundingPlan("t1", legacyInput({ fundingType: "ACAT_PARTIAL", basisDecisions }))).toMatchObject({ ok: false });
    noApprovalWrites();
  });

  it.each(["changed", "missing source", "changed membership"])("rejects %s in saved asset-map instructions before writing", async reason => {
    wire(legacyCurrent({ funding_type: "ACAT_PARTIAL" }));
    assetMapSnapshotSpy.mockResolvedValue(reason === "missing source" ? null : {
      statementDate: "2026-09-25", positions: [{
        symbol: reason === "changed membership" ? "ALT" : "SYN", isTransferring: false,
        description: null, marketValue: 10, costBasis: 9, ineligible: false,
      }],
    });
    expect(await approveFundingPlan("t1", legacyInput({ fundingType: "ACAT_PARTIAL", partialPositions: [{ symbol: "SYN", isTransferring: true }] })))
      .toMatchObject({ ok: false });
    noApprovalWrites();
  });

  it("cannot commit a legacy approval after losing its conditional stage/version/archive write", async () => {
    wire(legacyCurrent());
    tx.transfer.update.mockRejectedValueOnce(new Error("Conditional write no longer matches"));
    expect(await approveFundingPlan("t1", legacyInput())).toMatchObject({ ok: false });
    expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "t1", stage: "IN_TRANSFER", archived_at: null, funding_plan_version: 0 },
    }));
    expect(tx.transferFundingPlanApproval.create).not.toHaveBeenCalled();
    expect(executionTaskSyncSpy).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("rejects %s legacy approval before opening a scope", async role => {
    authSpy.mockResolvedValue({ user: { role, email: "legacy-denied@example.test" } });
    expect(await approveFundingPlan("t1", legacyInput())).toMatchObject({ ok: false });
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });
});
