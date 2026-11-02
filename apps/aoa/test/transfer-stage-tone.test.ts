import { describe, expect, it } from "vitest";
import { transferStageTone } from "../components/transfers/transfer-stage-tone";
import { TRANSFER_STAGES } from "../lib/data/transfer-types";

// The board's stage → tone map (components/transfers/transfer-stage-tone.ts):
// total over the TransferStage vocabulary (collapsed to 3 by ticket Slice 1),
// pinned to gold / blue / green for DECISION / IN_TRANSFER / FUNDED.

const VALID_TONES = ["green", "gold", "blue", "amber", "red", "gray"];

describe("transferStageTone", () => {
  it("maps every stage to a valid PillTone (total)", () => {
    for (const stage of TRANSFER_STAGES) {
      expect(VALID_TONES).toContain(transferStageTone(stage));
    }
  });

  it("pins the tone per stage (ticket Slice 1: 3 stages)", () => {
    expect(transferStageTone("DECISION")).toBe("gold");
    expect(transferStageTone("IN_TRANSFER")).toBe("blue");
    expect(transferStageTone("FUNDED")).toBe("green");
  });
});
