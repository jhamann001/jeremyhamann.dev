import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";
import type { TaskTransferSummary } from "@/lib/data/task-transfer-summary";

const mocks = vi.hoisted(() => ({ status: "all", view: "grouped", update: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial === "all" ? mocks.status : initial === "grouped" ? mocks.view : initial, vi.fn()],
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

import { StatusSelect, PrioritySelect } from "@/components/workflow";
import { TasksWorkspace } from "@/components/tasks/TasksWorkspace";
import { TasksTable } from "@/components/tasks/TasksTable";
import { groupTasks, transferAccountLabel } from "@/components/tasks/grouped-tasks-model";
import { toPersistedTaskView } from "@/components/tasks/tasks-model";

const KEYS = ["prepare-wet-signature-paperwork", "review-submit-partial-acat", "track-partial-acat"];
function summary(id = "transfer-roth", overrides: Partial<TaskTransferSummary> = {}): TaskTransferSummary {
  return {
    id, clientKey: "client:synthetic-client", clientName: "Synthetic Client", householdName: "Synthetic Household",
    accountType: "Roth IRA", deliveringCustodian: "Synthetic Custodian", deliveringAccountLast4: "1234",
    fundingType: "ACAT_PARTIAL", stage: "DECISION", createdAt: "2026-09-28T12:00:00Z",
    deal: { id: `deal-${id}`, name: "Synthetic transfer deal" }, requirements: ["Approve the current funding plan."],
    blockers: [], readinessNote: "Open the transfer to review full readiness; completing these tasks does not advance the transfer.",
    ...overrides,
  };
}
function task(id: string, transferSummary: TaskTransferSummary | null = summary(), overrides: Partial<DecisionTaskRow> = {}): DecisionTaskRow {
  return {
    id, source: "ASSET_TRANSFER", decisionId: null, transferId: transferSummary?.id ?? null, parentTaskId: null,
    taskKey: KEYS[0], sortOrder: 20, title: `Synthetic task ${id}`, ownerTeam: "CLIENT_SERVICE", status: "TODO", priority: "HIGH",
    householdName: "Synthetic Household", category: "Asset transfer", createdBy: null, createdAt: "2026-09-28T12:00:00Z",
    transferSummary,
    context: { decision: null, transfer: transferSummary ? { id: transferSummary.id, visible: true, archived: false, fundingType: transferSummary.fundingType } : null, inactiveReason: null },
    ...overrides,
  };
}
function views(rows: DecisionTaskRow[], role = "OPERATIONS") { return rows.map((row) => toPersistedTaskView(row, role)); }
function markup(durableTasks: DecisionTaskRow[], canWrite = true, role = "OPERATIONS") {
  return renderToStaticMarkup(createElement(TasksWorkspace, { durableTasks, canWrite, role }));
}
function findAll(node: ReactNode, type: unknown, found: ReactElement<Record<string, unknown>>[] = []) {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) found.push(child as ReactElement<Record<string, unknown>>);
    findAll(child.props.children, type, found);
  }
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = "all";
  mocks.view = "grouped";
  mocks.update.mockResolvedValue({ ok: true });
});

describe("client and transfer identity", () => {
  it("keeps Roth, traditional, and two transfers with the same registration separate for one client", () => {
    const { clients } = groupTasks(views([
      task("roth", summary("roth")),
      task("traditional", summary("traditional", { accountType: "Traditional IRA", deliveringAccountLast4: "2345" })),
      task("roth-second", summary("roth-second", { deliveringAccountLast4: "3456" })),
    ]));
    expect(clients).toHaveLength(1);
    expect(clients[0].transfers.map((group) => group.summary.id)).toEqual(["roth", "roth-second", "traditional"]);
    expect(clients[0].transfers.map((group) => group.counts.all)).toEqual([1, 1, 1]);
  });

  it("never merges different clients just because their names match", () => {
    const { clients } = groupTasks(views([
      task("one", summary("one", { clientKey: "client:one" })),
      task("two", summary("two", { clientKey: "client:two" })),
    ]));
    expect(clients.map((client) => client.key)).toEqual(["client:one", "client:two"]);
  });

  it("keeps missing summaries or stable identities in other tasks and offers no invented source links", () => {
    const rows = [task("missing", null), task("no-client", summary("no-client", { clientKey: "" }))];
    const grouped = groupTasks(views(rows));
    expect(grouped.clients).toEqual([]);
    expect(grouped.other.map((row) => row.persistentId)).toEqual(["missing", "no-client"]);
    const html = markup([rows[0]], false);
    expect(html).toContain("Other saved tasks");
    expect(html).not.toContain("/asset-transfer/");
    expect(html).not.toContain("/deals/");
  });

  it("shows registration, custodian, masked account, unique reference and the exact encoded deal", () => {
    const html = markup([task("one", summary("unique-transfer", {
      deal: { id: "exact/deal", name: "Exact linked deal" },
    }))], false);
    expect(html).toContain("Roth IRA");
    expect(html).toContain("Synthetic Custodian");
    expect(html).toContain("Account ••••1234");
    expect(html).toContain("Transfer reference: unique-transfer");
    expect(html).toContain('href="/deals/exact%2Fdeal"');
    expect(html).toContain('href="/asset-transfer/unique-transfer"');
    expect(html).toContain("Exact linked deal");
    expect(transferAccountLabel(summary("one", { deliveringAccountLast4: "123456789" }))).toBe("Account unavailable");
  });

  it("labels missing registration and deal without guessing from the client", () => {
    const html = markup([task("one", summary("one", {
      accountType: null, deliveringCustodian: null, deliveringAccountLast4: null, deal: null,
    }))], false);
    expect(html).toContain("Registration unavailable");
    expect(html).toContain("Custodian unavailable");
    expect(html).toContain("Account unavailable");
    expect(html).toContain("Linked deal unavailable");
    expect(html).not.toContain("/deals/");
  });

  it("rejects a summary for an unreadable or different transfer", () => {
    const hidden = task("hidden", summary(), { context: {
      transfer: { id: "transfer-roth", visible: false, archived: false, fundingType: null }, decision: null, inactiveReason: null,
    } });
    const mismatched = task("mismatch", summary(), { transferId: "different-transfer" });
    expect(views([hidden, mismatched]).every((row) => row.transferSummary === null)).toBe(true);
    const html = markup([hidden]);
    expect(html).toContain("Linked transfer unavailable");
    expect(html).not.toContain("/deals/");
    expect(html).not.toContain("/asset-transfer/");
  });
});

describe("stable client and transfer order", () => {
  const order = (rows: DecisionTaskRow[], status: "all" | "todo" = "all") =>
    groupTasks(views(rows), status).clients.map((client) => ({
      key: client.key, transfers: client.transfers.map((transfer) => transfer.summary.id),
    }));
  function rows() {
    return [
      task("z-task", summary("z-transfer", { clientKey: "client:z", clientName: "Zoe" })),
      task("new-task", summary("a-new", { createdAt: "2026-09-28T13:00:00Z" })),
      task("old-task", summary("z-old", { createdAt: "2026-09-27T12:00:00Z" })),
      task("alpha-task", summary("alpha-transfer", { clientKey: "client:a", clientName: "alex" })),
    ];
  }

  it("orders clients alphabetically and transfers oldest first regardless of incoming task order", () => {
    const original = rows();
    const expected = [
      { key: "client:a", transfers: ["alpha-transfer"] },
      { key: "client:synthetic-client", transfers: ["z-old", "a-new"] },
      { key: "client:z", transfers: ["z-transfer"] },
    ];
    for (let index = 0; index < original.length; index++) {
      const rotated = [...original.slice(index), ...original.slice(0, index)];
      expect(order(rotated)).toEqual(expected);
      expect(order(rotated.toReversed())).toEqual(expected);
    }
  });

  it("ignores task status, priority, task creation time and transfer stage when positioning cards", () => {
    const original = rows();
    const changed: DecisionTaskRow[] = original.toReversed().map((row) => ({ ...row,
      status: "DONE", priority: "LOW", createdAt: "2026-09-29T12:00:00Z",
      transferSummary: { ...row.transferSummary!, stage: "IN_TRANSFER" },
    }));
    changed.unshift(task("new-exception", original[2].transferSummary, {
      source: "DECISION", taskKey: "exception", createdAt: "2026-09-30T12:00:00Z",
    }));
    expect(order(changed)).toEqual(order(original));
  });

  it("breaks equal timestamps and case-insensitive client name ties with stable IDs", () => {
    const tied = [
      task("three", summary("b", { clientKey: "client:2", clientName: "Alex" })),
      task("two", summary("b", { clientKey: "client:1", clientName: "alex" })),
      task("one", summary("a", { clientKey: "client:1", clientName: "alex" })),
    ];
    const expected = [{ key: "client:1", transfers: ["a", "b"] }, { key: "client:2", transfers: ["b"] }];
    expect(order(tied)).toEqual(expected);
    expect(order(tied.toReversed())).toEqual(expected);
  });

  it("filters without changing the remaining cards' relative order and appends newer transfers", () => {
    const original = rows();
    original[2].status = "DONE";
    expect(order(original, "todo")).toEqual(order(original.filter((row) => row.status !== "DONE")));
    const withNew = [task("newest", summary("0-newest", { createdAt: "2026-10-01T12:00:00Z" })), ...original];
    expect(order(withNew)[1].transfers).toEqual(["z-old", "a-new", "0-newest"]);
  });

  it("puts unavailable creation dates last with a deterministic ID tie-break", () => {
    const mixed = [
      task("missing-b", summary("b", { createdAt: "" })),
      task("valid", summary("valid")),
      task("missing-a", summary("a", { createdAt: "invalid" })),
    ];
    expect(order(mixed)[0].transfers).toEqual(["valid", "a", "b"]);
    expect(order(mixed.toReversed())).toEqual(order(mixed));
  });

  it("uses a stable client heading when transfers have different recorded names, even when filtered", () => {
    const differing = [
      task("old", summary("old", { clientName: "Tom Delgado", createdAt: "2026-09-27T12:00:00Z" }), { status: "DONE" }),
      task("new", summary("new", { clientName: "Z Smith" })),
      task("other", summary("other", { clientKey: "client:other", clientName: "Zoe" })),
    ];
    for (const permutation of [differing, differing.toReversed()]) {
      for (const filter of ["all", "todo"] as const) {
        const clients = groupTasks(views(permutation), filter).clients;
        expect(clients.map((client) => client.name)).toEqual(["Tom Delgado", "Zoe"]);
        expect(clients[0].key).toBe("client:synthetic-client");
      }
    }
  });
});

describe("workflow sequence and complete filtered context", () => {
  function sequence() {
    return [
      task("tracking", summary(), { taskKey: KEYS[2], sortOrder: 40 }),
      task("paperwork", summary(), { taskKey: KEYS[0], sortOrder: 20, status: "DONE" }),
      task("submit", summary(), { taskKey: KEYS[1], sortOrder: 30, status: "IN_PROGRESS" }),
    ];
  }
  it("numbers recognized steps in workflow order and identifies the next unfinished step", () => {
    const group = groupTasks(views(sequence())).clients[0].transfers[0];
    expect(group.workflow.map((row) => [row.persistentId, row.step?.number])).toEqual([["paperwork", 1], ["submit", 2], ["tracking", 3]]);
    expect(group.nextStep?.persistentId).toBe("submit");
    expect(group.workflow[1].step?.guidance).toContain("After step 1");
    expect(group.workflow[2].step?.guidance).toContain("After step 2");
    expect(group.workflow.every((row) => row.canUpdate)).toBe(true);
  });

  it("retains done and current steps, original numbering, and full progress under a TODO filter", () => {
    const unrelated = task("unrelated", summary("unrelated"), { status: "DONE" });
    const group = groupTasks(views([...sequence(), unrelated]), "todo").clients[0].transfers[0];
    expect(group.rows).toHaveLength(3);
    expect(group.counts).toEqual({ all: 3, done: 1, in_progress: 1, todo: 1, blocked: 0 });
    expect(group.matchingCount).toBe(1);
    expect(group.nextStep?.persistentId).toBe("submit");
    expect(group.workflow.map((row) => row.filterContext)).toEqual([true, true, false]);
    mocks.status = "todo";
    const html = markup([...sequence(), unrelated]);
    expect(html).toContain("1 of 3 saved tasks done");
    expect(html).toContain("1 match the filter · 2 shown for context");
    expect(html).toContain("Current step 2:");
    expect(html.match(/outside the selected status filter/g)).toHaveLength(2);
    expect(html).not.toContain("Transfer reference: unrelated");
  });

  it("keeps exception/unknown/manual work separate and preserves resolution and decision links", () => {
    const exception = task("exception", summary(), { source: "DECISION", taskKey: KEYS[0], decisionId: "case/one", context: {
      transfer: { id: "transfer-roth", visible: true, archived: false, fundingType: "ACAT_PARTIAL" }, inactiveReason: null,
      decision: { id: "case/one", visible: true, listed: true, status: "RESOLVED", resolutionSummary: "Retain the restricted position." },
    } });
    const unknown = task("manual", summary(), { taskKey: "manual-review", sortOrder: 1 });
    const group = groupTasks(views([...sequence(), exception, unknown])).clients[0].transfers[0];
    expect(group.workflow).toHaveLength(3);
    expect(group.other.map((row) => row.persistentId)).toEqual(["manual", "exception"]);
    const html = markup([...sequence(), exception, unknown]);
    expect(html).toContain("Exceptions and other tasks");
    expect(html).toContain("Approved resolution: Retain the restricted position.");
    expect(html).not.toContain("/decision-center");
  });

  it("shows requirements and exact blocking decisions while preserving the readiness caveat", () => {
    const html = markup([task("one", summary("one", {
      blockers: [{ id: "blocking/one", question: "Confirm the registration mismatch." }],
    }))]);
    expect(html).toContain("Approve the current funding plan.");
    expect(html).toContain("Confirm the registration mismatch.");
    expect(html).not.toContain("/decision-center");
    expect(html).toContain("completing these tasks does not advance the transfer.");
  });

  it("offers the flat view with the same account and exact deal distinctions", () => {
    mocks.view = "flat";
    const html = markup([task("one", summary("flat-transfer"))]);
    expect(html).toContain('aria-pressed="true">Flat list');
    expect(html).toContain("Roth IRA");
    expect(html).toContain("Account ••••1234");
    expect(html).toContain("Transfer reference: flat-transfer");
    expect(html).toContain('href="/deals/deal-flat-transfer"');
  });
});

describe("DRS checklist controls", () => {
  function drs(overrides: Partial<DecisionTaskRow> = {}) {
    return task("drs", summary("drs-transfer", { fundingType: "DRS" }), {
      taskKey: "drs-apex-submitted", sortOrder: 4, ownerTeam: "OPERATIONS",
      drs: { key: "apex-submitted", updatedAt: "2026-09-28T12:01:00Z", fundingPlanVersion: 7,
        stage: "DECISION", fundingPlanComplete: true, archived: false }, ...overrides,
    });
  }
  it("uses DRS phase guidance without an invented predecessor lock", () => {
    const rows = [drs(), drs({ id: "paperwork", taskKey: "drs-paperwork", ownerTeam: "CLIENT_SERVICE", sortOrder: 0 })];
    const group = groupTasks(views(rows)).clients[0].transfers[0];
    expect(group.workflow.map((row) => row.step?.number)).toEqual([1, 5]);
    expect(group.workflow.every((row) => row.canUpdate && row.step?.guidance === null)).toBe(true);
    expect(group.parallel).toBe(true);
    const html = markup(rows);
    expect(html).toContain("Tasks in the same phase can run in parallel");
  });

  it("preserves role/read-only guards in the checklist controls", () => {
    const rows = groupTasks(views([drs()], "CLIENT_SERVICE")).clients[0].transfers[0].workflow;
    const html = TasksTable({ rows, canWrite: true, layout: "checklist" });
    expect(findAll(html, StatusSelect)[0].props.disabled).toBe(true);
    expect(findAll(html, PrioritySelect)[0].props.disabled).toBe(true);
    const viewer = TasksTable({ rows: groupTasks(views([drs()])).clients[0].transfers[0].workflow, canWrite: false, layout: "checklist" });
    expect(findAll(viewer, StatusSelect)[0].props.disabled).toBe(true);
  });

  it("carries stale-write tokens on checklist status and priority updates", async () => {
    const rows = groupTasks(views([drs()])).clients[0].transfers[0].workflow;
    const tree = TasksTable({ rows, canWrite: true, layout: "checklist" });
    (findAll(tree, StatusSelect)[0].props.onChange as (status: string) => void)("done");
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ taskId: "drs", status: "DONE", priority: "HIGH",
      expectedUpdatedAt: "2026-09-28T12:01:00Z", expectedFundingPlanVersion: 7 }));
    (findAll(tree, PrioritySelect)[0].props.onChange as (priority: string) => void)("normal");
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ taskId: "drs", status: "TODO", priority: "NORMAL",
      expectedUpdatedAt: "2026-09-28T12:01:00Z", expectedFundingPlanVersion: 7 }));
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("highlights DRS preparation again while the In transfer method change is pending", () => {
    const row = drs({ taskKey: "drs-paperwork", ownerTeam: "CLIENT_SERVICE",
      transferSummary: summary("drs-transfer", { stage: "IN_TRANSFER", fundingType: "DRS", drsMethodChangePending: true }) });
    expect(groupTasks(views([row])).clients[0].transfers[0].nextStep?.persistentId).toBe("drs");
    row.transferSummary = { ...row.transferSummary!, drsMethodChangePending: false };
    expect(groupTasks(views([row])).clients[0].transfers[0].nextStep).toBeNull();
  });

  it("uses the original operational method for grouping after a Funded label correction", () => {
    const corrected = summary("drs-transfer", { stage: "FUNDED", fundingType: "ACH", operationalFundingType: "DRS" });
    expect(groupTasks(views([drs({ transferSummary: corrected })])).clients[0].transfers[0].parallel).toBe(true);
    expect(markup([drs({ transferSummary: corrected })])).toContain("ACH</span>");
    for (const operationalFundingType of ["WIRE", null]) {
      const factual = summary("wire-transfer", { stage: "FUNDED", fundingType: "DRS", operationalFundingType });
      expect(groupTasks(views([task("wire", factual)])).clients[0].transfers[0].parallel).toBe(false);
    }
  });
});

describe("revised partial checklist controls", () => {
  const tokens = { updatedAt: "2026-09-28T12:02:00Z", fundingPlanVersion: 8, fundingMethodRevision: 3 };
  function revised() { return task("revised", summary(), {
    taskKey: "review-submit-partial-acat", ownerTeam: "OPERATIONS", fundingMethod: tokens,
  }); }

  it("carries every revision token for status and priority in grouped checklist updates", async () => {
    const rows = groupTasks(views([revised()])).clients[0].transfers[0].workflow;
    const tree = TasksTable({ rows, canWrite: true, layout: "checklist" });
    (findAll(tree, StatusSelect)[0].props.onChange as (status: string) => void)("done");
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ taskId: "revised", status: "DONE", priority: "HIGH",
      expectedUpdatedAt: tokens.updatedAt, expectedFundingPlanVersion: 8, expectedFundingMethodRevision: 3 }));
    (findAll(tree, PrioritySelect)[0].props.onChange as (priority: string) => void)("normal");
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ taskId: "revised", status: "TODO", priority: "NORMAL",
      expectedUpdatedAt: tokens.updatedAt, expectedFundingPlanVersion: 8, expectedFundingMethodRevision: 3 }));
  });

  it("disables Operations-owned revised partial controls for Client Service", () => {
    const rows = groupTasks(views([revised()], "CLIENT_SERVICE")).clients[0].transfers[0].workflow;
    const tree = TasksTable({ rows, canWrite: true, layout: "checklist" });
    expect(findAll(tree, StatusSelect)[0].props.disabled).toBe(true);
    expect(findAll(tree, PrioritySelect)[0].props.disabled).toBe(true);
    expect(toPersistedTaskView(revised(), "OPERATIONS").canUpdate).toBe(true);
  });
});
