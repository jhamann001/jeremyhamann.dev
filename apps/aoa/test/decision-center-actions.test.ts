import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, scopeSpy, revalidateSpy, auditSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  scopeSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  auditSpy: vi.fn(async () => {}),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  writeAudit: auditSpy,
}));

import {
  createManualDecision,
  createTransferExceptionDecision,
  resolveDecisionCase,
  updateDecisionTask,
} from "@/app/(authenticated)/(workflow)/decision-center/actions";
import {
  DECISION_CASE_CREATE,
  DECISION_CASE_RESOLVE,
  DECISION_TASK_UPDATE,
} from "@/lib/audit";

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: { findUnique: ReturnType<typeof vi.fn> };
  decisionCase: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  decisionTask: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  decisionCaseEvent: { create: ReturnType<typeof vi.fn> };
};

let tx: FakeTx;

beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue({ user: { email: "ops@example.com", role: "OPERATIONS" } });
  tx = {
    $queryRaw: vi.fn(async () => [{ id: "transfer-1" }]),
    transfer: { findUnique: vi.fn() },
    decisionCase: {
      create: vi.fn(async () => ({ id: "decision-1" })),
      findUnique: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    decisionTask: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async ({ create }: { create: { task_key: string } }) => ({
        id: `task-${create.task_key}`,
      })),
    },
    decisionCaseEvent: { create: vi.fn(async () => ({})) },
  };
  scopeSpy.mockImplementation(
    async (_identity: unknown, fn: (client: FakeTx) => Promise<unknown>) => fn(tx),
  );
});

describe("Decision Center server actions", () => {
  it("persists manual/general entry in the same queue contract", async () => {
    const result = await createManualDecision({
      householdName: "Nguyen Household",
      question: "Which account should fund the planned gift?",
      ownerTeam: "ADVISORY",
    });

    expect(result).toEqual({ ok: true, id: "decision-1" });
    const data = tx.decisionCase.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: "MANUAL",
      household_name: "Nguyen Household",
      category: "Unclassified",
      owner_team: "ADVISORY",
    });
    expect(data.tasks.create).toMatchObject({ owner_team: "ADVISORY", task_key: "resolve-decision" });
    expect(tx.decisionCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CREATED", to_status: "OPEN" }),
    });
    expect(auditSpy).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({ action: DECISION_CASE_CREATE, entityId: "decision-1" }),
    );
  });

  it("creates a deliberate transfer exception with a frozen linked snapshot", async () => {
    tx.transfer.findUnique.mockResolvedValue({
      id: "transfer-1",
      client_first_name: "Ada",
      client_last_name: "Okafor",
      household_name: "Okafor Household",
      household_sf_id: "sf-household-1",
      funding_plan_version: 2,
      funding_plan_complete: true,
      funding_plan_approvals: [{
        version: 2,
        snapshot: {
          positions: [
            { symbol: "VTI", isTransferring: true, marketValue: 100 },
            { symbol: "XYZIX", isTransferring: false, marketValue: 25 },
          ],
        },
      }],
    });

    const result = await createTransferExceptionDecision({
      transferId: "transfer-1",
      question: "Confirm whether this restriction requires advisor review.",
      ownerTeam: "OPERATIONS",
      blocksTransfer: true,
    });

    expect(result).toEqual({ ok: true, id: "decision-1" });
    const data = tx.decisionCase.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: "ASSET_TRANSFER",
      transfer_id: "transfer-1",
      client_name: "Ada Okafor",
      household_name: "Okafor Household",
      category: "Asset transfer exception",
      question: "Confirm whether this restriction requires advisor review.",
      owner_team: "OPERATIONS",
      blocks_transfer: true,
      source_version: 2,
    });
    expect(data.source_snapshot).toMatchObject({
      fundingPlanVersion: 2,
      included: ["VTI"],
      excluded: ["XYZIX"],
    });
    expect(data.tasks.create).toMatchObject({
      task_key: "resolve-transfer-exception",
      owner_team: "OPERATIONS",
      transfer_id: "transfer-1",
      priority: "HIGH",
    });
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("preserves %s escalation without claiming hidden approval facts", async (role) => {
    authSpy.mockResolvedValue({ user: { email: "writer@example.test", role } });
    tx.transfer.findUnique.mockResolvedValue({
      id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client",
      household_name: "Synthetic Household", household_sf_id: null,
      funding_plan_version: 2, funding_plan_complete: true, funding_plan_approvals: [],
    });
    expect(await createTransferExceptionDecision({
      transferId: "transfer-1", question: "Review synthetic registration.",
      ownerTeam: "OPERATIONS", blocksTransfer: true,
    })).toEqual({ ok: true, id: "decision-1" });
    expect(tx.decisionCase.create.mock.calls[0][0].data).toMatchObject({
      source_version: 2,
      source_label: "Asset Transfer · exception · approval details unavailable",
      source_snapshot: { fundingPlanVersion: null, positions: [], included: [], excluded: [] },
    });
  });

  it.each([
    { version: 0, complete: false, approvals: [] },
    { version: 3, complete: false, approvals: [{ version: 2, snapshot: { positions: [{ symbol: "STALE", isTransferring: true }] } }] },
    { version: 3, complete: true, approvals: [{ version: 2, snapshot: { positions: [{ symbol: "STALE", isTransferring: true }] } }] },
  ])("does not freeze a fabricated or stale approved plan ($version, $complete)", async ({ version, complete, approvals }) => {
    tx.transfer.findUnique.mockResolvedValue({
      id: "transfer-1", client_first_name: "Synthetic", client_last_name: "Client",
      household_name: "Synthetic Household", household_sf_id: null,
      funding_plan_version: version, funding_plan_complete: complete, funding_plan_approvals: approvals,
    });
    expect(await createTransferExceptionDecision({
      transferId: "transfer-1", question: "Review synthetic registration.",
      ownerTeam: "OPERATIONS", blocksTransfer: true,
    })).toMatchObject({ ok: true });
    expect(tx.decisionCase.create.mock.calls[0][0].data).toMatchObject({
      source_version: Math.max(version, 1),
      source_label: complete
        ? "Asset Transfer · exception · approval details unavailable"
        : "Asset Transfer · exception · plan not approved",
      source_snapshot: { fundingPlanVersion: null, positions: [], included: [], excluded: [] },
    });
  });

  it("finalizes a deliberate transfer exception and creates one owned follow-up task", async () => {
    const resolutionTask = {
      id: "resolve-1",
      decision_id: "decision-1",
      task_key: "resolve-transfer-exception",
      status: "TODO",
      completed_by: null as string | null,
      completed_at: null as Date | null,
    };
    tx.decisionTask.updateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.decision_id === resolutionTask.decision_id &&
        where.task_key.in.includes(resolutionTask.task_key)
      ) {
        Object.assign(resolutionTask, data);
        return { count: 1 };
      }
      return { count: 0 };
    });
    tx.decisionCase.findUnique.mockResolvedValue({
      id: "decision-1",
      source: "ASSET_TRANSFER",
      transfer_id: "transfer-1",
      status: "OPEN",
      version: 0,
      owner_team: "CLIENT_SERVICE",
      tasks: [resolutionTask],
    });

    const result = await resolveDecisionCase({
      decisionId: "decision-1",
      baseVersion: 0,
      resolutionCode: "TRANSFER_EXCEPTION_APPROVED",
      resolutionSummary: "Proceed using the approved exception instructions.",
    });

    expect(result).toEqual({ ok: true, id: "decision-1" });
    expect(resolutionTask).toMatchObject({
      status: "DONE",
      completed_by: "ops@example.com",
      completed_at: expect.any(Date),
    });
    expect(tx.decisionCase.updateMany).toHaveBeenCalledWith({
      where: { id: "decision-1", version: 0, status: "OPEN" },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolution_code: "TRANSFER_EXCEPTION_APPROVED",
        version: 1,
        resolved_by: "ops@example.com",
      }),
    });
    const taskWrites = tx.decisionTask.upsert.mock.calls.map((call) => call[0]);
    expect(taskWrites).toHaveLength(1);
    expect(taskWrites[0].create).toMatchObject({
      task_key: "execute-resolution",
      owner_team: "CLIENT_SERVICE",
      title: "Carry out the approved Asset Transfer exception",
    });
    expect(JSON.stringify(taskWrites)).not.toMatch(/medallion/i);
    expect(auditSpy).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({ action: DECISION_CASE_RESOLVE, entityId: "decision-1" }),
    );
  });

  it("refuses a viewer before writing a resolution", async () => {
    authSpy.mockResolvedValue({ user: { email: "viewer@example.com", role: "VIEWER" } });
    const result = await resolveDecisionCase({
      decisionId: "decision-1",
      baseVersion: 0,
      resolutionCode: "TRANSFER_EXCEPTION_APPROVED",
      resolutionSummary: "Must not save.",
    });
    expect(result).toEqual({ ok: false, message: "You do not have permission to resolve decisions." });
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(tx.decisionCase.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a stale or already-resolved draft before task generation", async () => {
    tx.decisionCase.findUnique.mockResolvedValue({
      id: "decision-1",
      source: "MANUAL",
      transfer_id: null,
      status: "RESOLVED",
      version: 1,
      owner_team: "OPERATIONS",
      tasks: [],
    });

    const result = await resolveDecisionCase({
      decisionId: "decision-1",
      baseVersion: 0,
      resolutionCode: "GENERAL_APPROVED",
      resolutionSummary: "Approved.",
    });

    expect(result).toMatchObject({ ok: false });
    expect(tx.decisionCase.updateMany).not.toHaveBeenCalled();
    expect(tx.decisionTask.upsert).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("lets only one simultaneous same-version resolution generate execution work", async () => {
    // Both requests have already read the same draft. The conditional write
    // models the database rechecking its predicate after the first commit.
    const saved = {
      id: "decision-1",
      source: "ASSET_TRANSFER",
      transfer_id: "transfer-1",
      status: "OPEN",
      version: 0,
      owner_team: "OPERATIONS",
      tasks: [],
      resolution_summary: null as string | null,
    };
    tx.decisionCase.findUnique.mockImplementation(async () => ({ ...saved }));
    tx.decisionCase.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.version !== saved.version || where.status !== saved.status) return { count: 0 };
      Object.assign(saved, data);
      return { count: 1 };
    });

    const results = await Promise.all([
      resolveDecisionCase({
        decisionId: saved.id, baseVersion: 0,
        resolutionCode: "TRANSFER_EXCEPTION_APPROVED", resolutionSummary: "First instruction.",
      }),
      resolveDecisionCase({
        decisionId: saved.id, baseVersion: 0,
        resolutionCode: "TRANSFER_EXCEPTION_APPROVED", resolutionSummary: "Second instruction.",
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ message: expect.stringContaining("changed while you were reviewing") }),
    ]);
    expect(saved).toMatchObject({ version: 1, resolution_summary: "First instruction." });
    expect(tx.decisionCase.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.decisionTask.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.decisionTask.upsert).toHaveBeenCalledTimes(1);
    expect(tx.decisionCaseEvent.create).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it("updates a transfer-owned workflow task without inventing a decision event", async () => {
    tx.decisionTask.findUnique.mockResolvedValue({
      id: "task-1",
      decision_id: null,
      transfer_id: "transfer-1",
      status: "TODO",
      priority: "HIGH",
      updated_at: new Date("2026-09-20T12:00:00Z"),
    });
    tx.transfer.findUnique.mockResolvedValue({ archived_at: null, funding_type: "ACAT_PARTIAL" });

    const result = await updateDecisionTask({
      taskId: "task-1",
      status: "IN_PROGRESS",
      priority: "HIGH",
    });

    expect(result).toEqual({ ok: true, id: "task-1" });
    expect(tx.decisionTask.update).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: expect.objectContaining({ status: "IN_PROGRESS", priority: "HIGH" }),
    });
    expect(tx.decisionCaseEvent.create).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({
        action: DECISION_TASK_UPDATE,
        entityType: "transfer",
        entityId: "transfer-1",
      }),
    );
  });
  it.each([
    {
      name: "an archived transfer",
      task: { task_key: "track-partial-acat", source_key: "asset-transfer:transfer-1:standard-partial-acat:track-partial-acat" },
      transfer: { archived_at: new Date("2026-09-20T00:00:00Z"), funding_type: "ACAT_PARTIAL" },
      message: "This transfer is archived, so its tasks can no longer be changed.",
    },
    {
      name: "a partial-ACAT step whose approved route changed",
      task: { task_key: "track-partial-acat", source_key: "asset-transfer:transfer-1:standard-partial-acat:track-partial-acat" },
      transfer: { archived_at: null, funding_type: "WIRE" },
      message: "This step is no longer on the transfer's approved plan, so it can't be changed. Refresh the page.",
    },
    {
      name: "an unreadable transfer",
      task: { task_key: "track-partial-acat", source_key: null },
      transfer: null,
      message: "This task is no longer available.",
    },
  ])("refuses a task write on $name without saving or auditing (ticket)", async ({ task, transfer, message }) => {
    tx.decisionTask.findUnique.mockResolvedValue({
      id: "task-1", decision_id: null, transfer_id: "transfer-1", status: "DONE", priority: "HIGH", ...task,
    });
    tx.transfer.findUnique.mockResolvedValue(transfer);

    expect(await updateDecisionTask({ taskId: "task-1", status: "TODO", priority: "HIGH" }))
      .toEqual({ ok: false, message });
    expect(tx.decisionTask.update).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("refuses the legacy excluded-positions task whose decision Decision Center hides (ticket)", async () => {
    tx.decisionTask.findUnique.mockResolvedValue({
      id: "task-1", decision_id: "legacy", transfer_id: null, status: "DONE", priority: "NORMAL",
      task_key: "resolve-excluded-positions", source_key: null,
    });
    tx.decisionCase.findUnique.mockResolvedValue({
      source_key: "asset-transfer:transfer-1:excluded-positions", resolution_code: "STANDARD_PARTIAL_ACAT",
    });

    expect(await updateDecisionTask({ taskId: "task-1", status: "TODO", priority: "NORMAL" })).toEqual({
      ok: false,
      message: "This is an older record that was replaced by the standard partial-ACAT steps, so it can't be changed.",
    });
    expect(tx.decisionTask.update).not.toHaveBeenCalled();
    expect(tx.decisionCaseEvent.create).not.toHaveBeenCalled();
  });
});
