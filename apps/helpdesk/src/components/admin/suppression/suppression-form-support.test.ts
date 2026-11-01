/**
 * `/admin/suppression` wording and helpers.
 *
 * The maps are asserted for TOTALITY rather than for their exact words: a reason with no label renders
 * a raw enum member on an operator's screen, and a reason with no help line leaves them guessing what
 * stopping a client's mail actually means.
 */
import { describe, expect, it } from "vitest";
import { SUPPRESSION_REASONS, SUPPRESSION_REASON_LABELS } from "@/types/domain";
import type { SuppressionDTO } from "@/types/domain";
import {
  LIFT_REASON_MIN,
  SUPPRESSION_REASON_HELP,
  SUPPRESSION_REASON_VARIANTS,
  SUPPRESSION_STATE_LABELS,
  bounceCountLabel,
  shortAddress,
  suppressionState,
} from "@/components/admin/suppression/suppression-form-support";

function row(overrides: Partial<SuppressionDTO> = {}): SuppressionDTO {
  return {
    id: "sup_1",
    email: "client@example.com",
    reason: "MANUAL",
    note: null,
    createdBy: null,
    createdAt: "2026-09-18T09:00:00.000Z",
    removedAt: null,
    ...overrides,
  };
}

describe("the reason maps", () => {
  it("are total over SuppressionReason — no screen prints a raw enum member", () => {
    for (const reason of SUPPRESSION_REASONS) {
      expect(SUPPRESSION_REASON_LABELS[reason], reason).toBeTypeOf("string");
      expect(SUPPRESSION_REASON_HELP[reason], reason).toBeTypeOf("string");
      expect(SUPPRESSION_REASON_HELP[reason].length, reason).toBeGreaterThan(20);
      expect(SUPPRESSION_REASON_VARIANTS[reason], reason).toBeTypeOf("string");
    }
  });

  it("gives the two reasons the desk did not choose the destructive weight", () => {
    expect(SUPPRESSION_REASON_VARIANTS.HARD_BOUNCE).toBe("destructive");
    expect(SUPPRESSION_REASON_VARIANTS.COMPLAINT).toBe("destructive");
    expect(SUPPRESSION_REASON_VARIANTS.MANUAL).not.toBe("destructive");
  });

  it("never describes suppression as blocking inbound mail", () => {
    for (const reason of SUPPRESSION_REASONS) {
      expect(SUPPRESSION_REASON_HELP[reason].toLowerCase(), reason).not.toContain("block");
    }
  });
});

describe("suppressionState", () => {
  it("is live while removedAt is null and lifted afterwards", () => {
    expect(suppressionState(row())).toBe("live");
    expect(suppressionState(row({ removedAt: "2026-09-19T09:00:00.000Z" }))).toBe("lifted");
  });

  it("has a label for both states, and neither says 'deleted'", () => {
    for (const state of ["live", "lifted"] as const) {
      expect(SUPPRESSION_STATE_LABELS[state]).toBeTypeOf("string");
      expect(SUPPRESSION_STATE_LABELS[state].toLowerCase()).not.toContain("delet");
    }
  });
});

describe("shortAddress", () => {
  it("leaves a short address alone", () => {
    expect(shortAddress("a@b.test")).toBe("a@b.test");
  });

  it("keeps BOTH ends — the local part is who, the domain is which firm", () => {
    const long = `${"m".repeat(40)}@fastmail.test`;
    const short = shortAddress(long);
    expect(short.length).toBeLessThanOrEqual(35);
    expect(short.startsWith("mmm")).toBe(true);
    expect(short.endsWith("@fastmail.test")).toBe(true);
  });

  it("tolerates a value with no @ at all", () => {
    const short = shortAddress("x".repeat(60));
    expect(short.length).toBeLessThanOrEqual(35);
    expect(short.endsWith("…")).toBe(true);
  });
});

describe("bounceCountLabel", () => {
  it("agrees with itself on the singular", () => {
    expect(bounceCountLabel(1)).toBe("1 hard bounce");
    expect(bounceCountLabel(0)).toBe("0 hard bounces");
    expect(bounceCountLabel(4)).toBe("4 hard bounces");
  });
});

describe("the lift-reason floor", () => {
  it("matches the wave's recorded-reason floor", () => {
    expect(LIFT_REASON_MIN).toBe(12);
  });
});
