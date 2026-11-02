import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";
import type { TaskRow } from "@/lib/data/workflow-types";

// ticket: honest Tasks counts, dev-only demo samples, permission-aware
// linked-record navigation and rows that are no longer active work
// (system-closed or on an archived transfer). Synthetic fixtures only.

const mocks = vi.hoisted(() => ({ samples: [] as unknown[] }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (read: () => unknown) => read(),
  useTransition: () => [false, (run: () => void) => run()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(authenticated)/(workflow)/decision-center/actions", () => ({ updateDecisionTask: vi.fn() }));
vi.mock("@/components/workflow", () => ({
  useTasks: () => mocks.samples, useDocs: () => ({ docs: {} }), useWorkflowActions: () => ({}),
  DocCard: () => null, StatusSelect: () => null, PrioritySelect: () => null,
  TASK_STATUS_LABEL: { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" },
}));

import Link from "next/link";
import { TasksWorkspace } from "@/components/tasks/TasksWorkspace";
import { TasksTable, type TasksTableRow } from "@/components/tasks/TasksTable";
import { ClosedTasks } from "@/components/tasks/ClosedTasks";
import { StatusFilter } from "@/components/tasks/StatusFilter";
import { TableEmptyState } from "@/components/tasks/TableEmptyState";
import { Kpi } from "@/components/ui";
import {
  countTasks,
  taskContextView,
  toPersistedTaskView,
  partitionPersistedTasks,
  type PersistedTaskView,
} from "@/components/tasks/tasks-model";
import {
  buildDecisionTaskContext,
  decisionTaskInactiveReason,
  type DecisionTaskContext,
} from "@/lib/data/decision-task-context";
import { tasksSampleRowsEnabled } from "@/lib/flags";

type El = ReactElement<Record<string, unknown>>;
function findAll(node: ReactNode, type: unknown, out: El[] = []): El[] {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) out.push(child as El);
    findAll(child.props.children, type, out);
  }
  return out;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<Record<string, unknown>>(child)) return "";
    const props = child.props;
    return [props.label, props.title, props.hint, props["aria-label"], text(props.children as ReactNode)]
      .filter((value) => typeof value === "string" && value.length > 0).join(" ");
  }).join(" ");
}

const TRANSFER = "synthetic-transfer";
const ACTIVE_CONTEXT: DecisionTaskContext = {
  transfer: { id: TRANSFER, visible: true, archived: false, fundingType: "ACAT_PARTIAL" },
  decision: null,
  inactiveReason: null,
};
function task(overrides: Partial<DecisionTaskRow> = {}): DecisionTaskRow {
  return {
    id: "synthetic-task", source: "ASSET_TRANSFER", decisionId: null, transferId: TRANSFER,
    parentTaskId: null, title: "Review the completed paperwork, then submit the partial ACAT",
    ownerTeam: "OPERATIONS", status: "TODO", priority: "HIGH", householdName: "Synthetic Household",
    category: "Asset transfer", createdBy: "synthetic@example.test", createdAt: "2026-09-26T12:00:00.000Z",
    context: ACTIVE_CONTEXT,
    ...overrides,
  };
}
function sample(id: string, status: TaskRow["status"]): TaskRow {
  return {
    id, desc: `Sample ${id}`, assignee: { kind: "group", label: "Operations" }, status, priority: "normal",
    createdBy: "Sample", createdAt: "today", decisionId: "sample-decision", itemId: "sample-item",
    householdName: "Sample Household",
  };
}
// TasksTable renders each linked record through a small LinkedRecord element;
// resolve those one level so assertions see the real <Link> / note output.
function linkedRecords(tree: ReactNode): El[] {
  const out: El[] = [];
  const walk = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<Record<string, unknown>>(child)) continue;
      if (child.props.view && typeof child.type === "function") {
        out.push((child.type as (props: unknown) => El)(child.props));
        continue;
      }
      walk(child.props.children as ReactNode);
    }
  };
  walk(tree);
  return out;
}
function hrefs(tree: ReactNode): unknown[] {
  return linkedRecords(tree).filter((el) => el.type === Link).map((el) => el.props.href);
}
function kpis(tree: ReactNode): Record<string, unknown> {
  return Object.fromEntries(findAll(tree, Kpi).map((kpi) => [kpi.props.label, kpi.props.value]));
}

afterEach(() => {
  mocks.samples = [];
  vi.unstubAllEnvs();
});

describe("Tasks counts come only from persisted, active tasks", () => {
  it("shows an honest empty state and zero totals when there is no real work, even with samples in the store", () => {
    mocks.samples = [sample("s1", "todo"), sample("s2", "done")];
    const tree = TasksWorkspace({ durableTasks: [], canWrite: true, role: "OPERATIONS" });
    expect(kpis(tree)).toEqual({ "Total tasks": 0, "To do": 0, "In progress": 0, Done: 0 });
    expect(findAll(tree, TasksTable)).toHaveLength(0);
    expect(findAll(tree, TableEmptyState)[0].props.title).toBe("No tasks yet");
    expect(text(tree)).not.toMatch(/sample rows|Demo sample workflow/i);
  });

  it("counts a mixed fixture without samples or system-closed rows, and keeps demo samples separate", () => {
    mocks.samples = [sample("s1", "todo"), sample("s2", "in_progress"), sample("s3", "done")];
    const durableTasks = [
      task({ id: "t-todo", status: "TODO" }),
      task({ id: "t-progress", status: "IN_PROGRESS" }),
      task({ id: "t-blocked", status: "BLOCKED" }),
      task({ id: "t-done", status: "DONE" }),
      task({ id: "t-route", status: "DONE", context: { ...ACTIVE_CONTEXT, inactiveReason: "ROUTE_CHANGED",
        transfer: { ...ACTIVE_CONTEXT.transfer!, fundingType: "WIRE" } } }),
      task({ id: "t-legacy", status: "DONE", source: "DECISION", decisionId: "legacy-decision", context: {
        transfer: ACTIVE_CONTEXT.transfer, inactiveReason: "REPLACED_LEGACY",
        decision: { id: "legacy-decision", visible: true, listed: false, status: "RESOLVED", resolutionSummary: null },
      } }),
    ];
    const tree = TasksWorkspace({ durableTasks, canWrite: true, role: "OPERATIONS", sampleRowsEnabled: true });
    expect(kpis(tree)).toEqual({ "Total tasks": 4, "To do": 1, "In progress": 1, Done: 1 });
    expect(findAll(tree, StatusFilter)[0].props.counts).toEqual({ all: 4, todo: 1, in_progress: 1, blocked: 1, done: 1 });

    const [saved, demo] = findAll(tree, TasksTable);
    expect((saved.props.rows as TasksTableRow[]).map((row) => row.persistentId))
      .toEqual(["t-todo", "t-progress", "t-blocked", "t-done"]);
    expect(saved.props.variant).toBeUndefined();
    expect(demo.props.variant).toBe("sample");
    expect((demo.props.rows as TasksTableRow[]).every((row) => row.isSample && !row.persistentId)).toBe(true);
    expect(text(tree)).toContain("Demo sample workflow (dev only)");
    expect(text(tree)).not.toContain("Live tasks + sample rows");

    const closed = findAll(tree, ClosedTasks)[0].props.rows as { persistentId: string; status: string }[];
    expect(closed.map((row) => [row.persistentId, row.status])).toEqual([["t-route", "done"], ["t-legacy", "done"]]);
  });

  it("never renders sample rows while the demo switch is off", () => {
    mocks.samples = [sample("s1", "todo")];
    const tree = TasksWorkspace({ durableTasks: [task()], canWrite: true, role: "OPERATIONS" });
    const tables = findAll(tree, TasksTable);
    expect(tables).toHaveLength(1);
    expect((tables[0].props.rows as TasksTableRow[]).some((row) => row.isSample)).toBe(false);
    expect(kpis(tree)["Total tasks"]).toBe(1);
  });

  it("counts every status bucket", () => {
    expect(countTasks([{ status: "todo" }, { status: "todo" }, { status: "blocked" }, { status: "done" }]))
      .toEqual({ all: 4, todo: 2, in_progress: 0, blocked: 1, done: 1 });
  });
});

describe("linked-record navigation", () => {
  it("describes a recorded decision in place and links the transfer only when the viewer's scope resolved it", () => {
    const view = taskContextView({
      transfer: { id: TRANSFER, visible: true, archived: false, fundingType: "ACAT_PARTIAL" },
      decision: { id: "case/1", visible: true, listed: true, status: "RESOLVED", resolutionSummary: "Retain at contra." },
      inactiveReason: null,
    });
    expect(view).toEqual({
      decision: { kind: "note", label: "Decision recorded" },
      transfer: { kind: "link", label: "View transfer →", href: `/asset-transfer/${TRANSFER}` },
      transferArchived: false,
      resolution: "Retain at contra.",
    });
  });

  it("shows plain messages, never a link, for unavailable, hidden or legacy records", () => {
    const view = taskContextView({
      transfer: { id: TRANSFER, visible: false, archived: false, fundingType: null },
      decision: { id: "hidden", visible: false, listed: false, status: null, resolutionSummary: null },
      inactiveReason: null,
    });
    expect(view.decision).toEqual({ kind: "note", label: "Linked decision unavailable" });
    expect(view.transfer).toEqual({ kind: "note", label: "Linked transfer unavailable" });
    const legacy = taskContextView({
      transfer: null,
      decision: { id: "legacy", visible: true, listed: false, status: "RESOLVED", resolutionSummary: "Old." },
      inactiveReason: null,
    });
    expect(legacy.decision).toEqual({ kind: "note", label: "Older decision record, not shown in Decision Center" });
    expect(legacy.transfer).toBeNull();
    // A row without verified context gets no links at all.
    expect(taskContextView(undefined)).toEqual({ decision: null, transfer: null, transferArchived: false, resolution: null });
  });

  it("renders Link elements only for resolvable targets, and labels archived transfers read-only", () => {
    const rows = [
      toPersistedTaskView(task({ id: "linked", source: "DECISION", decisionId: "case-1", context: {
        ...ACTIVE_CONTEXT,
        decision: { id: "case-1", visible: true, listed: true, status: "OPEN", resolutionSummary: null },
      } }), "OPERATIONS"),
      toPersistedTaskView(task({ id: "missing", context: {
        ...ACTIVE_CONTEXT, transfer: { id: TRANSFER, visible: false, archived: false, fundingType: null },
      } }), "OPERATIONS"),
      // A FINISHED task on an archived transfer stays in the table (it is real,
      // done work) but read-only. Unfinished ones leave it; see below.
      toPersistedTaskView(task({ id: "archived", status: "DONE", context: {
        ...ACTIVE_CONTEXT, transfer: { ...ACTIVE_CONTEXT.transfer!, archived: true },
      } }), "OPERATIONS"),
    ];
    expect(rows.map((row) => row.canUpdate)).toEqual([true, true, false]);
    expect(rows[2].readOnlyReason).toBe("Read-only: the transfer is archived");
    const tree = TasksTable({ rows, canWrite: true });
    expect(hrefs(tree)).toEqual([
      `/asset-transfer/${TRANSFER}`, `/asset-transfer/${TRANSFER}`,
    ]);
    expect(hrefs(tree).join(" ")).not.toContain("/decision-center");
    expect(linkedRecords(tree).map((el) => text(el.props.children as ReactNode))).toContain("Linked transfer unavailable");
    expect(text(tree)).toContain("Transfer archived");
  });

  it("keeps VIEWER rows read-only through canWrite while still offering read links", () => {
    const tree = TasksWorkspace({ durableTasks: [task()], canWrite: false, role: "VIEWER" });
    const table = findAll(tree, TasksTable)[0];
    expect(table.props.canWrite).toBe(false);
    expect(hrefs(TasksTable({ rows: table.props.rows as TasksTableRow[], canWrite: false }))).toEqual([`/asset-transfer/${TRANSFER}`]);
  });
});

describe("system-closed tasks are derived, never stored", () => {
  const base = { decisionId: null, transferId: TRANSFER, taskKey: "track-partial-acat", status: "DONE",
    sourceKey: `asset-transfer:${TRANSFER}:standard-partial-acat:track-partial-acat`, decisionSourceKey: undefined,
    decisionResolutionCode: undefined, transferArchived: false };

  it("marks a standard partial-ACAT step inactive only for a known, different approved route", () => {
    expect(decisionTaskInactiveReason({ ...base, transferFundingType: "WIRE" })).toBe("ROUTE_CHANGED");
    expect(decisionTaskInactiveReason({ ...base, transferFundingType: "DRS" })).toBe("ROUTE_CHANGED");
    expect(decisionTaskInactiveReason({ ...base, transferFundingType: "ACAT_PARTIAL" })).toBeNull();
    expect(decisionTaskInactiveReason({ ...base, transferFundingType: null })).toBeNull();
    expect(decisionTaskInactiveReason({ ...base, transferFundingType: undefined })).toBeNull();
    expect(decisionTaskInactiveReason({ ...base, sourceKey: "asset-transfer:other:standard-partial-acat:x",
      transferFundingType: "WIRE" })).toBeNull();
  });

  it("marks only the legacy excluded-positions task as replaced, not other work on the hidden decision", () => {
    const legacy = { decisionId: "legacy", transferId: TRANSFER, sourceKey: null, transferFundingType: "ACAT_PARTIAL",
      decisionSourceKey: `asset-transfer:${TRANSFER}:excluded-positions`, decisionResolutionCode: "STANDARD_PARTIAL_ACAT",
      status: "DONE", transferArchived: false };
    expect(decisionTaskInactiveReason({ ...legacy, taskKey: "resolve-excluded-positions" })).toBe("REPLACED_LEGACY");
    expect(decisionTaskInactiveReason({ ...legacy, taskKey: "execute-resolution" })).toBeNull();
    expect(decisionTaskInactiveReason({ ...legacy, taskKey: "resolve-excluded-positions",
      decisionSourceKey: `manual:${TRANSFER}` })).toBeNull();
  });

  it("keeps a legacy excluded-positions task a person resolved as ordinary done work", () => {
    const legacy = { decisionId: "legacy", transferId: TRANSFER, sourceKey: null, transferFundingType: "ACAT_PARTIAL",
      decisionSourceKey: `asset-transfer:${TRANSFER}:excluded-positions`, taskKey: "resolve-excluded-positions",
      status: "DONE", transferArchived: false };
    // Only the backfill writes STANDARD_PARTIAL_ACAT; anything else was a person's (or the old code's) resolution.
    for (const code of ["RETAIN_AT_CONTRA", "GENERAL_APPROVED", "NO_EXCLUDED_POSITIONS", null]) {
      expect(decisionTaskInactiveReason({ ...legacy, decisionResolutionCode: code })).toBeNull();
    }
    // An unreadable decision never hides a task.
    expect(decisionTaskInactiveReason({ ...legacy, decisionResolutionCode: undefined })).toBeNull();
  });

  it("builds context from RLS-resolved relations without inventing links", () => {
    expect(buildDecisionTaskContext({ ...base, transfer: null, decision: undefined })).toEqual({
      transfer: { id: TRANSFER, visible: false, archived: false, fundingType: null },
      decision: null,
      inactiveReason: null,
    });
    const context = buildDecisionTaskContext({
      decisionId: "legacy", transferId: TRANSFER, sourceKey: null, taskKey: "resolve-excluded-positions", status: "DONE",
      transfer: { archived_at: new Date("2026-09-20T00:00:00Z"), funding_type: "ACAT_PARTIAL" },
      decision: { source_key: `asset-transfer:${TRANSFER}:excluded-positions`, status: "RESOLVED",
        resolution_code: "STANDARD_PARTIAL_ACAT", resolution_summary: "Old." },
    });
    expect(context).toEqual({
      transfer: { id: TRANSFER, visible: true, archived: true, fundingType: "ACAT_PARTIAL" },
      decision: { id: "legacy", visible: true, listed: false, status: "RESOLVED", resolutionSummary: "Old." },
      inactiveReason: "REPLACED_LEGACY",
    });
    const personResolved = buildDecisionTaskContext({
      decisionId: "legacy", transferId: TRANSFER, sourceKey: null, taskKey: "resolve-excluded-positions", status: "DONE",
      transfer: { archived_at: null, funding_type: "ACAT_PARTIAL" },
      decision: { source_key: `asset-transfer:${TRANSFER}:excluded-positions`, status: "RESOLVED",
        resolution_code: "RETAIN_AT_CONTRA", resolution_summary: "Kept at the old firm." },
    });
    expect(personResolved).toMatchObject({ decision: { listed: false }, inactiveReason: null });
  });

  it("keeps the stored status on closed rows and makes them read-only", () => {
    const view = toPersistedTaskView(task({ status: "DONE", context: { ...ACTIVE_CONTEXT, inactiveReason: "ROUTE_CHANGED" } }), "ADMIN");
    expect(view).toMatchObject({ status: "done", canUpdate: false, inactiveReason: "ROUTE_CHANGED" });
    expect(partitionPersistedTasks([view]).active).toEqual([]);
  });

  it("keeps the DRS edit guard from ticket unchanged", () => {
    const drs = { key: "apex-submitted" as const, updatedAt: "2026-09-25T12:01:00.000Z", fundingPlanVersion: 7,
      stage: "DECISION", fundingPlanComplete: true, archived: false };
    expect(toPersistedTaskView(task({ drs, context: undefined }), "OPERATIONS").canUpdate).toBe(true);
    expect(toPersistedTaskView(task({ drs, context: undefined, ownerTeam: "OPERATIONS" }), "CLIENT_SERVICE").canUpdate).toBe(false);
    expect(toPersistedTaskView(task({ drs: { ...drs, fundingPlanVersion: 0 }, context: undefined }), "OPERATIONS").canUpdate).toBe(false);
  });
});

describe("archived transfers cannot strand open work in the totals", () => {
  const ARCHIVED = "synthetic-archived-transfer";
  const archivedAt = new Date("2026-09-20T12:00:00Z");
  // Rows shaped exactly as listDecisionTasks builds them: context comes from
  // buildDecisionTaskContext over the RLS-resolved transfer, not a hand-set reason.
  function saved(id: string, status: DecisionTaskRow["status"], transferId: string, archived: boolean,
    extra: Partial<DecisionTaskRow> = {}): DecisionTaskRow {
    const sourceKey = `asset-transfer:${transferId}:standard-partial-acat:${id}`;
    return task({ id, status, transferId, ...extra, context: buildDecisionTaskContext({
      decisionId: null, transferId, sourceKey, taskKey: id, status,
      transfer: { archived_at: archived ? archivedAt : null, funding_type: "ACAT_PARTIAL" }, decision: undefined,
    }) });
  }

  it("derives TRANSFER_ARCHIVED only for unfinished tasks on a readable archived transfer", () => {
    const rule = { decisionId: null, transferId: ARCHIVED, sourceKey: null, taskKey: "execute-resolution",
      transferFundingType: "ACAT_PARTIAL", decisionSourceKey: undefined, decisionResolutionCode: undefined };
    for (const status of ["TODO", "IN_PROGRESS", "BLOCKED"]) {
      expect(decisionTaskInactiveReason({ ...rule, status, transferArchived: true })).toBe("TRANSFER_ARCHIVED");
    }
    expect(decisionTaskInactiveReason({ ...rule, status: "DONE", transferArchived: true })).toBeNull();
    expect(decisionTaskInactiveReason({ ...rule, status: "TODO", transferArchived: false })).toBeNull();
    // An unreadable transfer never hides a task.
    expect(decisionTaskInactiveReason({ ...rule, status: "TODO", transferArchived: undefined,
      transferFundingType: undefined })).toBeNull();
    expect(decisionTaskInactiveReason({ ...rule, transferId: null, status: "TODO", transferArchived: true })).toBeNull();
  });

  it("keeps a transfer's open tasks out of every count once it is archived, without changing their status", () => {
    // Typical case: a partial-ACAT plan was approved (three TODO steps), one
    // step was finished, then the deal was lost and the transfer sync archived it.
    const drs = { key: "apex-submitted" as const, updatedAt: "2026-09-25T12:01:00.000Z", fundingPlanVersion: 3,
      stage: "DECISION", fundingPlanComplete: true, archived: true };
    const durableTasks = [
      saved("live-todo", "TODO", TRANSFER, false),
      saved("arch-todo", "TODO", ARCHIVED, true),
      saved("arch-progress", "IN_PROGRESS", ARCHIVED, true),
      saved("arch-blocked", "BLOCKED", ARCHIVED, true),
      saved("arch-done", "DONE", ARCHIVED, true),
      saved("arch-drs", "TODO", ARCHIVED, true, { drs }),
    ];
    const tree = TasksWorkspace({ durableTasks, canWrite: true, role: "OPERATIONS" });

    expect(kpis(tree)).toEqual({ "Total tasks": 2, "To do": 1, "In progress": 0, Done: 1 });
    expect(findAll(tree, StatusFilter)[0].props.counts).toEqual({ all: 2, todo: 1, in_progress: 0, blocked: 0, done: 1 });

    const table = findAll(tree, TasksTable)[0].props.rows as TasksTableRow[];
    expect(table.map((row) => [row.persistentId, row.canUpdate, row.readOnlyReason])).toEqual([
      ["live-todo", true, null],
      ["arch-done", false, "Read-only: the transfer is archived"],
    ]);

    const inactive = findAll(tree, ClosedTasks)[0].props.rows as PersistedTaskView[];
    expect(inactive.map((row) => [row.persistentId, row.status, row.inactiveReason])).toEqual([
      ["arch-todo", "todo", "TRANSFER_ARCHIVED"],
      ["arch-progress", "in_progress", "TRANSFER_ARCHIVED"],
      ["arch-blocked", "blocked", "TRANSFER_ARCHIVED"],
      ["arch-drs", "todo", "TRANSFER_ARCHIVED"],
    ]);
    // The stored status on the input rows is untouched.
    expect(durableTasks.map((row) => row.status)).toEqual(["TODO", "TODO", "IN_PROGRESS", "BLOCKED", "DONE", "TODO"]);

    const list = text(ClosedTasks({ rows: inactive }));
    expect(list).toMatch(/No longer active ·\s+4/);
    expect(list).toContain("Transfer archived");
    expect(list).toMatch(/Saved status:\s+To do/);
    expect(list).toContain("Not counted in the totals above.");
  });

  it("archiving more transfers never raises the open-work totals", () => {
    const before = TasksWorkspace({ durableTasks: [saved("a", "TODO", TRANSFER, false)], canWrite: true, role: "OPERATIONS" });
    const after = TasksWorkspace({ durableTasks: [
      saved("a", "TODO", TRANSFER, false),
      ...Array.from({ length: 5 }, (_, index) => saved(`gone-${index}`, "TODO", `${ARCHIVED}-${index}`, true)),
    ], canWrite: true, role: "OPERATIONS" });
    expect(kpis(after)).toEqual(kpis(before));
  });
});

describe("tasksSampleRowsEnabled", () => {
  it("is on only in dev with the exact switch", () => {
    vi.stubEnv("APP_ENV", "dev");
    vi.stubEnv("TASKS_SAMPLE_ROWS", "1");
    expect(tasksSampleRowsEnabled()).toBe(true);
  });

  it("fails closed outside dev and for every non-exact value", () => {
    vi.stubEnv("TASKS_SAMPLE_ROWS", "1");
    for (const environment of ["", "local", "prod", "production", "staging"]) {
      vi.stubEnv("APP_ENV", environment);
      expect(tasksSampleRowsEnabled()).toBe(false);
    }
    vi.stubEnv("APP_ENV", "dev");
    for (const value of ["", "0", "true", "yes", "on"]) {
      vi.stubEnv("TASKS_SAMPLE_ROWS", value);
      expect(tasksSampleRowsEnabled()).toBe(false);
    }
  });
});
