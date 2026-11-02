import { describe, expect, it } from "vitest";
import { resolveRequirements } from "@/lib/data/nudge-requirements";

// ticket Phase 1 — requirements resolver. Verifies conditional bundling
// (ACH added only when no linked bank), supporting-doc surfacing, joint-signer
// augmentation, an action with no conditional requirements, and the unknown
// action fallback.

describe("resolveRequirements", () => {
  it("IRA distribution with no linked bank → [iradist, ach] with ACH supporting doc", () => {
    const out = resolveRequirements("ira_distribution", {
      hasLinkedBank: false,
      registration: "IRA",
    });
    expect(out.map((r) => r.code)).toEqual(["iradist", "ach"]);
    const ach = out.find((r) => r.code === "ach");
    expect(ach?.supporting).toBe("voided check / bank statement / bank letter");
  });

  it("IRA distribution with a linked bank → [iradist] only", () => {
    const out = resolveRequirements("ira_distribution", {
      hasLinkedBank: true,
      registration: "IRA",
    });
    expect(out.map((r) => r.code)).toEqual(["iradist"]);
  });

  it("joint registration adds the joint-holder signature on applicable forms", () => {
    const out = resolveRequirements("acat_transfer", {
      hasLinkedBank: true,
      registration: "joint",
      ownership: "joint",
    });
    const acat = out.find((r) => r.code === "acat");
    expect(acat?.signers).toContain("Joint account holder");
  });

  it("action with no conditional requirements resolves to exactly its base form", () => {
    const out = resolveRequirements("ach_setup", {
      hasLinkedBank: false,
      registration: "individual",
    });
    expect(out.map((r) => r.code)).toEqual(["ach"]);
  });

  it("unknown action → []", () => {
    const out = resolveRequirements("does_not_exist", {
      hasLinkedBank: false,
      registration: "individual",
    });
    expect(out).toEqual([]);
  });
});
