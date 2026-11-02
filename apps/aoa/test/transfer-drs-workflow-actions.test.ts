import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), read: vi.fn(), sync: vi.fn(), webhook: vi.fn(),
  checklistFlag: vi.fn(), legacyFlag: vi.fn(), redirect: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: spies.redirect }));
vi.mock("@/lib/data/drs-workflow-store", () => ({
  readDrsWorkflowTasks: spies.read, syncDrsWorkflowTasks: spies.sync,
}));
vi.mock("@/lib/flags", () => ({
  checklistStageGateEnabled: spies.checklistFlag,
  transferDealSourcedRedesignEnabled: spies.legacyFlag,
  slackCloseoutEnabled: () => true,
  assetMapTransferLinkEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
  paperworkRecordsEnabled: () => false,
}));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: spies.webhook }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));

import { initializeDrsWorkflow, setStage, updateTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { DRS_TASKS } from "@/lib/data/drs-workflow";
import { transferToFormValues } from "@/components/transfers/transfer-form";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "drs-synthetic", source: "APP", stage: "DECISION", archived_at: null,
    client_first_name: "TEST", client_last_name: "DRS", value: 100,
    owner_kind: "OPERATIONS", owner_name: null, funding_type: "DRS",
    funding_plan_complete: true, funding_plan_version: 1,
    accounts_opened_at_apex: false, funding_initiated: false, cash_in_flight: false,
    acat_transfer_id: null, acat_record_id: null,
    tasks: [], accounts: [], decisions: [], decision_cases: [],
    ...overrides,
  };
}

function workflowRows(completed: string[] = []) {
  return DRS_TASKS.map((task) => ({
    id: task.key, taskKey: task.taskKey,
    status: completed.includes(task.key) ? "DONE" : "TODO",
  }));
}

const preparation = ["paperwork", "statement", "receiving-account", "instructions-approved", "apex-submitted"];
let row: ReturnType<typeof fixture>;
let tx: {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  transferTask: { createMany: ReturnType<typeof vi.fn> };
  transferSlackCloseout: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  transferSlackItem: { createMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  row = fixture();
  tx = {
    $queryRaw: vi.fn(async () => [{ id: row.id }]),
    transfer: { findUnique: vi.fn(async () => row), update: vi.fn(async () => ({})) },
    transferTask: { createMany: vi.fn() },
    transferSlackCloseout: { findUnique: vi.fn(), create: vi.fn() },
    transferSlackItem: { createMany: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  spies.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "drs-ops@example.invalid" } });
  spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
  spies.read.mockResolvedValue(workflowRows(preparation));
  spies.sync.mockResolvedValue(8);
  spies.checklistFlag.mockReturnValue(false);
  spies.legacyFlag.mockReturnValue(false);
});

describe("DRS stage workflow", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "advances on Apex submission without cash or ACAT (checklist=%s legacy=%s), never posts Slack",
    async (checklist, legacy) => {
      spies.checklistFlag.mockReturnValue(checklist);
      spies.legacyFlag.mockReturnValue(legacy);
      expect(await setStage(row.id, "IN_TRANSFER")).toEqual({ ok: true, warnings: [] });
      expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stage: "IN_TRANSFER" }) }));
      expect(tx.auditLog.create).toHaveBeenCalledOnce();
      expect(tx.transferTask.createMany).not.toHaveBeenCalled();
      expect(tx.transferSlackCloseout.findUnique).not.toHaveBeenCalled();
      expect(tx.transferSlackCloseout.create).not.toHaveBeenCalled();
      expect(tx.transferSlackItem.createMany).not.toHaveBeenCalled();
      expect(spies.webhook).not.toHaveBeenCalled();
    },
  );

  it("fails closed for a legacy approved record with no DRS task rows", async () => {
    spies.read.mockResolvedValue([]);
    expect(await setStage(row.id, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("requires recorded Apex submission, not just the other preparation steps", async () => {
    spies.read.mockResolvedValue(workflowRows(preparation.filter((key) => key !== "apex-submitted")));
    expect(await setStage(row.id, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("allows Apex-confirmed Funded while reconciliation and client communication remain open", async () => {
    row = fixture({ stage: "IN_TRANSFER" });
    spies.read.mockResolvedValue(workflowRows([...preparation, "apex-confirmed"]));
    expect(await setStage(row.id, "FUNDED")).toEqual({ ok: true, warnings: [] });
    expect(tx.transfer.update).toHaveBeenCalledOnce();
    expect(spies.webhook).not.toHaveBeenCalled();
  });

  it.each(["apex-confirmed", "missing-approval", "exception", "skip-stage"])(
    "rejects an invalid Funded transition: %s", async (reason) => {
      row = fixture({ stage: reason === "skip-stage" ? "DECISION" : "IN_TRANSFER",
        ...(reason === "missing-approval" ? { funding_plan_complete: false } : {}),
        ...(reason === "exception" ? { decision_cases: [{ id: "case", question: "Resolve instruction issue" }] } : {}),
      });
      spies.read.mockResolvedValue(workflowRows(reason === "apex-confirmed" ? preparation : [...preparation, "apex-confirmed"]));
      expect(await setStage(row.id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
      expect(tx.transfer.update).not.toHaveBeenCalled();
    },
  );

  it.each(["CLIENT_SERVICE", "ADVISOR", "VIEWER"])("requires Operations for stage updates by %s", async (role) => {
    spies.auth.mockResolvedValue({ user: { role, email: "drs-user@example.invalid" } });
    expect(await setStage(row.id, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("rejects edits to an archived DRS stage", async () => {
    row = fixture({ archived_at: new Date() });
    expect(await setStage(row.id, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("enforces the same DRS gate through Edit record", async () => {
    spies.read.mockResolvedValue(workflowRows([]));
    const values = transferToFormValues(row as unknown as Parameters<typeof transferToFormValues>[0]);
    const result = await updateTransfer(row.id, { ...values, stage: "IN_TRANSFER" });
    expect(result).toMatchObject({ ok: false });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(spies.redirect).not.toHaveBeenCalled();
  });
});

describe("existing DRS checklist setup", () => {
  it("seeds missing rows under the transfer lock and audits setup", async () => {
    spies.read.mockResolvedValue([]);
    expect(await initializeDrsWorkflow(row.id)).toEqual({ ok: true });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(spies.sync).toHaveBeenCalledWith(tx, expect.anything(), { transferId: row.id });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });
  it("is a no-op once all DRS rows exist", async () => {
    expect(await initializeDrsWorkflow(row.id)).toEqual({ ok: true });
    expect(spies.sync).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it.each([{ funding_type: "WIRE" }, { funding_plan_version: 0 }, { archived_at: new Date() }])(
    "does not initialize an ineligible transfer %o", async (overrides) => {
      row = fixture(overrides);
      expect(await initializeDrsWorkflow(row.id)).toMatchObject({ ok: false });
      expect(spies.sync).not.toHaveBeenCalled();
    },
  );
});
