import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Prisma } from "@prisma/client";
import { partialAcatQueueTasks, readPartialAcatTasks } from "@/lib/data/partial-acat-workspace-tasks";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "@/lib/data/partial-acat-tasks";
import {
  partialAcatCompletionUpdate,
  partialAcatSourceKey,
  partialAcatWorkspaceTask,
  type PartialAcatTaskRow,
} from "@/lib/transfers/partial-acat-queue";
import { queueRows, type WorkspaceTransfer } from "@/lib/transfers/workspace-queue";

const TRANSFER = "synthetic-transfer";
const TRACK = PARTIAL_ACAT_EXECUTION_TASKS[2];

function row(overrides: Partial<PartialAcatTaskRow> = {}): PartialAcatTaskRow {
  return {
    id: "partial-track", transferId: TRANSFER, title: TRACK.title, sortOrder: TRACK.sort, status: "TODO",
    ownerTeam: TRACK.owner, taskKey: TRACK.key, sourceKey: partialAcatSourceKey(TRANSFER, TRACK.key),
    priority: "NORMAL", completedAt: null, completedBy: null, updatedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function transfer(tasks: WorkspaceTransfer["tasks"]): WorkspaceTransfer {
  return {
    id: TRANSFER, clientName: "Synthetic Client", clientFirstName: "Synthetic", clientLastName: "Client",
    clientSfId: null, householdSfId: "HH-SYN", householdName: "Synthetic Household", stage: "IN_TRANSFER",
    fundingType: "ACAT_PARTIAL", transferringFirm: "Synthetic Brokerage", receivingAccount: "Roth IRA", value: 25000,
    dealId: null, dealName: null, dealRef: null, source: { institution: "Synthetic Brokerage", type: "Roth IRA", last4: "2488" },
    destination: { type: "Roth IRA", last4: null, opening: false }, receivingAccounts: [], appAuthorized: false,
    statement: null, outcome: null, rejection: null, receipts: 0, tasks,
  };
}

describe("standard partial ACAT tasks in the workspace", () => {
  it("counts a canonical step and leaves a changed route, a bad key, and unfinished archived work out", () => {
    const active = partialAcatWorkspaceTask(row(), "ACAT_PARTIAL");
    expect(active).toMatchObject({ title: TRACK.title, status: "Ready", team: "Operations", assignedTo: null, followUpOn: null });
    expect(partialAcatWorkspaceTask(row({ status: "BLOCKED" }), "ACAT_PARTIAL")?.status).toBe("Waiting");
    expect(partialAcatWorkspaceTask(row({ status: "DONE" }), "ACAT_PARTIAL")?.status).toBe("Completed");
    expect(partialAcatWorkspaceTask(row({ status: "IN_PROGRESS" }), null)?.status).toBe("Ready");
    expect(partialAcatWorkspaceTask(row(), "ACAT_FULL")).toBeNull();
    expect(partialAcatWorkspaceTask(row({ sourceKey: `asset-transfer:${TRANSFER}:drs:${TRACK.key}` }), "ACAT_PARTIAL")).toBeNull();
    expect(partialAcatWorkspaceTask(row({ ownerTeam: "CLIENT_SERVICE" }), "ACAT_PARTIAL")).toBeNull();
    expect(partialAcatWorkspaceTask(row(), "ACAT_PARTIAL", true)).toBeNull();
    expect(partialAcatWorkspaceTask(row({ status: "DONE" }), "ACAT_PARTIAL", true)?.status).toBe("Completed");
  });

  it("joins the work queue and uses the same follow-up filters as a task with no follow-up", () => {
    const ready = partialAcatWorkspaceTask(row(), "ACAT_PARTIAL");
    const waiting = partialAcatWorkspaceTask(row({ id: "partial-blocked", status: "BLOCKED", sortOrder: TRACK.sort + 1 }), "ACAT_PARTIAL");
    const movement = transfer([ready, waiting].filter(task => task != null));
    const titles = (followUp?: "due" | "missing") => queueRows([movement], {
      query: "", team: null, stage: null, followUp: followUp ? { filter: followUp, today: "2026-10-24" } : null,
    }).map(entry => entry.task.id);
    expect(titles()).toEqual(["partial-track", "partial-blocked"]);
    expect(queueRows([movement], { query: "", team: "Operations", stage: "IN_TRANSFER" }).map(entry => entry.task.id)).toEqual(["partial-track", "partial-blocked"]);
    expect(queueRows([movement], { query: "", team: "Client Service", stage: null })).toEqual([]);
    expect(titles("due")).toEqual([]);
    expect(titles("missing")).toEqual(["partial-blocked"]);
  });

  it("reopens a completed step and marks an open step done through the decision-task writer", () => {
    const open = row();
    expect(partialAcatCompletionUpdate({
      id: open.id, status: open.status, priority: open.priority, updatedAt: open.updatedAt, fundingPlanVersion: 4, fundingMethodRevision: 2,
    })).toMatchObject({ taskId: open.id, status: "DONE", expectedFundingPlanVersion: 4, expectedFundingMethodRevision: 2 });
    expect(partialAcatCompletionUpdate({
      id: open.id, status: "DONE", priority: "HIGH", updatedAt: open.updatedAt, fundingPlanVersion: 4, fundingMethodRevision: 0,
    }).status).toBe("TODO");
  });

  it("reads only decision tasks with a canonical partial-ACAT key", async () => {
    const findMany = vi.fn(async () => [row({ transferId: TRANSFER })].map(task => ({
      id: task.id, transfer_id: task.transferId, title: task.title, sort_order: task.sortOrder, status: task.status,
      owner_team: task.ownerTeam, task_key: task.taskKey, source_key: task.sourceKey, priority: task.priority,
      completed_at: null, completed_by: null, updated_at: new Date(task.updatedAt),
    })));
    const tx = { decisionTask: { findMany } } as unknown as Prisma.TransactionClient;
    const tasks = await readPartialAcatTasks(tx, [TRANSFER]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { transfer_id: { in: [TRANSFER] }, decision_id: null, task_key: { in: PARTIAL_ACAT_EXECUTION_TASKS.map(task => task.key) } },
    }));
    expect(partialAcatQueueTasks(tasks, new Map([[TRANSFER, "ACAT_PARTIAL"]])).get(TRANSFER)?.map(task => task.title)).toEqual([TRACK.title]);
    expect(await readPartialAcatTasks(tx, [])).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
