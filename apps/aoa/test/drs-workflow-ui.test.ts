import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useTransition: () => [false, (run: () => void) => run()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(authenticated)/asset-transfer/actions", () => ({ initializeDrsWorkflow: mocks.initialize }));
vi.mock("@/app/(authenticated)/(workflow)/decision-center/actions", () => ({ updateDecisionTask: mocks.update }));

import { DRS_TASKS, type DrsWorkflowTaskRow } from "@/lib/data/drs-workflow";
import { DrsWorkflowCard } from "@/components/transfers/DrsWorkflowCard";

function tasks(): DrsWorkflowTaskRow[] {
  return DRS_TASKS.map((task) => ({
    id: `synthetic-${task.key}`, key: task.key, taskKey: task.taskKey, title: task.title,
    ownerTeam: task.ownerTeam, status: "TODO", priority: "HIGH", completedAt: null,
    completedBy: null, updatedAt: "2026-09-25T12:00:00.000Z", fundingPlanVersion: 4,
  }));
}
function props() {
  return {
    transferId: "synthetic-transfer", stage: "DECISION" as const, tasks: tasks(),
    role: "OPERATIONS", canWrite: true, planComplete: true, fundingPlanVersion: 4,
  };
}
function findAction(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; "aria-label"?: string; onClick?: () => void }>(child)) continue;
    if (child.props["aria-label"] === label) return child as ReactElement<{ onClick: () => void }>;
    const found = findAction(child.props.children, label);
    if (found) return found;
  }
  return null;
}

describe("DRS workflow presentation and saved-task controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue({ ok: true });
    mocks.update.mockResolvedValue({ ok: true });
  });

  it("renders eight named tasks with ownership and independent follow-up work", () => {
    const html = renderToStaticMarkup(createElement(DrsWorkflowCard, props()));
    for (const task of DRS_TASKS) expect(html).toContain(task.title);
    expect(html).toContain("Client Service · To do");
    expect(html).toContain("Operations · To do");
    expect(html).toContain("use the stage toolbar");
    expect(html).not.toContain("Initialize DRS tasks");
  });

  it("offers Operations setup for an approved legacy DRS record with missing tasks", () => {
    const html = renderToStaticMarkup(createElement(DrsWorkflowCard, { ...props(), tasks: [] }));
    expect(html).toContain("Initialize DRS tasks");
    expect(html.match(/Not initialized/g)).toHaveLength(8);
    expect(html).toContain("before moving this transfer forward");
    const clientService = renderToStaticMarkup(createElement(DrsWorkflowCard, { ...props(), tasks: [], role: "CLIENT_SERVICE" }));
    expect(clientService).not.toContain("Initialize DRS tasks");
  });

  it.each([{ planComplete: false, fundingPlanVersion: 4 }, { planComplete: true, fundingPlanVersion: 0 }])(
    "requires a current versioned approval before initializing or updating tasks ($planComplete/$fundingPlanVersion)",
    (approval) => {
      const html = renderToStaticMarkup(createElement(DrsWorkflowCard, { ...props(), ...approval }));
      expect(html).toContain("Approve the DRS funding plan");
      expect(html).not.toContain("<button");
    },
  );

  it("keeps completed preparation and open follow-up tasks visible when Funded", () => {
    const rows = tasks().map((task) => ({ ...task, status: task.key === "reconciliation" || task.key === "client-communication" ? "TODO" as const : "DONE" as const }));
    const html = renderToStaticMarkup(createElement(DrsWorkflowCard, { ...props(), stage: "FUNDED", tasks: rows }));
    expect(html).toContain("Reconcile received securities");
    expect(html).toContain("Notify the client");
    expect(html).toContain("Client Service · Done");
    expect(html).toContain("Preparation tasks cannot change");
  });

  it("renders no write controls for an archived or read-only record", () => {
    const html = renderToStaticMarkup(createElement(DrsWorkflowCard, { ...props(), canWrite: false }));
    expect(html).not.toContain("<button");
    expect(html).toContain("Obtain signed full-transfer paperwork");
  });

  it("submits the task timestamp and funding-plan revision from the rendered row", async () => {
    const tree = DrsWorkflowCard(props());
    const button = findAction(tree, `Mark done: ${DRS_TASKS[0].title}`)!;
    expect(button).not.toBeNull();
    button.props.onClick();
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      taskId: "synthetic-paperwork", status: "DONE", priority: "HIGH",
      expectedUpdatedAt: "2026-09-25T12:00:00.000Z", expectedFundingPlanVersion: 4,
    }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
