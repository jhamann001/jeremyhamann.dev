import { describe, expect, it } from "vitest";
import {
  formatDateMMDDYYYY,
  formatMoneyStringExact,
  normalizeDateToIso,
  normalizeMoneyStringExact,
  normalizeStatementAmountSign,
} from "./format";

describe("transfer display normalization", () => {
  it("formats parseable money with a dollar sign and cents", () => {
    expect(formatMoneyStringExact("50")).toBe("$50.00");
    expect(normalizeMoneyStringExact("$1,234.5")).toBe("$1,234.50");
  });

  it("makes outgoing statement amounts negative", () => {
    expect(normalizeStatementAmountSign(12345, "Out")).toBe(-12345);
    expect(normalizeStatementAmountSign(-12345, "Out")).toBe(-12345);
    expect(normalizeStatementAmountSign(12345, "In")).toBe(12345);
  });

  it("accepts legacy dates but displays every date as MM-DD-YYYY", () => {
    expect(normalizeDateToIso("8-6-2026")).toBe("2026-08-06");
    expect(formatDateMMDDYYYY("2026-08-06")).toBe("08-06-2026");
    expect(formatDateMMDDYYYY("08/06/2026")).toBe("08-06-2026");
  });

  it("rejects impossible dates", () => {
    expect(normalizeDateToIso("02-30-2026")).toBeNull();
  });
});
