import { describe, it, expect } from "vitest";
import { usd, usdFromCents } from "@/lib/format";

describe("usd", () => {
  it("formats whole-dollar USD with thousands separators", () => {
    expect(usd(2450000)).toBe("$2,450,000");
    expect(usd(0)).toBe("$0");
    expect(usd(1180000)).toBe("$1,180,000");
  });

  it("rounds to whole dollars (no cents)", () => {
    expect(usd(875000.49)).toBe("$875,000");
    expect(usd(875000.5)).toBe("$875,001");
  });

  it("renders an em dash for nullish values", () => {
    expect(usd(null)).toBe("—");
    expect(usd(undefined)).toBe("—");
  });

  it("coerces non-number numerics that leak past the Postgres seam", () => {
    // $queryRaw hands `numeric` back as a Decimal-like object or string at
    // runtime — the original bug rendered "2450000 AUM" because
    // String.prototype.toLocaleString ignores currency options.
    expect(usd("2450000" as unknown as number)).toBe("$2,450,000");
    expect(usd({ toString: () => "3320000" } as unknown as number)).toBe(
      "$3,320,000",
    );
  });
});

describe("usdFromCents", () => {
  it("formats integer cents as penny-precise dollars (tracker parity)", () => {
    // Matches the Transfer Tracker's formatCentsExact(cents) exactly, so an amount
    // reads identically in both apps. 14723390 cents = $147,233.90 — the value
    // that regressed to "$14,723,390" when rendered as whole dollars.
    expect(usdFromCents(14723390)).toBe("$147,233.90");
    expect(usdFromCents(5467768)).toBe("$54,677.68");
    expect(usdFromCents(100000)).toBe("$1,000.00");
    expect(usdFromCents(0)).toBe("$0.00");
  });

  it("keeps the sign for negative amounts (ACAT-out residuals)", () => {
    expect(usdFromCents(-14723390)).toBe("-$147,233.90");
  });

  it("renders an em dash for nullish values", () => {
    expect(usdFromCents(null)).toBe("—");
    expect(usdFromCents(undefined)).toBe("—");
  });
});
