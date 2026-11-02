import { describe, expect, it } from "vitest";
import { DRS_TASKS, canUpdateDrsTask, drsTasksForStage, drsTaskStatusError, drsWorkflowGate } from "@/lib/data/drs-workflow";

const tasks = DRS_TASKS.map((task) => ({ taskKey: task.taskKey, status: "TODO" }));
const ready = tasks.map((task) => ({ ...task, status: "DONE" }));
const approved = { from: "DECISION" as const, to: "IN_TRANSFER" as const, fundingPlanComplete: true, fundingPlanVersion: 1 };

describe("DRS lifecycle gates", () => {
  it("requires the five preparation tasks, with separate ownership", () => {
    expect(drsWorkflowGate({ ...approved, tasks }).unmet).toEqual(DRS_TASKS.slice(0, 5).map((task) => task.title));
    expect(drsWorkflowGate({ ...approved, tasks: tasks.map((task, i) => ({ ...task, status: i < 5 ? "DONE" : "TODO" })) }).blocked).toBe(false);
    expect(DRS_TASKS.slice(0, 5).map((task) => task.ownerTeam)).toEqual(["CLIENT_SERVICE", "CLIENT_SERVICE", "CLIENT_SERVICE", "OPERATIONS", "OPERATIONS"]);
  });

  it("requires Apex confirmation for Funded but keeps two unfinished follow-ups", () => {
    const input = { ...approved, from: "IN_TRANSFER" as const, to: "FUNDED" as const };
    const unfinished = tasks.map((task, i) => ({ ...task, status: i < 5 ? "DONE" : "TODO" }));
    expect(drsWorkflowGate({ ...input, tasks: unfinished }).unmet).toEqual([DRS_TASKS[5].title]);
    unfinished[5].status = "DONE";
    expect(drsWorkflowGate({ ...input, tasks: unfinished }).blocked).toBe(false);
    expect(drsTasksForStage("DECISION")).toHaveLength(5);
    expect(drsTasksForStage("IN_TRANSFER")).toHaveLength(3);
    expect(drsTasksForStage("FUNDED").map((task) => task.key)).toEqual(["reconciliation", "client-communication"]);
  });

  it("fails closed for missing or duplicated inventory, even missing follow-ups", () => {
    expect(drsWorkflowGate({ ...approved, tasks: [] }).unmet).toHaveLength(8);
    expect(drsWorkflowGate({ ...approved, tasks: ready.slice(0, 7) }).blocked).toBe(true);
    expect(drsWorkflowGate({ ...approved, tasks: [...ready, ready[0]] }).blocked).toBe(true);
  });

  it.each([
    { fundingPlanComplete: false }, { fundingPlanVersion: 0 }, { fundingPlanVersion: 1.5 },
    { blockingExceptions: 1 }, { archived: true }, { to: "FUNDED" as const },
    { from: "DISCOVERY" as never },
  ])("rejects unsafe advancement %j", (override) => {
    expect(drsWorkflowGate({ ...approved, tasks: ready, ...override }).blocked).toBe(true);
  });

  it("allows operational regression and unchanged stages unless archived", () => {
    expect(drsWorkflowGate({ ...approved, from: "FUNDED", to: "IN_TRANSFER", tasks: [] }).blocked).toBe(false);
    expect(drsWorkflowGate({ ...approved, to: "DECISION", tasks: [] }).blocked).toBe(false);
  });
});

describe("DRS task eligibility", () => {
  it("restricts Ops tasks and lets CS own client work", () => {
    expect(canUpdateDrsTask("CLIENT_SERVICE", "OPERATIONS")).toBe(false);
    expect(canUpdateDrsTask("CLIENT_SERVICE", "CLIENT_SERVICE")).toBe(true);
    expect(canUpdateDrsTask("ADVISOR", "CLIENT_SERVICE")).toBe(false);
    expect(canUpdateDrsTask("VIEWER", "CLIENT_SERVICE")).toBe(false);
    expect(canUpdateDrsTask("OPERATIONS", "CLIENT_SERVICE")).toBe(true);
    expect(canUpdateDrsTask("ADMIN", "OPERATIONS")).toBe(true);
  });

  it("prevents premature confirmation and reopening passed preparation", () => {
    const action = { role: "OPERATIONS", currentStatus: "TODO" as const, status: "DONE" as const };
    expect(drsTaskStatusError({ ...action, taskKey: "drs-apex-confirmed", stage: "DECISION" })).toMatch(/In transfer/);
    expect(drsTaskStatusError({ ...action, taskKey: "drs-apex-confirmed", stage: "IN_TRANSFER" })).toBeNull();
    expect(drsTaskStatusError({ ...action, taskKey: "drs-paperwork", stage: "IN_TRANSFER", currentStatus: "DONE", status: "TODO" })).toMatch(/Preparation/);
    expect(drsTaskStatusError({ ...action, taskKey: "drs-apex-confirmed", stage: "FUNDED", currentStatus: "DONE", status: "TODO" })).not.toBeNull();
  });

  it("allows follow-ups after funding without requiring premature reconciliation", () => {
    const action = { role: "OPERATIONS", currentStatus: "TODO" as const, status: "DONE" as const };
    expect(drsTaskStatusError({ ...action, taskKey: "drs-reconciliation", stage: "DECISION" })).not.toBeNull();
    for (const taskKey of ["drs-reconciliation", "drs-client-communication"]) {
      expect(drsTaskStatusError({ ...action, taskKey, stage: "FUNDED" })).toBeNull();
    }
  });
});
