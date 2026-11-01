import { describe, expect, it } from "vitest";
import {
  FIRM_TIME_ZONE,
  FIRM_TIME_ZONE_LABEL,
  firmDateTimeLocalToIso,
  firmInstant,
  firmWallClock,
  formatFirmDate,
  formatFirmDateTime,
  isValidInstant,
  isoToFirmDateTimeLocal,
  startOfFirmDay,
} from "@/lib/firm-time";

/**
 * Every expectation here is written from a UTC instant (a "…Z" literal) or from explicit firm-zone
 * fields, never from `new Date(y, m, d)`. That is the point of the module: the answers must not move
 * when the process zone does, so the suite is run under two zones in CI notes (TZ=UTC and
 * TZ=Australia/Sydney) and asserts the same numbers in both.
 */

describe("firmWallClock", () => {
  it("reads an instant on the firm clock during daylight time (UTC-4)", () => {
    expect(firmWallClock("2026-09-19T18:30:00Z")).toEqual({
      year: 2026,
      month: 9,
      day: 19,
      hour: 14,
      minute: 30,
      second: 0,
    });
  });

  it("reads an instant on the firm clock during standard time (UTC-5)", () => {
    expect(firmWallClock("2026-01-15T18:30:00Z")).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 13,
      minute: 30,
      second: 0,
    });
  });

  it("puts a late-evening Eastern instant on the previous calendar day from UTC's point of view", () => {
    // 2026-09-20T01:00Z is still 2026-09-19 21:00 in New York.
    expect(firmWallClock("2026-09-20T01:00:00Z")).toMatchObject({ year: 2026, month: 9, day: 19, hour: 21 });
  });

  it("reports midnight as hour 0, never hour 24", () => {
    expect(firmWallClock("2026-09-19T04:00:00Z")).toMatchObject({ day: 19, hour: 0, minute: 0 });
  });

  it("returns null for an unreadable instant", () => {
    expect(firmWallClock("nonsense")).toBeNull();
    expect(firmWallClock(Number.NaN)).toBeNull();
    expect(firmWallClock(new Date(Number.NaN))).toBeNull();
  });
});

describe("firmInstant", () => {
  it("resolves a summer wall-clock time at UTC-4", () => {
    expect(firmInstant(2026, 9, 19, 14, 30).toISOString()).toBe("2026-09-19T18:30:00.000Z");
  });

  it("resolves a winter wall-clock time at UTC-5", () => {
    expect(firmInstant(2026, 1, 15, 13, 30).toISOString()).toBe("2026-01-15T18:30:00.000Z");
  });

  it("round-trips through firmWallClock for both offsets", () => {
    for (const fields of [
      { year: 2026, month: 7, day: 4, hour: 9, minute: 5 },
      { year: 2026, month: 12, day: 31, hour: 23, minute: 59 },
    ]) {
      const at = firmInstant(fields.year, fields.month, fields.day, fields.hour, fields.minute);
      expect(firmWallClock(at)).toMatchObject({ ...fields, second: 0 });
    }
  });

  it("maps a skipped spring-forward hour forward instead of inventing an impossible instant", () => {
    // 2026-03-08 02:30 does not exist in New York; the clock jumps 02:00 → 03:00.
    const at = firmInstant(2026, 3, 8, 2, 30);
    expect(firmWallClock(at)).toMatchObject({ month: 3, day: 8, hour: 3, minute: 30 });
  });

  it("takes the first occurrence of a repeated fall-back hour (EDT, UTC-4)", () => {
    // 2026-11-01 01:30 happens twice; the earlier one is 05:30Z, the later 06:30Z.
    expect(firmInstant(2026, 11, 1, 1, 30).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("startOfFirmDay", () => {
  it("is the firm zone's midnight, not the process zone's", () => {
    expect(startOfFirmDay(new Date("2026-09-19T18:30:00Z")).toISOString()).toBe("2026-09-19T04:00:00.000Z");
  });

  it("still belongs to the previous firm day for an instant between Eastern midnight and UTC midnight", () => {
    // 2026-09-20T02:00Z is 2026-09-19 22:00 ET: the day started at 04:00Z on the 19th.
    expect(startOfFirmDay(new Date("2026-09-20T02:00:00Z")).toISOString()).toBe("2026-09-19T04:00:00.000Z");
  });

  it("uses the standard-time offset in winter", () => {
    expect(startOfFirmDay(new Date("2026-01-15T18:30:00Z")).toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("lands exactly on midnight of the same firm date", () => {
    const now = new Date("2026-06-15T23:45:00Z");
    const start = startOfFirmDay(now);
    expect(firmWallClock(start)).toMatchObject({ ...{ year: 2026, month: 6, day: 15 }, hour: 0, minute: 0, second: 0 });
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("formatFirmDateTime", () => {
  it("prints the firm-clock reading with an explicit zone label", () => {
    expect(formatFirmDateTime("2026-09-19T18:30:00Z")).toBe("Sep 19, 2026 14:30 ET");
    expect(formatFirmDateTime("2026-01-15T18:30:00Z")).toBe("Jan 15, 2026 13:30 ET");
  });

  it("accepts a Date as well as an ISO string and agrees with itself", () => {
    const iso = "2026-03-02T15:05:00Z";
    expect(formatFirmDateTime(new Date(iso))).toBe(formatFirmDateTime(iso));
  });

  it("pads the hour and minute and never pads the day", () => {
    expect(formatFirmDateTime("2026-07-04T13:05:00Z")).toBe("Jul 4, 2026 09:05 ET");
  });

  it("returns an em dash for an unreadable instant", () => {
    expect(formatFirmDateTime("nope")).toBe("—");
  });

  it("names the zone the module pins", () => {
    expect(FIRM_TIME_ZONE).toBe("America/New_York");
    expect(FIRM_TIME_ZONE_LABEL).toBe("ET");
  });
});

describe("formatFirmDate", () => {
  it("prints the firm-clock date without a time", () => {
    expect(formatFirmDate("2026-09-20T01:00:00Z")).toBe("Sep 19, 2026");
  });

  it("returns an em dash for an unreadable instant", () => {
    expect(formatFirmDate("")).toBe("—");
  });
});

describe("datetime-local conversions", () => {
  it("round-trips a firm wall-clock value", () => {
    const iso = firmDateTimeLocalToIso("2026-09-19T14:30");
    expect(iso).toBe("2026-09-19T18:30:00.000Z");
    expect(isoToFirmDateTimeLocal(iso)).toBe("2026-09-19T14:30");
  });

  it("shows the same wall clock the badge prints", () => {
    const iso = firmDateTimeLocalToIso("2026-09-22T14:30");
    expect(formatFirmDateTime(iso ?? "")).toBe("Sep 22, 2026 14:30 ET");
    expect(isoToFirmDateTimeLocal(iso)).toBe("2026-09-22T14:30");
  });

  it("accepts an optional seconds component the picker may emit", () => {
    expect(isoToFirmDateTimeLocal(firmDateTimeLocalToIso("2026-09-19T14:30:00"))).toBe("2026-09-19T14:30");
  });

  it("pads single-digit months, days, hours and minutes", () => {
    expect(isoToFirmDateTimeLocal(firmDateTimeLocalToIso("2026-01-02T03:04"))).toBe("2026-01-02T03:04");
  });

  it("round-trips across both offsets", () => {
    for (const value of ["2026-01-15T08:00", "2026-07-15T08:00", "2026-11-01T00:30", "2026-12-31T23:59"]) {
      expect(isoToFirmDateTimeLocal(firmDateTimeLocalToIso(value))).toBe(value);
    }
  });

  it("returns null for blank, malformed and impossible values", () => {
    expect(firmDateTimeLocalToIso("")).toBeNull();
    expect(firmDateTimeLocalToIso("2026-09-19")).toBeNull();
    expect(firmDateTimeLocalToIso("2026-02-31T10:00")).toBeNull();
    expect(firmDateTimeLocalToIso("2026-09-19T25:00")).toBeNull();
    expect(firmDateTimeLocalToIso("2026-13-01T10:00")).toBeNull();
  });

  it("accepts a DST-gap wall clock rather than rejecting the operator's input", () => {
    const iso = firmDateTimeLocalToIso("2026-03-08T02:30");
    expect(iso).not.toBeNull();
    // Normalised forward to the hour that exists, and the picker re-reads exactly that.
    expect(isoToFirmDateTimeLocal(iso)).toBe("2026-03-08T03:30");
  });

  it("returns an empty string for a missing or unparseable instant", () => {
    expect(isoToFirmDateTimeLocal(null)).toBe("");
    expect(isoToFirmDateTimeLocal(undefined)).toBe("");
    expect(isoToFirmDateTimeLocal("")).toBe("");
    expect(isoToFirmDateTimeLocal("nonsense")).toBe("");
  });
});

describe("isValidInstant", () => {
  it("separates readable instants from unreadable ones", () => {
    expect(isValidInstant("2026-09-19T18:30:00Z")).toBe(true);
    expect(isValidInstant(new Date("2026-09-19T18:30:00Z"))).toBe(true);
    expect(isValidInstant("nonsense")).toBe(false);
    expect(isValidInstant(Number.NaN)).toBe(false);
  });
});
