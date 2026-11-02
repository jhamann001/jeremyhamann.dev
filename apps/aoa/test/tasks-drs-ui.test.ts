import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";

const mocks = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (read: () => unknown) => read(),
  useTransition: () => [false, (run: () => void) => run()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(authenticated)/(workflow)/decision-center/actions", () => ({ updateDecisionTask: mocks.update }));
vi.mock("@/components/workflow", () => ({
  useTasks: () => [], useDocs: () => ({ docs: {} }), useWorkflowActions: () => ({}),
  DocCard: () => null, StatusSelect: () => null, PrioritySelect: () => null,
  TASK_STATUS_LABEL: { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" },
}));

import { TasksWorkspace } from "@/components/tasks/TasksWorkspace";
import { TasksTable, type TasksTableRow } from "@/components/tasks/TasksTable";
import { StatusSelect, PrioritySelect } from "@/components/workflow";

function fixture(): DecisionTaskRow {
  return {
    id: "synthetic-drs-task", source: "ASSET_TRANSFER", decisionId: null,
    transferId: "synthetic-transfer", parentTaskId: null, title: "Submit the DRS request to Apex",
    ownerTeam: "OPERATIONS", status: "TODO", priority: "HIGH", householdName: "Synthetic Household",
    category: "DRS transfer", createdBy: null, createdAt: "2026-09-25T12:00:00.000Z",
    drs: { key: "apex-submitted", updatedAt: "2026-09-25T12:01:00.000Z", fundingPlanVersion: 7,
      stage: "DECISION", fundingPlanComplete: true, archived: false },
  };
}
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<Record<string, unknown>>;
    const found = find(child.props.children, type);
    if (found) return found;
  }
  return null;
}
function rows(task = fixture(), role = "OPERATIONS") {
  const tree = TasksWorkspace({ durableTasks: [task], canWrite: true, role });
  return find(tree, TasksTable)!.props.rows as TasksTableRow[];
}

describe("DRS tasks in the shared Tasks workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({ ok: true });
  });

  it("carries the current task timestamp and funding-plan revision into the persistent row", () => {
    const [row] = rows();
    expect(row.drs).toEqual(fixture().drs);
    expect(row.canUpdate).toBe(true);
  });

  it.each([
    { role: "CLIENT_SERVICE", ownerTeam: "OPERATIONS", allowed: false },
    { role: "CLIENT_SERVICE", ownerTeam: "CLIENT_SERVICE", allowed: true },
    { role: "ADVISOR", ownerTeam: "CLIENT_SERVICE", allowed: false },
    { role: "OPERATIONS", ownerTeam: "CLIENT_SERVICE", allowed: true },
  ] as const)("limits $role edits on $ownerTeam tasks", ({ role, ownerTeam, allowed }) => {
    expect(rows({ ...fixture(), ownerTeam }, role)[0].canUpdate).toBe(allowed);
  });

  it.each([
    { archived: true }, { fundingPlanComplete: false }, { fundingPlanVersion: 0 },
  ])("disables DRS task edits without an active approval (%o)", (override) => {
    const task = fixture();
    task.drs = { ...task.drs!, ...override };
    const tableRows = rows(task);
    expect(tableRows[0].canUpdate).toBe(false);
    const tree = TasksTable({ rows: tableRows, canWrite: true });
    expect(find(tree, StatusSelect)!.props.disabled).toBe(true);
    expect(find(tree, PrioritySelect)!.props.disabled).toBe(true);
  });

  it("passes stale-write tokens on a status change from the shared Tasks table", async () => {
    const tree = TasksTable({ rows: rows(), canWrite: true });
    const onChange = find(tree, StatusSelect)!.props.onChange as (status: string) => void;
    onChange("done");
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      taskId: "synthetic-drs-task", status: "DONE", priority: "HIGH",
      expectedUpdatedAt: "2026-09-25T12:01:00.000Z", expectedFundingPlanVersion: 7,
    }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("preserves the existing payload for non-DRS tasks", async () => {
    const task = fixture();
    delete task.drs;
    const tree = TasksTable({ rows: rows(task), canWrite: true });
    const onChange = find(tree, PrioritySelect)!.props.onChange as (priority: string) => void;
    onChange("normal");
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      taskId: "synthetic-drs-task", status: "TODO", priority: "NORMAL",
    }));
  });
});
