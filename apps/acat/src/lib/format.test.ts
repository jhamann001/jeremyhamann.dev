import { describe, it, expect } from "vitest";
import { formatDollar, maskAccountNumber } from "./format";

describe("formatDollar", () => {
  it("formats values under $1,000 as raw dollars", () => {
    expect(formatDollar(0)).toBe("$0");
    expect(formatDollar(500)).toBe("$500");
    expect(formatDollar(999)).toBe("$999");
  });

  it("formats values in thousands with K suffix", () => {
    expect(formatDollar(1000)).toBe("$1K");
    expect(formatDollar(50000)).toBe("$50K");
    expect(formatDollar(268000)).toBe("$268K");
    expect(formatDollar(999999)).toBe("$1000K");
  });

  it("formats values in millions with M suffix", () => {
    expect(formatDollar(1_000_000)).toBe("$1.0M");
    expect(formatDollar(1_500_000)).toBe("$1.5M");
    expect(formatDollar(1_918_350)).toBe("$1.9M");
    expect(formatDollar(9_999_999)).toBe("$10.0M");
  });

  it("formats values >= 10M without decimal", () => {
    expect(formatDollar(10_000_000)).toBe("$10M");
    expect(formatDollar(12_500_000)).toBe("$13M");
    expect(formatDollar(100_000_000)).toBe("$100M");
  });

  it("rounds thousands correctly", () => {
    expect(formatDollar(1_499)).toBe("$1K");
    expect(formatDollar(1_500)).toBe("$2K");
    expect(formatDollar(95_200)).toBe("$95K");
    expect(formatDollar(354_200)).toBe("$354K");
  });

  it("places the sign in front of the dollar mark for negatives (ACAT Out)", () => {
    expect(formatDollar(-500)).toBe("-$500");
    expect(formatDollar(-50_000)).toBe("-$50K");
    expect(formatDollar(-1_500_000)).toBe("-$1.5M");
    expect(formatDollar(-12_500_000)).toBe("-$13M");
  });
});

describe("maskAccountNumber", () => {
  it("masks a value with dashes, preserving dash positions", () => {
    expect(maskAccountNumber("CRWD-001-DMPY000002")).toBe("••••-•••-••••••0002");
  });

  it("masks a value without dashes", () => {
    expect(maskAccountNumber("PIN10000098")).toBe("•••••••0098");
  });

  it("preserves dashes that fall within the visible last-4 region", () => {
    expect(maskAccountNumber("AB-1-2-34")).toBe("••-1-2-34");
  });

  it("returns the value as-is when exactly 4 characters", () => {
    expect(maskAccountNumber("ABCD")).toBe("ABCD");
  });

  it("returns the value as-is when fewer than 4 characters", () => {
    expect(maskAccountNumber("AB")).toBe("AB");
  });

  it("returns an empty string as-is", () => {
    expect(maskAccountNumber("")).toBe("");
  });
});
