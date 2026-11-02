import { describe, expect, it } from "vitest";
import { usdCompact } from "@/lib/format";

describe("usdCompact", () => {
  it("abbreviates millions with trimmed decimals", () => {
    expect(usdCompact(2450000)).toBe("$2.45M");
    expect(usdCompact(2000000)).toBe("$2M");
    expect(usdCompact(2100000)).toBe("$2.1M");
    expect(usdCompact(1620000)).toBe("$1.62M");
  });

  it("abbreviates thousands to whole K", () => {
    expect(usdCompact(486000)).toBe("$486K");
    expect(usdCompact(84500)).toBe("$85K");
    expect(usdCompact(1000)).toBe("$1K");
  });

  it("falls back to whole-dollar usd under $1,000", () => {
    expect(usdCompact(980)).toBe("$980");
    expect(usdCompact(0)).toBe("$0");
  });

  it("keeps the sign on negative values", () => {
    expect(usdCompact(-14000)).toBe("-$14K");
    expect(usdCompact(-2450000)).toBe("-$2.45M");
  });

  it("renders nullish as an em dash", () => {
    expect(usdCompact(null)).toBe("—");
    expect(usdCompact(undefined)).toBe("—");
  });

  it("guards Decimal/string leakage like usd()", () => {
    expect(usdCompact("2450000" as unknown as number)).toBe("$2.45M");
  });
});
