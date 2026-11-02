import { describe, expect, it } from "vitest";
import { tradeProfileReviewStartsOpen } from "@/components/client-portrait/trade-profile-review-state";

describe("tradeProfileReviewStartsOpen", () => {
  it("collapses when every reviewable account has a confirmed source", () => {
    expect(
      tradeProfileReviewStartsOpen([
        { selection: { state: "confirmed" } },
        { selection: { state: "confirmed" } },
      ]),
    ).toBe(false);
  });

  it.each([null, { state: "stale" as const }, { state: "unavailable" as const }])(
    "opens when an account still requires attention (%o)",
    (selection) => {
      expect(tradeProfileReviewStartsOpen([{ selection }])).toBe(true);
    },
  );
});
