import { describe, expect, it } from "vitest";
import { normalizeDtccNumber, suggestDtccNumber } from "./dtcc-suggestion";

describe("DTC suggestion", () => {
  it("uses the custodian value when history agrees", () => {
    expect(suggestDtccNumber(
      [{ transferringContra: "Fidelity", dtccNumber: "0226" }],
      [{ name: "Fidelity", dtcNumber: "0226" }],
      "Fidelity"
    )).toMatchObject({ status: "suggested", dtccNumber: "0226", source: "custodian" });
  });

  it("learns from at least two matching historical values", () => {
    expect(suggestDtccNumber(
      [
        { transferringContra: "Schwab", dtccNumber: "0164" },
        { transferringContra: "Schwab", dtccNumber: "0164" },
      ],
      [],
      "Schwab"
    )).toMatchObject({ status: "suggested", dtccNumber: "0164", source: "history" });
  });

  it("leaves contradictory history for human review", () => {
    expect(suggestDtccNumber(
      [
        { transferringContra: "Example", dtccNumber: "0001" },
        { transferringContra: "Example", dtccNumber: "0002" },
      ],
      [],
      "Example"
    )).toMatchObject({ status: "ambiguous", dtccNumber: null });
  });

  it("does not learn from one historical row without a custodian value", () => {
    expect(suggestDtccNumber(
      [{ transferringContra: "Example", dtccNumber: "0001" }],
      [],
      "Example"
    )).toMatchObject({ status: "insufficient", dtccNumber: null });
  });

  it("normalizes leading zeros", () => {
    expect(normalizeDtccNumber("472")).toBe("0472");
    expect(normalizeDtccNumber("manual")).toBeNull();
  });
});
