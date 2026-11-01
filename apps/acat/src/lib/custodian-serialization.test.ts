import { describe, expect, it } from "vitest";
import { toCustodianResponse } from "./custodian-serialization";

describe("toCustodianResponse", () => {
  it("removes the retired manual-review field without mutating the source", () => {
    const source = {
      id: "cust-1",
      name: "Victory Funds",
      requiresManualReview: false,
      transferType: "MANUAL",
    };

    expect(toCustodianResponse(source)).toEqual({
      id: "cust-1",
      name: "Victory Funds",
      transferType: "MANUAL",
    });
    expect(source.requiresManualReview).toBe(false);
  });
});
