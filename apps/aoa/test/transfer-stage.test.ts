import { describe, expect, it } from "vitest";
import { daysInStage, stageChangeWarnings } from "@/lib/data/transfer-stage";
import { gateStatus, type GateStatus } from "@/lib/data/transfer-basis";
import { STAGE_ORDER } from "@/lib/data/transfer-types";

// Pure stage-transition helpers (T3, WO ticket / TDD ADR-2). All data
// invented. Gates are SOFT — warnings are advisory text, never a block.

const DAY = 86_400_000;

describe("daysInStage", () => {
  const now = new Date("2026-07-02T12:00:00.000Z");

  it("floors to whole elapsed days", () => {
    expect(daysInStage(new Date(now.getTime() - 5 * DAY), now)).toBe(5);
    expect(daysInStage(new Date(now.getTime() - 5.9 * DAY), now)).toBe(5);
  });

  it("same-day transition reads as day 0", () => {
    expect(daysInStage(new Date(now.getTime() - 3600_000), now)).toBe(0);
  });

  it("clamps a future (clock-skewed) timestamp at 0, never -1", () => {
    expect(daysInStage(new Date(now.getTime() + 2 * DAY), now)).toBe(0);
  });
});

// Helper: gates with a chosen set of unsatisfied stages (state fields don't
// matter to stageChangeWarnings — only stage/label/gate/satisfied do).
function gatesWith(unsatisfied: string[]): GateStatus[] {
  return gateStatus({
    stage: "DECISION",
    tasks: [],
    decisions: [],
    accounts: [],
  }).map((g) => ({ ...g, satisfied: !unsatisfied.includes(g.stage) }));
}

describe("stageChangeWarnings (ticket Slice 1: 3 stages)", () => {
  it("same stage → no warnings", () => {
    expect(
      stageChangeWarnings(gatesWith([...STAGE_ORDER]), "DECISION", "DECISION"),
    ).toEqual([]);
  });

  it("backward move → no warnings even over unmet gates", () => {
    expect(
      stageChangeWarnings(gatesWith([...STAGE_ORDER]), "IN_TRANSFER", "DECISION"),
    ).toEqual([]);
  });

  it("forward over satisfied gates → no warnings", () => {
    expect(
      stageChangeWarnings(gatesWith([]), "DECISION", "IN_TRANSFER"),
    ).toEqual([]);
  });

  it("forward past one unmet gate → one pinned warning", () => {
    expect(
      stageChangeWarnings(gatesWith(["DECISION"]), "DECISION", "IN_TRANSFER"),
    ).toEqual([
      "Gate not met — Preparation: Accounts open · funding plan · funding initiated.",
    ]);
  });

  it("only stages in [from, to) are checked — later unmet gates don't warn", () => {
    expect(
      stageChangeWarnings(
        gatesWith(["IN_TRANSFER", "FUNDED"]),
        "DECISION",
        "IN_TRANSFER",
      ),
    ).toEqual([]);
  });

  it("skip-ahead collects every unmet gate in between, in board order", () => {
    expect(
      stageChangeWarnings(
        gatesWith(["DECISION", "IN_TRANSFER"]),
        "DECISION",
        "FUNDED",
      ),
    ).toEqual([
      "Gate not met — Preparation: Accounts open · funding plan · funding initiated.",
      "Gate not met — In transfer: ACAT in motion / cash in flight.",
    ]);
  });

  it("integrates with gateStatus: an incomplete checklist warns on advance", () => {
    // Slice 1: DECISION satisfaction proxies on the checklist (placeholder).
    const gates = gateStatus({
      stage: "DECISION",
      tasks: [{ done: false }],
      decisions: [],
      accounts: [],
    });
    expect(stageChangeWarnings(gates, "DECISION", "IN_TRANSFER")).toEqual([
      "Gate not met — Preparation: Accounts open · funding plan · funding initiated.",
    ]);
    // ...and finishing the checklist clears the warning.
    const done = gateStatus({
      stage: "DECISION",
      tasks: [{ done: true }],
      decisions: [],
      accounts: [],
    });
    expect(stageChangeWarnings(done, "DECISION", "IN_TRANSFER")).toEqual([]);
  });
});
