// Standard partial-ACAT steps live on decision_task, not transfer_task. This
// module decides which of those rows are still that transfer's work and how
// the workspace queue counts them. decision_task has no follow-up person or
// date, so the queue's follow-up filters see neither.
import { PARTIAL_ACAT_EXECUTION_TASKS } from "@/lib/data/partial-acat-tasks";
import type { FundingType } from "@/lib/data/transfer-types";
import type { DecisionTaskPriorityValue, DecisionTaskStatusValue } from "@/lib/data/decision-cases";
import { taskTeam, type TaskStatus, type WorkspaceTask } from "./workspace-queue";

export type PartialAcatTaskRow = {
  id: string;
  transferId: string;
  title: string;
  sortOrder: number;
  status: DecisionTaskStatusValue;
  ownerTeam: string;
  taskKey: string;
  sourceKey: string | null;
  priority: DecisionTaskPriorityValue;
  completedAt: string | null;
  completedBy: string | null;
  updatedAt: string;
};

export function partialAcatSourceKey(transferId: string, taskKey: string): string {
  return `asset-transfer:${transferId}:standard-partial-acat:${taskKey}`;
}

/** Ready, Waiting, or Completed for one canonical partial-ACAT step. Null when the row is not that work. */
export function partialAcatWorkspaceTask(
  row: PartialAcatTaskRow,
  fundingType: FundingType | null,
  archived = false,
): WorkspaceTask | null {
  if (archived && row.status !== "DONE") return null;
  if (fundingType !== null && fundingType !== "ACAT_PARTIAL") return null;
  const definition = PARTIAL_ACAT_EXECUTION_TASKS.find(task => task.key === row.taskKey);
  if (!definition || row.ownerTeam !== definition.owner) return null;
  if (row.sourceKey !== partialAcatSourceKey(row.transferId, definition.key)) return null;
  const team = definition.owner === "CLIENT_SERVICE" ? taskTeam("Client Service") : taskTeam("Operations");
  return {
    id: row.id, transferId: row.transferId, title: row.title, sortOrder: row.sortOrder,
    status: partialAcatQueueStatus(row.status), team, assignedTo: null, followUpOn: null,
  };
}

export function partialAcatQueueStatus(status: DecisionTaskStatusValue): TaskStatus {
  switch (status) {
    case "DONE":
      return "Completed";
    case "BLOCKED":
      return "Waiting";
    case "TODO":
    case "IN_PROGRESS":
      return "Ready";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/** The decision-task writer input for marking one of these steps done or reopening it. */
export function partialAcatCompletionUpdate(task: {
  id: string;
  status: string;
  priority: DecisionTaskPriorityValue;
  updatedAt: string;
  fundingPlanVersion: number;
  fundingMethodRevision: number;
}) {
  const status: DecisionTaskStatusValue = task.status === "DONE" ? "TODO" : "DONE";
  return {
    taskId: task.id, status, priority: task.priority, expectedUpdatedAt: task.updatedAt,
    expectedFundingPlanVersion: task.fundingPlanVersion, expectedFundingMethodRevision: task.fundingMethodRevision,
  };
}
