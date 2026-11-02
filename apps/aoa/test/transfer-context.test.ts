import { describe, expect, it } from "vitest";
import { getTransferContext } from "../lib/data/transfer-context";
import { TRANSFER_CONTEXT } from "../lib/mock/transfer-context";
import { temperatureTone } from "../components/transfers/temperature-tone";

// The Phase E temperature seam over the T4 fixtures (TDD ADR-10). The WO
// requires the register to carry at least one red-mapped and one green-mapped
// tone plus one deliberately absent seed client — the Playwright pass relies
// on these fixture-level guarantees, so they are pinned here.

describe("getTransferContext", () => {
  it("returns the fixture for a known seed client_sf_id", () => {
    const ctx = getTransferContext("C-1");
    expect(ctx).not.toBeNull();
    expect(ctx?.tone).toBe("Sensitive");
  });

  it("returns null for an unknown client_sf_id", () => {
    expect(getTransferContext("C-999")).toBeNull();
  });

  it("returns null for null (prospect-shaped transfers)", () => {
    expect(getTransferContext(null)).toBeNull();
  });

  it("keeps C-2 (Jo Stone) absent — the seed no-context client", () => {
    expect(getTransferContext("C-2")).toBeNull();
    expect(Object.keys(TRANSFER_CONTEXT)).not.toContain("C-2");
  });
});

describe("TRANSFER_CONTEXT register shape", () => {
  const entries = Object.entries(TRANSFER_CONTEXT);

  it("carries at least one red-mapped and one green-mapped tone", () => {
    const tones = entries.map(([, c]) => temperatureTone(c.tone));
    expect(tones).toContain("red");
    expect(tones).toContain("green");
  });

  it("every fixture has a narrative and at least one source chip", () => {
    for (const [key, ctx] of entries) {
      expect(ctx.narrative.length, key).toBeGreaterThan(0);
      expect(ctx.sources.length, key).toBeGreaterThan(0);
    }
  });

  it("keys are seed client sf_ids (C-*)", () => {
    for (const [key] of entries) expect(key).toMatch(/^C-\d+$/);
  });
});
