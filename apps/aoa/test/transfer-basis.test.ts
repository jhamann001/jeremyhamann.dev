import { describe, expect, it } from "vitest";
import {
  gateStatus,
  recommendPosition,
  type GateDetail,
} from "@/lib/data/transfer-basis";
import { STAGE_GATES, STAGE_LABEL, STAGE_ORDER } from "@/lib/data/transfer-types";

// All data invented — no real client information.

describe("recommendPosition", () => {
  it("null basis -> BASIS_NEEDED", () => {
    const rec = recommendPosition(96000, null);
    expect(rec.kind).toBe("BASIS_NEEDED");
    expect(rec.label).toBe("Basis needed");
  });

  it("gain above 300% -> LEAVE_GIFT (highly appreciated)", () => {
    // 181000 on 22000 basis = ~723% unrealized gain.
    const rec = recommendPosition(181000, 22000);
    expect(rec.kind).toBe("LEAVE_GIFT");
    expect(rec.label).toBe("Leave / gift — highly appreciated");
  });

  it("low basis / modest gain -> BRING_IN", () => {
    // 140000 on 128000 basis = ~9% gain.
    const rec = recommendPosition(140000, 128000);
    expect(rec.kind).toBe("BRING_IN");
    expect(rec.label).toBe("Bring in — low basis enables TLH");
  });

  it("the exact 300% boundary is BRING_IN (strictly greater than)", () => {
    // value = 4 x basis -> gain exactly 300% -> NOT highly appreciated.
    expect(recommendPosition(40000, 10000).kind).toBe("BRING_IN");
  });

  it("just past the 300% boundary is LEAVE_GIFT", () => {
    expect(recommendPosition(40001, 10000).kind).toBe("LEAVE_GIFT");
  });

  it("a loss position is BRING_IN", () => {
    expect(recommendPosition(8000, 10000).kind).toBe("BRING_IN");
  });

  it("zero basis with positive value is an unbounded gain -> LEAVE_GIFT", () => {
    expect(recommendPosition(50000, 0).kind).toBe("LEAVE_GIFT");
  });

  it("zero basis with zero value -> BRING_IN (no meaningful gain)", () => {
    expect(recommendPosition(0, 0).kind).toBe("BRING_IN");
  });
});

function detail(overrides: Partial<GateDetail> = {}): GateDetail {
  return {
    stage: "DECISION",
    tasks: [{ done: true }, { done: false }],
    decisions: [{ decision: "BRING_IN" }, { decision: "LEAVE_GIFT" }],
    accounts: [{ status: "OPEN" }, { status: "TO_OPEN" }],
    ...overrides,
  };
}

describe("gateStatus — shape and stepper states (ticket Slice 1: 3 stages)", () => {
  it("returns one entry per stage in board order with labels + gate captions", () => {
    const steps = gateStatus(detail());
    expect(steps.map((s) => s.stage)).toEqual([...STAGE_ORDER]);
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.label).toBe(STAGE_LABEL[step.stage]);
      expect(step.gate).toBe(STAGE_GATES[step.stage]);
    }
  });

  it("a DECISION record (first lane) has only todo after the current step", () => {
    const steps = gateStatus(detail({ stage: "DECISION" }));
    expect(steps.map((s) => s.state)).toEqual(["now", "todo", "todo"]);
  });

  it("marks stages before current done, current now, later todo", () => {
    const steps = gateStatus(detail({ stage: "IN_TRANSFER" }));
    expect(steps.map((s) => s.state)).toEqual(["done", "now", "todo"]);
  });

  it("a FUNDED record shows all earlier stages done", () => {
    const steps = gateStatus(detail({ stage: "FUNDED" }));
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "now"]);
  });
});

// ticket Slice 1: every stage's satisfaction proxies on checklist completion.
// DECISION's rule is a documented PLACEHOLDER — Slice 2 introduces the readiness
// columns and finalizes it to "all three checklist booleans true".
describe("gateStatus — checklist-proxied satisfaction (all 3 stages)", () => {
  it("DECISION / IN_TRANSFER / FUNDED report checklist completion", () => {
    const complete = gateStatus(
      detail({ tasks: [{ done: true }, { done: true }] }),
    );
    const incomplete = gateStatus(
      detail({ tasks: [{ done: true }, { done: false }] }),
    );
    for (const stage of ["DECISION", "IN_TRANSFER", "FUNDED"] as const) {
      expect(complete.find((s) => s.stage === stage)?.satisfied).toBe(true);
      expect(incomplete.find((s) => s.stage === stage)?.satisfied).toBe(false);
    }
  });

  it("an empty checklist is vacuously satisfied", () => {
    const steps = gateStatus(detail({ tasks: [] }));
    expect(steps.find((s) => s.stage === "DECISION")?.satisfied).toBe(true);
  });

  it("DECISION satisfaction is the checklist placeholder, not decision rows", () => {
    // All decision rows undecided, but every task done: DECISION is satisfied
    // (the Slice 1 placeholder ignores the decision table).
    const steps = gateStatus(
      detail({
        tasks: [{ done: true }],
        decisions: [{ decision: "UNDECIDED" }],
      }),
    );
    expect(steps.find((s) => s.stage === "DECISION")?.satisfied).toBe(true);
  });
});
