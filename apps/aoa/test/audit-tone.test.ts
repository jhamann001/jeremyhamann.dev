import { describe, expect, it } from "vitest";
import { actionTone } from "@/components/audit/audit-tone";

// Action → tone map (WO ticket): keyed on the dotted verb suffix that
// lib/audit.ts writes, so future writers (transfer.create, task.update, …)
// tone correctly without per-entity map entries.

describe("actionTone", () => {
  it("tones the three deal actions D3 writes today", () => {
    expect(actionTone("deal.create")).toBe("green");
    expect(actionTone("deal.update")).toBe("blue");
    expect(actionTone("deal.stage_change")).toBe("amber");
  });

  it("tones by verb suffix regardless of entity prefix", () => {
    expect(actionTone("transfer.create")).toBe("green");
    expect(actionTone("task.update")).toBe("blue");
    expect(actionTone("acat.stage_change")).toBe("amber");
    expect(actionTone("household.delete")).toBe("red");
  });

  it("handles nested dotted names by the LAST segment", () => {
    expect(actionTone("deal.stage.create")).toBe("green");
  });

  it("falls back to gray for unknown verbs and undotted actions", () => {
    expect(actionTone("deal.view")).toBe("gray");
    expect(actionTone("login")).toBe("gray");
    expect(actionTone("")).toBe("gray");
  });
});
