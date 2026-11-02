import { beforeEach, describe, expect, it, vi } from "vitest";
const { scopeSpy } = vi.hoisted(() => ({ scopeSpy: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
import { DRS_TASKS, drsTaskSourceKey } from "@/lib/data/drs-workflow";
import { getDrsWorkflowTasks, readDrsWorkflowTasks, syncDrsWorkflowTasks } from "@/lib/data/drs-workflow-store";
import { listDecisionTasks } from "@/lib/data/decision-cases";

const identity = { role: "OPERATIONS", email: "ops@example.com" };
const at = new Date("2026-09-25T12:00:00.000Z");
function taskRows() {
  return DRS_TASKS.map((task, index) => ({
    id: `task-${index}`, source_key: drsTaskSourceKey("transfer-1", task.key),
    task_key: task.taskKey, transfer_id: "transfer-1", decision_id: null, parent_task_id: null,
    title: task.title, owner_team: task.ownerTeam, status: "TODO", priority: "HIGH",
    created_by: identity.email, created_at: at, updated_at: at, completed_by: null, completed_at: null,
    transfer: { funding_type: "DRS", funding_plan_complete: true, funding_plan_version: 3,
      stage: "FUNDED", archived_at: null, household_name: "Synthetic DRS" },
  }));
}

beforeEach(() => vi.clearAllMocks());

describe("DRS materialization and active-task reads", () => {
  it("uses stable owned task identities and preserves same-route completion", async () => {
    const upsert = vi.fn(async (_args: unknown) => ({}));
    expect(await syncDrsWorkflowTasks({ decisionTask: { upsert, findMany: vi.fn(async () => []) } } as never, identity, { transferId: "transfer-1" })).toBe(8);
    expect(upsert).toHaveBeenCalledTimes(8);
    for (const [index, call] of upsert.mock.calls.entries()) {
      const args = call[0] as { where: object; create: object; update: object };
      expect(args.where).toEqual({ source_key: drsTaskSourceKey("transfer-1", DRS_TASKS[index].key) });
      expect(args.create).toMatchObject({ task_key: DRS_TASKS[index].taskKey, owner_team: DRS_TASKS[index].ownerTeam, decision_id: null });
      expect(args.update).not.toHaveProperty("status");
      expect(args.update).not.toHaveProperty("completed_at");
    }
  });

  it("clears old completion only when an approved route returns to DRS", async () => {
    const upsert = vi.fn(async (_args: unknown) => ({}));
    await syncDrsWorkflowTasks({ decisionTask: { upsert, findMany: vi.fn(async () => taskRows()) } } as never, identity, { transferId: "transfer-1", restartExistingTasks: true });
    for (const call of upsert.mock.calls) expect(call[0]).toMatchObject({ update: { status: "TODO", completed_by: null, completed_at: null } });
  });

  it("rejects malformed identity before writes instead of reassigning history", async () => {
    const upsert = vi.fn();
    const findMany = vi.fn(async () => [{ ...taskRows()[0], transfer_id: "wrong-transfer" }]);
    await expect(syncDrsWorkflowTasks({ decisionTask: { upsert, findMany } } as never, identity, { transferId: "transfer-1" }))
      .rejects.toThrow("DRS_TASK_IDENTITY_CONFLICT");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns canonical rows with current plan tokens and omits corrupt identities", async () => {
    const rows = taskRows();
    rows[1].task_key = "corrupt-task" as never;
    rows[2].owner_team = "OPERATIONS";
    const findMany = vi.fn(async () => rows);
    const read = await readDrsWorkflowTasks({ decisionTask: { findMany } } as never, { transferId: "transfer-1", fundingPlanVersion: 4 });
    expect(read).toHaveLength(6);
    expect(read[0]).toMatchObject({ key: "paperwork", updatedAt: at.toISOString(), fundingPlanVersion: 4 });
    expect(findMany).toHaveBeenCalledWith({ where: expect.objectContaining({ transfer_id: "transfer-1", decision_id: null }) });
  });

  it("never initializes tasks on a GET and stops exposing a departed route", async () => {
    const tx = { transfer: { findUnique: vi.fn(async () => ({ funding_type: "ACAT_FULL" })) }, decisionTask: { findMany: vi.fn() } };
    scopeSpy.mockImplementation(async (_identity, fn) => fn(tx));
    expect(await getDrsWorkflowTasks(identity, "transfer-1")).toEqual([]);
    expect(tx.decisionTask.findMany).not.toHaveBeenCalled();
  });

  it("keeps Funded follow-ups in Tasks with tokens but hides inactive route history", async () => {
    const rows = taskRows();
    const legacy = { ...rows[0], id: "legacy-task", task_key: "resolve-decision", source_key: "legacy", transfer: { ...rows[0].transfer, funding_type: "ACAT_FULL" } };
    rows[0].transfer.funding_type = "ACAT_FULL";
    const tx = { decisionTask: { findMany: vi.fn(async () => [...rows, legacy]) } };
    scopeSpy.mockImplementation(async (_identity, fn) => fn(tx));
    const listed = await listDecisionTasks(identity);
    expect(listed).toHaveLength(8);
    expect(listed.find((task) => task.id === "task-0")).toBeUndefined();
    expect(listed.find((task) => task.id === "task-7")?.drs).toEqual({ key: "client-communication", stage: "FUNDED", archived: false,
      fundingPlanComplete: true, fundingPlanVersion: 3, updatedAt: at.toISOString() });
    expect(listed.find((task) => task.id === "legacy-task")?.drs).toBeUndefined();
  });
});
