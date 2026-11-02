import { describe, expect, it } from "vitest";
import { temperatureTone } from "../components/transfers/temperature-tone";

// The temperature tone-word → PillTone map (T4, TDD ADR-10) — the mockup's
// rule made total: Sensitive/Stalled → red, Done/Smooth → green, else gold.

describe("temperatureTone", () => {
  it("maps Sensitive and Stalled to red", () => {
    expect(temperatureTone("Sensitive")).toBe("red");
    expect(temperatureTone("Stalled")).toBe("red");
  });

  it("maps Done and Smooth to green", () => {
    expect(temperatureTone("Done")).toBe("green");
    expect(temperatureTone("Smooth")).toBe("green");
  });

  it("falls back to gold for everything else (open tone vocabulary)", () => {
    expect(temperatureTone("Watchful")).toBe("gold");
    expect(temperatureTone("Warm")).toBe("gold");
    expect(temperatureTone("")).toBe("gold");
    // Case-sensitive by design: the fixtures own the vocabulary; an unknown
    // casing is just another unknown word → the gold middle, never a crash.
    expect(temperatureTone("sensitive")).toBe("gold");
  });
});
