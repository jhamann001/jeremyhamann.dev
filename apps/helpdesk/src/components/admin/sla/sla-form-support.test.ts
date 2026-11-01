/**
 * Pure client-side support for the SLA form.
 *
 * The last test is the one that earns its place: the bounds here are a cosmetic MIRROR of
 * `SLA_POLICY_LIMITS` in `src/server/sla-policies.ts` (a component may not value-import a non-action
 * server module, G1), and a mirror nobody checks is a mirror that drifts. It reads both files as TEXT
 * rather than importing the server module, for the same reason the module itself does not.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SLA_FIELDS,
  SLA_FIELD_BOUNDS,
  draftFrom,
  draftNotes,
  humanMinutes,
  isDirty,
  parseMinutes,
  validateDraft,
  type SlaDraft,
} from "@/components/admin/sla/sla-form-support";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..", "..");

function draft(over: Partial<SlaDraft> = {}): SlaDraft {
  return { firstResponseMinutes: "30", resolutionMinutes: "120", warningMinutes: "30", ...over };
}

describe("parseMinutes", () => {
  it("accepts a whole number inside the bounds", () => {
    expect(parseMinutes("240", "firstResponseMinutes")).toEqual({ value: 240, error: null });
    expect(parseMinutes("  60 ", "resolutionMinutes")).toEqual({ value: 60, error: null });
    expect(parseMinutes("0", "warningMinutes")).toEqual({ value: 0, error: null });
  });

  it("refuses an empty box rather than treating it as zero", () => {
    expect(parseMinutes("", "warningMinutes").value).toBeNull();
    expect(parseMinutes("   ", "warningMinutes").error).toMatch(/required/);
  });

  it("refuses anything that is not a whole number of minutes", () => {
    for (const bad of ["1.5", "-30", "30m", "1e3", "three", "0x10", "+5"]) {
      expect(parseMinutes(bad, "firstResponseMinutes").value, bad).toBeNull();
    }
  });

  it("refuses values outside the field's own bounds", () => {
    expect(parseMinutes("0", "firstResponseMinutes").error).toMatch(/at least 1/);
    expect(parseMinutes("10081", "firstResponseMinutes").error).toMatch(/at most 10080/);
    expect(parseMinutes("129601", "resolutionMinutes").error).toMatch(/at most 129600/);
    expect(parseMinutes("10081", "warningMinutes").error).toMatch(/at most 10080/);
  });
});

describe("validateDraft", () => {
  it("returns the parsed numbers when every field is usable", () => {
    expect(validateDraft(draft()).values).toEqual({
      firstResponseMinutes: 30,
      resolutionMinutes: 120,
      warningMinutes: 30,
    });
  });

  it("refuses a resolution clock that expires before the first-response clock", () => {
    const verdict = validateDraft(draft({ firstResponseMinutes: "240", resolutionMinutes: "60" }));
    expect(verdict.values).toBeNull();
    expect(verdict.errors.resolutionMinutes).toMatch(/cannot expire before/);
  });

  it("allows the two clocks to be equal — a single deadline is a policy, not a mistake", () => {
    expect(validateDraft(draft({ firstResponseMinutes: "60", resolutionMinutes: "60" })).values).not.toBeNull();
  });

  it("reports every bad field at once, not just the first", () => {
    const verdict = validateDraft(draft({ firstResponseMinutes: "", warningMinutes: "abc" }));
    expect(verdict.values).toBeNull();
    expect(Object.keys(verdict.errors).sort()).toEqual(["firstResponseMinutes", "warningMinutes"]);
  });
});

describe("isDirty", () => {
  const saved = { firstResponseMinutes: 30, resolutionMinutes: 120, warningMinutes: 30 };

  it("is false for the untouched draft, so an untouched form cannot write an audit row", () => {
    expect(isDirty(draftFrom(saved), saved)).toBe(false);
  });

  it("ignores surrounding whitespace, which is not an edit", () => {
    expect(isDirty(draft({ warningMinutes: " 30 " }), saved)).toBe(false);
  });

  it("is true for any real change", () => {
    for (const f of SLA_FIELDS) {
      expect(isDirty(draft({ [f]: "7" }), saved), f).toBe(true);
    }
  });
});

describe("draftNotes", () => {
  it("says so when the warning band is switched off", () => {
    const notes = draftNotes({ firstResponseMinutes: 30, resolutionMinutes: 120, warningMinutes: 0 });
    expect(notes.join(" ")).toMatch(/straight to breached/);
  });

  it("warns when every new ticket would be amber from arrival", () => {
    // Exactly today's URGENT policy: a 30-minute first response with a 30-minute band.
    const notes = draftNotes({ firstResponseMinutes: 30, resolutionMinutes: 120, warningMinutes: 30 });
    expect(notes.join(" ")).toMatch(/amber from the moment it arrives/);
  });

  it("says nothing about an ordinary policy", () => {
    expect(draftNotes({ firstResponseMinutes: 240, resolutionMinutes: 1440, warningMinutes: 30 })).toEqual([]);
  });

  it("flags a band longer than the whole resolution clock", () => {
    const notes = draftNotes({ firstResponseMinutes: 5, resolutionMinutes: 10, warningMinutes: 60 });
    expect(notes.join(" ")).toMatch(/longer than the whole resolution clock/);
  });
});

describe("humanMinutes", () => {
  it("reads the way a person would say it", () => {
    expect(humanMinutes(0)).toBe("0m");
    expect(humanMinutes(45)).toBe("45m");
    expect(humanMinutes(120)).toBe("2h");
    expect(humanMinutes(150)).toBe("2h 30m");
    expect(humanMinutes(1440)).toBe("1d");
    expect(humanMinutes(4320)).toBe("3d");
  });
});

describe("the mirrored bounds", () => {
  it("match SLA_POLICY_LIMITS in the server module, which is the authority", () => {
    const server = readFileSync(path.join(REPO_ROOT, "src/server/sla-policies.ts"), "utf8");
    // One LITERAL pattern, read once, keyed by the property name it captures. `new RegExp(`${name}:…`)`
    // was two security scanner findings on this line — CWE-185 (a pattern built from a
    // variable) and CWE-1333 (the unbounded `+` runs). The quantifiers are
    // bounded, so the scan is linear; first occurrence wins, exactly as `.exec()` did.
    const limits = new Map<string, number>();
    for (const m of server.matchAll(/([A-Za-z][A-Za-z0-9_]{0,60}):\s{0,20}([0-9_]{1,24})/g)) {
      if (!limits.has(m[1])) limits.set(m[1], Number(m[2].replace(/_/g, "")));
    }
    const read = (name: string): number => {
      const value = limits.get(name);
      expect(value, `${name} is missing from SLA_POLICY_LIMITS`).toBeDefined();
      return value as number;
    };
    expect(SLA_FIELD_BOUNDS.firstResponseMinutes.min).toBe(read("firstResponseMinutesMin"));
    expect(SLA_FIELD_BOUNDS.firstResponseMinutes.max).toBe(read("firstResponseMinutesMax"));
    expect(SLA_FIELD_BOUNDS.resolutionMinutes.min).toBe(read("resolutionMinutesMin"));
    expect(SLA_FIELD_BOUNDS.resolutionMinutes.max).toBe(read("resolutionMinutesMax"));
    expect(SLA_FIELD_BOUNDS.warningMinutes.min).toBe(read("warningMinutesMin"));
    expect(SLA_FIELD_BOUNDS.warningMinutes.max).toBe(read("warningMinutesMax"));
  });

  it("matches formatSlaMinutes in src/lib/sla.ts for every shape the form can render", async () => {
    const { formatSlaMinutes } = await import("@/lib/sla");
    for (const m of [0, 1, 59, 60, 61, 120, 150, 1439, 1440, 2130, 10_080, 129_600]) {
      expect(humanMinutes(m), String(m)).toBe(formatSlaMinutes(m));
    }
  });
});
