import { describe, expect, it } from "vitest";
import { prepSummary } from "@/components/command-center/prep-summary";
import type { Meeting } from "@/lib/data/types";

// `key` is the appointment external_key in production; here it stands in for the
// per-meeting identity the summary counts on. Two meetings can share a clientId
// (or have none at all) and must still count separately.
function meeting(key: string, prepReady: boolean, clientId = ""): Meeting {
  return { client: key, clientId, key, when: "Mon · 9:00 AM", type: "Review", prepReady };
}

describe("prepSummary", () => {
  it("counts meetings that still need prep", () => {
    const s = prepSummary(
      [meeting("C-1", true), meeting("C-4", false), meeting("C-2", false)],
      new Set(),
    );
    expect(s).toEqual({ needPrep: 2, label: "2 need prep", tone: "amber" });
  });

  it("treats generated prep as ready (ephemeral write or a stored brief)", () => {
    const s = prepSummary(
      [meeting("C-1", true), meeting("C-4", false)],
      new Set(["C-4"]),
    );
    expect(s).toEqual({ needPrep: 0, label: "all prepped", tone: "green" });
  });

  it("counts per MEETING, not per client — unlinked rows share an empty clientId", () => {
    // Both live appointments have client_sf_id = null (the common case). Keyed on
    // clientId they would collapse into one; keyed on the meeting key they do not.
    const s = prepSummary(
      [meeting("slack|a|t1", false, ""), meeting("slack|b|t2", false, "")],
      new Set(["slack|a|t1"]),
    );
    expect(s).toEqual({ needPrep: 1, label: "1 need prep", tone: "amber" });
  });

  it("reports all prepped for an empty week", () => {
    expect(prepSummary([], new Set())).toEqual({
      needPrep: 0,
      label: "all prepped",
      tone: "green",
    });
  });
});
