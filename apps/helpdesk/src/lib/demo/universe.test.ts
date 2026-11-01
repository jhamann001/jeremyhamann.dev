import { describe, expect, it } from "vitest";
import {
  MARKET_HOLIDAYS,
  addBusinessDays,
  firmDay,
  inStaffHours,
  isBusinessDay,
  lastDeskClose,
  loadUniverse,
  viewingStart,
  workingInstantBetween,
} from "./universe";

describe("the firm calendar", () => {
  it("skips weekends and market holidays", () => {
    expect(isBusinessDay("2026-10-28")).toBe(true);
    expect(isBusinessDay("2026-10-31")).toBe(false);
    expect(isBusinessDay("2026-11-26")).toBe(false);
    expect(addBusinessDays("2026-11-25", 1)).toBe("2026-11-27");
    expect(addBusinessDays("2026-11-02", -1)).toBe("2026-10-30");
  });

  it("lists holidays for next year, so the list is extended a year before it runs out", () => {
    const lastYear = Math.max(...[...MARKET_HOLIDAYS].map((d) => Number(d.slice(0, 4))));
    expect(lastYear).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 1);
  });

  it("looks for the first visitor at the next 9 a.m. in New York, or now during the working day", () => {
    expect(viewingStart(new Date("2026-10-28T07:00:00Z")).toISOString()).toBe("2026-10-28T13:00:00.000Z");
    expect(viewingStart(new Date("2026-10-28T18:00:00Z")).toISOString()).toBe("2026-10-28T18:00:00.000Z");
    expect(viewingStart(new Date("2026-10-28T23:00:00Z")).toISOString()).toBe("2026-10-29T13:00:00.000Z");
    // The morning after daylight saving ends: 9 a.m. is 14:00 UTC.
    expect(viewingStart(new Date("2026-11-01T07:00:00Z")).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("dates the desk's last working moment to the previous business day's close outside working hours", () => {
    expect(lastDeskClose(new Date("2026-10-28T07:00:00Z")).toISOString()).toBe("2026-10-27T21:30:00.000Z");
    expect(lastDeskClose(new Date("2026-10-28T18:00:00Z")).toISOString()).toBe("2026-10-28T18:00:00.000Z");
    expect(firmDay(lastDeskClose(new Date("2026-11-01T07:00:00Z")))).toBe("2026-10-30");
  });

  it("draws working instants inside staff hours on business days", () => {
    const from = new Date("2026-10-30T20:00:00Z"); // Friday 4 p.m. in New York
    const to = new Date("2026-11-03T20:00:00Z");
    for (let i = 0; i < 50; i++) {
      const at = workingInstantBetween(from, to, `t:${i}`);
      expect(at.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(at.getTime()).toBeLessThanOrEqual(to.getTime());
      expect(inStaffHours(at) && isBusinessDay(firmDay(at))).toBe(true);
    }
    // No working time in range: the next working minutes instead.
    const late = workingInstantBetween(new Date("2026-10-31T14:00:00Z"), new Date("2026-10-31T15:00:00Z"), "weekend");
    expect(firmDay(late)).toBe("2026-11-02");
  });
});

describe("the universe file", () => {
  it("has the eight help desk stories, each naming a person in its household", () => {
    const u = loadUniverse();
    expect(u.stories.helpdesk.map((s) => s.id).sort()).toEqual(
      ["HD-2463", "HD-2465", "HD-2468", "HD-2470", "HD-2474", "HD-2476", "HD-2479", "HD-2481"],
    );
    for (const s of u.stories.helpdesk) {
      expect(u.people.some((p) => p.household === s.household && `${p.first} ${p.last}` === s.requester)).toBe(true);
    }
  });
});
