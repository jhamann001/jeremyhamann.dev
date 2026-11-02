import { describe, expect, it } from "vitest";
import { stageTone } from "@/components/deals/stage-tone";
import { DEAL_STAGES } from "@/lib/data/deal-types";

// The D2 stage → PillTone map (status-tone idiom). Totality + the pipeline
// semantics that the screen depends on (WON reads green, LOST reads red).

const PILL_TONES = ["green", "gold", "blue", "amber", "red", "gray"] as const;

describe("stageTone", () => {
  it("maps every DealStage to a valid PillTone (total map)", () => {
    for (const stage of DEAL_STAGES) {
      expect(PILL_TONES).toContain(stageTone(stage));
    }
  });

  it("keeps the terminal stages semantically toned", () => {
    expect(stageTone("WON")).toBe("green");
    expect(stageTone("LOST")).toBe("red");
  });

  it("gives open pipeline stages distinct tones", () => {
    const open = ["POTENTIAL", "COMMITTED", "FUNDING"] as const;
    const tones = open.map(stageTone);
    expect(new Set(tones).size).toBe(open.length);
  });
});
