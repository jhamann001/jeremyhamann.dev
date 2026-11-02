import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), checklist: vi.fn(), legacy: vi.fn(),
  redirect: vi.fn(), webhook: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: spies.redirect }));
vi.mock("@/lib/flags", () => ({
  checklistStageGateEnabled: spies.checklist,
  transferDealSourcedRedesignEnabled: spies.legacy,
  slackCloseoutEnabled: () => false,
  assetMapTransferLinkEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: spies.webhook }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));

import { setStage, updateTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import { DEFAULT_TASKS, type TransferStage } from "@/lib/data/transfer-types";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "stage-contract-synthetic", source: "APP", stage: "DECISION",
    archived_at: null, client_first_name: "Synthetic", client_last_name: "Stage",
    value: 100, owner_kind: "OPERATIONS", owner_name: null,
    funding_type: "WIRE", funding_plan_complete: true, funding_plan_version: 1,
    accounts_opened_at_apex: true, funding_initiated: true, cash_in_flight: true,
    acat_transfer_id: null, acat_record_id: null, deal_id: null,
    tasks: [], accounts: [], decisions: [], decision_cases: [],
    ...overrides,
  };
}

function visibleTasks(stage: TransferStage, done = true) {
  return DEFAULT_TASKS[stage].map((title, sort_order) => ({
    title, done, sort_order, override_done: null,
  }));
}

let row: ReturnType<typeof fixture>;
let tx: {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  transferTask: { createMany: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  deal: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  row = fixture();
  tx = {
    $queryRaw: vi.fn(async () => [{ id: row.id }]),
    transfer: { findUnique: vi.fn(async () => row), update: vi.fn(async () => ({})) },
    transferTask: { createMany: vi.fn(async () => ({ count: 0 })) },
    auditLog: { create: vi.fn(async () => ({})) },
    deal: { findUnique: vi.fn(async () => ({ statements: true, asset_mapped: true })) },
  };
  spies.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "stage-ops@example.invalid" } });
  spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
});

const paths = ["toolbar", "edit form"] as const;
type Path = (typeof paths)[number];

async function move(path: Path, to: TransferStage) {
  if (path === "toolbar") return setStage(row.id, to);
  const values = transferToFormValues(row as unknown as Parameters<typeof transferToFormValues>[0]);
  return updateTransfer(row.id, { ...values, stage: to });
}

function expectRejected(result: Awaited<ReturnType<typeof move>>, message: string) {
  expect(result).toMatchObject({ ok: false });
  if (result && "blocked" in result) expect(result.unmet).toContain(message);
  else expect(result).toMatchObject({ errors: expect.arrayContaining([{ field: "stage", message }]) });
  expect(tx.transfer.update).not.toHaveBeenCalled();
  expect(tx.transferTask.createMany).not.toHaveBeenCalled();
  expect(tx.auditLog.create).not.toHaveBeenCalled();
  expect(spies.webhook).not.toHaveBeenCalled();
  expect(spies.redirect).not.toHaveBeenCalled();
}

describe.each(paths)("%s shared stage contract", (path) => {
  describe.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("checklist=%s legacy=%s", (checklist, legacy) => {
    beforeEach(() => {
      spies.checklist.mockReturnValue(checklist);
      spies.legacy.mockReturnValue(legacy);
    });

    it.each([
      ["DECISION", "IN_TRANSFER"], ["DECISION", "FUNDED"], ["IN_TRANSFER", "FUNDED"],
    ] as const)("blocks unresolved decisions on %s → %s before any write", async (from, to) => {
      row = fixture({ stage: from, tasks: visibleTasks(from), decision_cases: [{ id: "case", question: "Review the source instruction" }] });
      expectRejected(await move(path, to), "Resolve Decision Center item: Review the source instruction");
      // The actual query includes both open and snoozed blocking cases; resolved
      // and nonblocking cases never enter the gate's projection.
      expect(tx.transfer.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        include: expect.objectContaining({ decision_cases: {
          where: { status: { in: ["OPEN", "SNOOZED"] }, blocks_transfer: true },
          select: { id: true, question: true },
        } }),
      }));
    });

    it.each(["IN_TRANSFER", "FUNDED"] as const)("requires explicit approval before Decision → %s even with all visible tasks done", async (to) => {
      row = fixture({ funding_plan_complete: false, tasks: visibleTasks("DECISION") });
      expectRejected(await move(path, to), "Approve the current funding plan before advancing.");
    });

    it("does not treat a legacy completion boolean and empty checklist as approval", async () => {
      row = fixture({ funding_plan_version: 0, funding_plan_complete: true });
      expectRejected(await move(path, "IN_TRANSFER"), "Approve the current funding plan before advancing.");
    });

    it("blocks an invalidated versioned plan at the later-stage forward boundary", async () => {
      row = fixture({ stage: "IN_TRANSFER", funding_plan_complete: false, funding_plan_version: 2 });
      expectRejected(await move(path, "FUNDED"), "Operations must review the invalidated funding plan. Return this transfer to Preparation and approve the current plan before advancing.");
    });

    it.each([false, true])("requires Operations approval for a legacy In transfer plan even when completion=%s", async (complete) => {
      row = fixture({ stage: "IN_TRANSFER", funding_plan_complete: complete, funding_plan_version: 0,
        tasks: visibleTasks("IN_TRANSFER") });
      expectRejected(await move(path, "FUNDED"), "Operations must review and approve the current funding plan before marking this transfer Funded.");
    });

    it("allows an In transfer record with explicit approval and completed current-stage work to become Funded", async () => {
      row = fixture({ stage: "IN_TRANSFER", tasks: visibleTasks("IN_TRANSFER"),
        accounts_opened_at_apex: false, funding_initiated: false, cash_in_flight: false });
      const result = await move(path, "FUNDED");
      if (path === "toolbar") expect(result).toMatchObject({ ok: true });
      else expect(result).toBeUndefined();
      expect(tx.transfer.update).toHaveBeenCalledOnce();
      expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stage: "FUNDED" }) }));
    });

    it("preserves backward review and no-op behavior for legacy In transfer records", async () => {
      row = fixture({ stage: "IN_TRANSFER", funding_plan_complete: false, funding_plan_version: 0,
        tasks: visibleTasks("IN_TRANSFER", false) });
      await move(path, "IN_TRANSFER");
      expect(tx.transfer.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      await move(path, "DECISION");
      expect(tx.transfer.update).toHaveBeenCalledOnce();
      expect(tx.transferTask.createMany).not.toHaveBeenCalled();
      expect(tx.transfer.update.mock.calls[0][0].data).not.toHaveProperty("funding_plan_complete");
      expect(tx.transfer.update.mock.calls[0][0].data).not.toHaveProperty("funding_plan_version");
    });

    it.each(["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"])("lets %s advance an approved ready non-DRS plan", async (role) => {
      spies.auth.mockResolvedValue({ user: { role, email: "stage-writer@example.invalid" } });
      row = fixture({ tasks: visibleTasks("DECISION") });
      const result = await move(path, "IN_TRANSFER");
      if (path === "toolbar") expect(result).toEqual({ ok: true, warnings: [] });
      else expect(result).toBeUndefined();
      expect(tx.transfer.update).toHaveBeenCalledOnce();
      expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ stage: "IN_TRANSFER" }) }));
    });

    it.each(["VIEWER", "UNKNOWN"])("rejects %s before writes, independently of database policies", async (role) => {
      spies.auth.mockResolvedValue({ user: { role, email: "stage-denied@example.invalid" } });
      expectRejected(await move(path, "IN_TRANSFER"), "Your role cannot change transfer stages.");
    });

    it("rejects an archived stage change even through a direct action call", async () => {
      row = fixture({ archived_at: new Date(), stage: "IN_TRANSFER" });
      expectRejected(await move(path, "DECISION"), "Archived transfers are read-only.");
    });

    it("allows backward review despite invalidation, unfinished work and blocking cases", async () => {
      row = fixture({ stage: "IN_TRANSFER", funding_plan_complete: false, funding_plan_version: 2,
        tasks: visibleTasks("IN_TRANSFER", false), decision_cases: [{ id: "case", question: "Review source" }] });
      await move(path, "DECISION");
      expect(tx.transfer.update).toHaveBeenCalledOnce();
      expect(tx.transferTask.createMany).not.toHaveBeenCalled();
      expect(tx.transfer.update.mock.calls[0][0].data).not.toHaveProperty("funding_plan_complete");
      expect(tx.transfer.update.mock.calls[0][0].data).not.toHaveProperty("funding_plan_version");
    });

    it("keeps no-op stage submissions free of writes and task resets", async () => {
      row = fixture({ funding_plan_complete: false, decision_cases: [{ id: "case", question: "Review source" }] });
      await move(path, "DECISION");
      expect(tx.transfer.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.transferTask.createMany).not.toHaveBeenCalled();
    });

    it("keeps checklist precedence limited to readiness when skipping Decision → Funded", async () => {
      row = fixture({ tasks: visibleTasks("DECISION"), accounts_opened_at_apex: false,
        funding_initiated: false, cash_in_flight: false });
      const result = await move(path, "FUNDED");
      if (legacy && !checklist) expectRejected(result, "Accounts opened at Apex");
      else expect(tx.transfer.update).toHaveBeenCalledOnce();
    });
  });
});
