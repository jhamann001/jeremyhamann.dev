import { describe, expect, it } from "vitest";
import {
  holidaysForYear,
  isHoliday,
  isTradingDay,
  mostRecentTradingDay,
  nextTradingDay,
  previousTradingDay,
  toDateStr,
  tradingDaysBetween,
} from "@/lib/market-calendar";

describe("market-calendar — 2026 NYSE holidays", () => {
  // Every observed 2026 closure, including the observed-shift (Jul 4 Sat → Jul 3)
  // and Good Friday (Apr 3). Each must be a holiday AND a non-trading day.
  const holidays2026: Array<[string, string]> = [
    ["2026-01-01", "New Year's Day"],
    ["2026-01-19", "MLK Day"],
    ["2026-02-16", "Washington's Birthday"],
    ["2026-04-03", "Good Friday"],
    ["2026-05-25", "Memorial Day"],
    ["2026-06-19", "Juneteenth"],
    ["2026-07-03", "Independence Day (observed, Jul 4 is Sat)"],
    ["2026-09-07", "Labor Day"],
    ["2026-11-26", "Thanksgiving"],
    ["2026-12-25", "Christmas"],
  ];

  it.each(holidays2026)("%s (%s) is a holiday and not a trading day", (d) => {
    expect(isHoliday(d)).toBe(true);
    expect(isTradingDay(d)).toBe(false);
  });

  it("the actual Jul 4 2026 (a Saturday) is a non-trading weekend, not the observed holiday", () => {
    expect(isHoliday("2026-07-04")).toBe(false); // observance moved to Jul 3
    expect(isTradingDay("2026-07-04")).toBe(false); // still a weekend
  });

  it("returns the NYSE-published closure count for each supported year", () => {
    for (const [year, count] of [[2025, 10], [2026, 10], [2027, 10], [2028, 9]]) {
      expect(holidaysForYear(year)).toHaveLength(count);
    }
  });

  it("throws for an unsupported year so a lapsed table fails loud", () => {
    expect(() => holidaysForYear(2029)).toThrow(/no NYSE holiday table for 2029/);
  });
});

describe("market-calendar — 2027 observed weekend shifts", () => {
  it("Juneteenth (Jun 19 Sat) observed Fri Jun 18", () => {
    expect(isHoliday("2027-06-18")).toBe(true);
    expect(isHoliday("2027-06-19")).toBe(false);
  });
  it("Independence Day (Jul 4 Sun) observed Mon Jul 5", () => {
    expect(isHoliday("2027-07-05")).toBe(true);
  });
  it("Christmas (Dec 25 Sat) observed Fri Dec 24", () => {
    expect(isHoliday("2027-12-24")).toBe(true);
  });
});

describe("market-calendar — 2028 official NYSE closures", () => {
  const holidays2028 = [
    "2028-01-17",
    "2028-02-21",
    "2028-04-14",
    "2028-05-29",
    "2028-06-19",
    "2028-07-04",
    "2028-09-04",
    "2028-11-23",
    "2028-12-25",
  ];

  it.each(holidays2028)("%s is a holiday and not a trading day", (date) => {
    expect(isHoliday(date)).toBe(true);
    expect(isTradingDay(date)).toBe(false);
  });

  it("does not invent an observed New Year closure for Saturday January 1", () => {
    expect(isHoliday("2028-01-01")).toBe(false);
    expect(isTradingDay("2028-01-01")).toBe(false);
    expect(previousTradingDay("2028-01-03")).toBe("2027-12-31");
  });
});

describe("market-calendar — trading-day helpers", () => {
  it("normal Tue → Mon is T-1", () => {
    // Tue 2026-07-07 → Mon 2026-07-06 (both trading days).
    expect(previousTradingDay("2026-07-07")).toBe("2026-07-06");
  });

  it("Monday → previous Friday is the T-3 (calendar) case", () => {
    // Mon 2026-07-13 → Fri 2026-07-10 (steps back over Sat/Sun).
    expect(previousTradingDay("2026-07-13")).toBe("2026-07-10");
  });

  it("maps a trade date to the next NYSE run date", () => {
    expect(nextTradingDay("2026-09-02")).toBe("2026-09-03");
    expect(nextTradingDay("2026-09-04")).toBe("2026-09-08");
  });

  it("day after Thanksgiving steps back over the Thursday holiday", () => {
    // Fri 2026-11-27 (half day, still trading) → prev trading skips Thu Nov 26
    // (Thanksgiving) to Wed Nov 25.
    expect(previousTradingDay("2026-11-27")).toBe("2026-11-25");
  });

  it("day after July 4th steps back over the observed holiday + weekend", () => {
    // Mon 2026-07-06 → prev trading skips Sun/Sat and observed Jul 3 to Thu Jul 2.
    expect(previousTradingDay("2026-07-06")).toBe("2026-07-02");
  });

  it("mostRecentTradingDay returns d when d is a trading day", () => {
    expect(mostRecentTradingDay("2026-07-06")).toBe("2026-07-06");
  });

  it("mostRecentTradingDay steps back on a weekend/holiday", () => {
    // Sat 2026-07-04 → Thu 2026-07-02 (Fri Jul 3 is the observed holiday).
    expect(mostRecentTradingDay("2026-07-04")).toBe("2026-07-02");
  });

  it("isTradingDay is false on weekends, true on a normal weekday", () => {
    expect(isTradingDay("2026-07-04")).toBe(false); // Sat
    expect(isTradingDay("2026-07-05")).toBe(false); // Sun
    expect(isTradingDay("2026-07-06")).toBe(true); // Mon
  });
});

describe("market-calendar — tradingDaysBetween", () => {
  it("counts trading days in (start, end] and skips holidays/weekends", () => {
    // (2026-07-01 Wed, 2026-07-06 Mon]: Jul 2 Thu(1), Jul 3 hol, Jul 4/5 wknd,
    // Jul 6 Mon(2) → 2.
    expect(tradingDaysBetween("2026-07-01", "2026-07-06")).toBe(2);
  });
  it("is 0 when end <= start", () => {
    expect(tradingDaysBetween("2026-07-06", "2026-07-06")).toBe(0);
    expect(tradingDaysBetween("2026-07-07", "2026-07-06")).toBe(0);
  });
  it("one trading day for adjacent trading days", () => {
    expect(tradingDaysBetween("2026-07-06", "2026-07-07")).toBe(1);
  });
});

describe("market-calendar — toDateStr (ET projection)", () => {
  it("passes through a valid YYYY-MM-DD string", () => {
    expect(toDateStr("2026-07-10")).toBe("2026-07-10");
  });
  it("rejects a malformed string", () => {
    expect(() => toDateStr("07/10/2026")).toThrow();
  });
  it("projects an instant onto the ET calendar date", () => {
    // Noon UTC on Jul 10 = 8am ET → same day.
    expect(toDateStr(new Date("2026-07-10T12:00:00Z"))).toBe("2026-07-10");
    // 02:00 UTC on Jul 10 = 22:00 ET on Jul 9 (prev day, DST -4).
    expect(toDateStr(new Date("2026-07-10T02:00:00Z"))).toBe("2026-07-09");
  });
});

describe("market-calendar — fails LOUD past the maintained table (never silent)", () => {
  // The runtime trading-day fns must THROW for an out-of-table year so the
  // freshness route maps it to a 500 (alertable) — NOT silently treat that
  // year's holidays as trading days and mis-fire the monitor.
  it("isTradingDay throws for an unsupported year", () => {
    expect(() => isTradingDay("2029-01-16")).toThrow(/no NYSE holiday table for 2029/);
  });
  it("previousTradingDay throws for an unsupported input year", () => {
    expect(() => previousTradingDay("2029-01-16")).toThrow(/2029/);
    // Even the Jan-1 edge (walk lands in supported 2028) must reject the input year.
    expect(() => previousTradingDay("2029-01-01")).toThrow(/2029/);
  });
  it("mostRecentTradingDay throws for an unsupported year", () => {
    expect(() => mostRecentTradingDay("2029-03-10")).toThrow(/2029/);
  });

  it("keeps two future calendar years ready for the annual maintenance check", () => {
    const currentEtYear = Number(toDateStr(new Date()).slice(0, 4));
    expect(() => holidaysForYear(currentEtYear + 2)).not.toThrow();
  });
});
