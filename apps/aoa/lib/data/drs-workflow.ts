import type { TransferStage } from "./transfer-types";

/** Stable task identities; display copy must never be used as a gate key. */
export const DRS_TASKS = [
  { key: "paperwork", taskKey: "drs-paperwork", title: "Obtain signed full-transfer paperwork", ownerTeam: "CLIENT_SERVICE", requiredBefore: "IN_TRANSFER" },
  { key: "statement", taskKey: "drs-statement", title: "Obtain a statement identifying the DRS transfer", ownerTeam: "CLIENT_SERVICE", requiredBefore: "IN_TRANSFER" },
  { key: "receiving-account", taskKey: "drs-receiving-account", title: "Confirm or open the receiving account", ownerTeam: "CLIENT_SERVICE", requiredBefore: "IN_TRANSFER" },
  { key: "instructions-approved", taskKey: "drs-instructions-approved", title: "Review and approve the DRS transfer instructions", ownerTeam: "OPERATIONS", requiredBefore: "IN_TRANSFER" },
  { key: "apex-submitted", taskKey: "drs-apex-submitted", title: "Submit the DRS request to Apex", ownerTeam: "OPERATIONS", requiredBefore: "IN_TRANSFER" },
  { key: "apex-confirmed", taskKey: "drs-apex-confirmed", title: "Record Apex confirmation that the assets moved", ownerTeam: "OPERATIONS", requiredBefore: "FUNDED" },
  { key: "reconciliation", taskKey: "drs-reconciliation", title: "Reconcile received securities and resolve differences", ownerTeam: "OPERATIONS", requiredBefore: null },
  { key: "client-communication", taskKey: "drs-client-communication", title: "Notify the client and handle additional client requests", ownerTeam: "CLIENT_SERVICE", requiredBefore: null },
] as const;

export type DrsTaskDefinition = (typeof DRS_TASKS)[number];
export type DrsTaskKey = DrsTaskDefinition["key"];
export type DrsTaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type DrsWorkflowTaskRow = {
  id: string;
  key: DrsTaskKey;
  taskKey: DrsTaskDefinition["taskKey"];
  title: string;
  ownerTeam: DrsTaskDefinition["ownerTeam"];
  status: DrsTaskStatus;
  priority: "LOW" | "NORMAL" | "HIGH";
  completedAt: string | null;
  completedBy: string | null;
  updatedAt: string;
  fundingPlanVersion: number;
};

export function drsTaskSourceKey(transferId: string, key: DrsTaskKey): string {
  return `asset-transfer:${transferId}:drs:${key}`;
}

export function getDrsTaskDefinition(taskKey: string): DrsTaskDefinition | undefined {
  return DRS_TASKS.find((task) => task.taskKey === taskKey);
}

export function isDrsTask(task: { task_key: string; source_key: string | null }): boolean {
  // Recognize malformed DRS rows too, so they cannot fall through to the less
  // restrictive generic task writer. Canonical identity is checked separately.
  return task.task_key?.startsWith("drs-") || /:drs:/.test(task.source_key ?? "");
}

export function drsTasksForStage(stage: TransferStage, methodChangePending = false): readonly DrsTaskDefinition[] {
  if (stage === "DECISION") return DRS_TASKS.filter((task) => task.requiredBefore === "IN_TRANSFER");
  if (stage === "IN_TRANSFER") return methodChangePending ? DRS_TASKS : DRS_TASKS.filter((task) => task.requiredBefore !== "IN_TRANSFER");
  return DRS_TASKS.filter((task) => task.requiredBefore === null);
}

export function canUpdateDrsTask(role: string | null | undefined, ownerTeam: string): boolean {
  if (role === "ADMIN" || role === "OPERATIONS") return true;
  return role === "CLIENT_SERVICE" && ownerTeam === "CLIENT_SERVICE";
}

/** Shared UI/server eligibility; persistence also checks route, revision and archive state. */
export function drsTaskStatusError(input: {
  taskKey: string;
  role: string | null | undefined;
  stage: string;
  status: DrsTaskStatus;
  currentStatus: DrsTaskStatus;
  methodChangePending?: boolean;
}): string | null {
  const task = getDrsTaskDefinition(input.taskKey);
  if (!task) return "This DRS task is not recognized. Refresh the transfer.";
  if (!canUpdateDrsTask(input.role, task.ownerTeam)) {
    return task.ownerTeam === "OPERATIONS"
      ? "Operations must update this DRS task."
      : "Client Service or Operations must update this DRS task.";
  }
  if (!["DECISION", "IN_TRANSFER", "FUNDED"].includes(input.stage)) {
    return "This transfer's current stage does not permit DRS task updates.";
  }
  if (input.status === input.currentStatus) return null;
  if (task.requiredBefore === "IN_TRANSFER" && input.stage !== "DECISION" &&
      !(input.stage === "IN_TRANSFER" && input.methodChangePending)) {
    return "Preparation tasks cannot change after the DRS transfer advances.";
  }
  if (task.requiredBefore === "FUNDED" && input.stage !== "IN_TRANSFER") {
    return "Record Apex asset-movement confirmation while the DRS transfer is In transfer.";
  }
  if (task.key === "reconciliation" && input.stage === "DECISION" && input.status === "DONE") {
    return "Reconcile received securities after the DRS transfer enters In transfer.";
  }
  return null;
}

export type DrsGateTask = { taskKey: string; status: string };

/** DRS has its own requirements, independent of the legacy ACAT/cash flags. */
export function drsWorkflowGate(input: {
  from: TransferStage;
  to: TransferStage;
  fundingPlanComplete: boolean;
  fundingPlanVersion: number;
  tasks: readonly DrsGateTask[];
  blockingExceptions?: number;
  archived?: boolean;
  methodChangePending?: boolean;
}): { blocked: boolean; unmet: string[] } {
  if (input.archived) return { blocked: true, unmet: ["Archived transfers cannot advance."] };
  const order: readonly TransferStage[] = ["DECISION", "IN_TRANSFER", "FUNDED"];
  if (!order.includes(input.from) || !order.includes(input.to)) {
    return { blocked: true, unmet: ["This transfer has an unsupported DRS stage. Ask Operations to review it."] };
  }
  if (order.indexOf(input.to) <= order.indexOf(input.from)) return { blocked: false, unmet: [] };
  const unmet: string[] = [];
  if (input.from === "DECISION" && input.to === "FUNDED") {
    unmet.push("Move the DRS transfer to In transfer after submission to Apex before marking it Funded.");
  }
  if (!input.fundingPlanComplete || !Number.isInteger(input.fundingPlanVersion) || input.fundingPlanVersion < 1) {
    unmet.push("Approve the current DRS funding plan.");
  }
  if ((input.blockingExceptions ?? 0) > 0) unmet.push("Resolve the transfer's blocking exceptions.");
  const inventory = new Map<string, DrsGateTask[]>();
  for (const task of input.tasks) inventory.set(task.taskKey, [...(inventory.get(task.taskKey) ?? []), task]);
  for (const definition of DRS_TASKS) {
    const found = inventory.get(definition.taskKey) ?? [];
    if (found.length !== 1) {
      unmet.push(`Initialize or repair DRS task: ${definition.title}.`);
    } else if ((definition.requiredBefore === input.to ||
      (input.methodChangePending && input.to === "FUNDED" && definition.requiredBefore === "IN_TRANSFER")) && found[0].status !== "DONE") {
      unmet.push(definition.title);
    }
  }
  return { blocked: unmet.length > 0, unmet };
}
