import { describe, expect, it } from "vitest";
import {
  defaultResidualFollowUpDate,
  defaultFeeCharged,
  isFullOutgoingTransfer,
  isOutgoingTransfer,
  isResidualTransfer,
  localDateString,
} from "./acat-operational-defaults";

describe("ACAT operational defaults", () => {
  it.each([
    ["In", "Full"],
    ["Out", "Full"],
    ["In", "Partial"],
    ["Out", "Partial"],
  ])("defaults %s %s DRS transfers to no fee", (direction, type) => {
    expect(defaultFeeCharged({ direction, type, transferWorkflow: "DRS" })).toBe("No");
  });

  it("keeps non-DRS defaults and normalizes the DRS workflow", () => {
    expect(defaultFeeCharged({ direction: "Out", type: "Full", transferWorkflow: "ACAT" })).toBe("Yes");
    expect(defaultFeeCharged({ direction: "In", type: "Full", transferWorkflow: "ACAT" })).toBeUndefined();
    expect(defaultFeeCharged({ transferWorkflow: " drs " })).toBe("No");
  });

  it("recognizes outgoing, full outgoing, and residual records case-insensitively", () => {
    expect(isOutgoingTransfer({ direction: " out " })).toBe(true);
    expect(isFullOutgoingTransfer({ direction: "OUT", type: "Full" })).toBe(true);
    expect(isResidualTransfer({ type: "residual credit" })).toBe(true);
  });

  it("defaults follow-up to seven local calendar days later across month boundaries", () => {
    expect(localDateString(new Date(2026, 8, 28, 23, 30))).toBe("2026-09-28");
    expect(defaultResidualFollowUpDate(new Date(2026, 8, 28, 23, 30))).toBe("2026-10-05");
  });
});
