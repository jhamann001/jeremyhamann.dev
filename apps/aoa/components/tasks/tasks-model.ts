import type { TaskPriority, TaskStatus } from "@/lib/data/workflow-types";
import {
  DECISION_OWNER_LABEL,
  transferDetailHref,
} from "@/lib/data/decision-case-shared";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";
import type { DecisionTaskContext, DecisionTaskInactiveReason } from "@/lib/data/decision-task-context";
import { canUpdateDrsTask } from "@/lib/data/drs-workflow";
import type { TaskTransferSummary } from "@/lib/data/task-transfer-summary";

// Pure view-model for the Tasks page (ticket). Kept out of the components so
// the counting and linking rules are unit-testable without rendering React.

export type TaskLinkView =
  | { kind: "link"; label: string; href: string }
  | { kind: "note"; label: string };

export type TaskContextView = {
  decision: TaskLinkView | null;
  transfer: TaskLinkView | null;
  transferArchived: boolean;
  /** The approved resolution, shown on tasks of a resolved decision. */
  resolution: string | null;
};

/** A persisted task, shaped for the saved-task table and the closed list. */
export type PersistedTaskView = {
  id: string;
  persistentId: string;
  desc: string;
  householdName: string;
  needLabel: string;
  assignee: { kind: "group"; label: string };
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: string;
  createdAt: string;
  source: DecisionTaskRow["source"];
  taskKey?: string;
  sortOrder?: number;
  transferSummary: TaskTransferSummary | null;
  drs?: DecisionTaskRow["drs"];
  fundingMethod?: DecisionTaskRow["fundingMethod"];
  canUpdate: boolean;
  /** Why the row is read-only even for someone who can normally edit tasks. */
  readOnlyReason: string | null;
  context: TaskContextView;
  inactiveReason: DecisionTaskInactiveReason | null;
};

const STATUS = {
  TODO: "todo",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  DONE: "done",
} as const;
const PRIORITY = { LOW: "low", NORMAL: "normal", HIGH: "high" } as const;

export const NO_LINKS: TaskContextView = {
  decision: null,
  transfer: null,
  transferArchived: false,
  resolution: null,
};

/**
 * Links are offered ONLY for records this viewer's RLS scope resolved, and a
 * decision is described in place. Legacy excluded-positions records stay a
 * note. A row without context gets no links at all: no link without proof.
 */
export function taskContextView(context: DecisionTaskContext | undefined): TaskContextView {
  if (!context) return NO_LINKS;
  const { decision, transfer } = context;
  let decisionView: TaskLinkView | null = null;
  if (decision) {
    if (!decision.visible) decisionView = { kind: "note", label: "Linked decision unavailable" };
    else if (!decision.listed) decisionView = { kind: "note", label: "Older decision record, not shown in Decision Center" };
    else decisionView = { kind: "note", label: "Decision recorded" };
  }
  let transferView: TaskLinkView | null = null;
  if (transfer) {
    transferView = transfer.visible
      ? { kind: "link", label: "View transfer →", href: transferDetailHref(transfer.id) }
      : { kind: "note", label: "Linked transfer unavailable" };
  }
  const resolution = decision?.visible && decision.status === "RESOLVED" && decision.resolutionSummary
    ? decision.resolutionSummary
    : null;
  return {
    decision: decisionView,
    transfer: transferView,
    transferArchived: Boolean(transfer?.visible && transfer.archived),
    resolution,
  };
}

export function toPersistedTaskView(task: DecisionTaskRow, role: string): PersistedTaskView {
  // DRS guard from ticket (#752), unchanged.
  const drsAllowed = !task.drs || (!task.drs.archived && task.drs.fundingPlanComplete
    && task.drs.fundingPlanVersion > 0 && canUpdateDrsTask(role, task.ownerTeam));
  const methodAllowed = !task.fundingMethod || canUpdateDrsTask(role, task.ownerTeam);
  const archived = task.context?.transfer?.visible === true && task.context.transfer.archived;
  const inactiveReason = task.context?.inactiveReason ?? null;
  const summary = task.transferSummary;
  const readableTransfer = task.context?.transfer;
  const transferSummary = summary?.id?.trim() && summary.clientKey?.trim()
    && summary.id === task.transferId && readableTransfer?.visible && readableTransfer.id === summary.id
    ? summary : null;
  return {
    id: `durable-${task.id}`,
    persistentId: task.id,
    source: task.source,
    taskKey: task.taskKey,
    sortOrder: task.sortOrder,
    transferSummary,
    drs: task.drs,
    fundingMethod: task.fundingMethod,
    canUpdate: drsAllowed && methodAllowed && !archived && inactiveReason === null,
    readOnlyReason: archived ? "Read-only: the transfer is archived" : null,
    householdName: task.householdName,
    desc: task.title,
    assignee: { kind: "group", label: DECISION_OWNER_LABEL[task.ownerTeam] },
    status: STATUS[task.status],
    priority: PRIORITY[task.priority],
    createdBy:
      task.createdBy ??
      (task.source === "ASSET_TRANSFER" ? "Approved funding plan" : "Decision Center"),
    createdAt: new Date(task.createdAt).toLocaleDateString(),
    needLabel: task.category,
    context: taskContextView(task.context),
    inactiveReason,
  };
}

export type TaskCounts = Record<TaskStatus | "all", number>;

/**
 * Split persisted tasks into ACTIVE work (the only rows counted in the KPIs and
 * filter chips) and tasks that are no longer active work: steps a plan change
 * took off the approved plan, the replaced legacy records, and unfinished
 * tasks on archived transfers. Sample rows are never passed in here, so they
 * can never reach a count. A finished task on an archived transfer stays
 * active (counted as Done) and read-only.
 */
export function partitionPersistedTasks(views: PersistedTaskView[]): {
  active: PersistedTaskView[];
  inactive: PersistedTaskView[];
} {
  return {
    active: views.filter((view) => view.inactiveReason === null),
    inactive: views.filter((view) => view.inactiveReason !== null),
  };
}

export function countTasks(rows: { status: TaskStatus }[]): TaskCounts {
  const result: TaskCounts = { all: rows.length, todo: 0, in_progress: 0, blocked: 0, done: 0 };
  for (const row of rows) result[row.status] += 1;
  return result;
}
