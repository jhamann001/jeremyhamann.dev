import { describe, expect, it } from "vitest";
import { acatLinkTargetMatches } from "@/components/transfers/acat-link-search";
import type { LinkTargetsResult } from "@/app/(authenticated)/acat-tracking/actions";

type Loaded = Extract<LinkTargetsResult, { ok: true }>;
const household = "001KQHF49638980AAA";
const targets: Loaded = {
  ok: true,
  households: [
    { sfId: household, name: "Smith Household", sourceNames: ["Tom Delgado Household", "Former Family Label"] },
    { sfId: "001VOAG41424504AAA", name: "Jones Household" },
  ],
  clients: [
    { sfId: "003ACAT1", name: "Tom Delgado", householdId: household.slice(0, 15), householdName: "Smith Household" },
    { sfId: "003ACAT2", name: "Adah O'Reilly", householdId: household, householdName: "Smith Household" },
    { sfId: "003ACAT3", name: "Tom Unrelated", householdId: null, householdName: null },
  ],
  openTransfers: [],
};

describe("ACAT household picker search", () => {
  it("finds one canonical household by a member's first name or different surname", () => {
    for (const query of ["tom", " O'REILLY "]) {
      const matches = acatLinkTargetMatches(targets, query);
      expect(matches[0]).toMatchObject({
        key: `h:${household}`,
        label: "Smith Household",
        target: { kind: "household", householdSfId: household, householdName: "Smith Household" },
      });
      expect(matches.filter((row) => row.target.kind === "household")).toHaveLength(1);
    }
  });

  it("preserves source-name and display-name searches without guessing unrelated households", () => {
    for (const query of ["former family", "smith household"]) {
      expect(acatLinkTargetMatches(targets, query)[0]?.key).toBe(`h:${household}`);
    }
    expect(acatLinkTargetMatches(targets, "Unrelated").map((row) => row.key)).toEqual(["c:003ACAT3"]);
    expect(acatLinkTargetMatches(targets, "outside book")).toEqual([]);
    expect(acatLinkTargetMatches(targets, " ")).toEqual([]);
  });

  it("keeps household discoverability and the eight-result limit for common member names", () => {
    const crowded = {
      ...targets,
      clients: Array.from({ length: 20 }, (_, index) => ({
        sfId: `003MANY${index}`, name: `Common Person ${index}`, householdId: household,
        householdName: "Smith Household",
      })),
    };
    const matches = acatLinkTargetMatches(crowded, "Common");
    expect(matches).toHaveLength(8);
    expect(matches[0].key).toBe(`h:${household}`);
    expect(matches.filter((row) => row.target.kind === "household")).toHaveLength(1);
  });

  it("does not associate opaque imported household IDs that share a prefix", () => {
    const firstId = "legacy-household-shared-prefix-first";
    const secondId = "legacy-household-shared-prefix-second";
    const imported: Loaded = {
      ok: true, openTransfers: [],
      households: [{ sfId: firstId, name: "First" }, { sfId: secondId, name: "Second" }],
      clients: [{ sfId: "legacy-member", name: "Unique Member", householdId: secondId, householdName: "Second" }],
    };
    expect(acatLinkTargetMatches(imported, "Unique").filter((row) => row.target.kind === "household")
      .map((row) => row.key)).toEqual([`h:${secondId}`]);
  });
});
