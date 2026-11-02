import { describe, expect, it } from "vitest";
import { freezeWindowRefusal, inMorningWindow, morningRelease, newYorkTime } from "@/lib/trade-requests/cutover-clock";

// 2026 daylight-saving changes in America/New_York: Sunday 2026-03-08 (EST -> EDT) and Sunday 2026-11-01 (EDT -> EST).
const at = (iso: string) => new Date(iso);

describe("America/New_York cutover clock", () => {
  it("reads EST and EDT wall time on both sides of each daylight-saving change", () => {
    expect(newYorkTime(at("2026-03-06T12:30:00Z"))).toMatchObject({ date: "2026-03-06", weekday: 5, minuteOfDay: 7 * 60 + 30 });
    expect(newYorkTime(at("2026-03-09T11:30:00Z"))).toMatchObject({ date: "2026-03-09", weekday: 1, minuteOfDay: 7 * 60 + 30 });
    expect(newYorkTime(at("2026-10-30T11:30:00Z"))).toMatchObject({ date: "2026-10-30", weekday: 5, minuteOfDay: 7 * 60 + 30 });
    expect(newYorkTime(at("2026-11-02T12:30:00Z"))).toMatchObject({ date: "2026-11-02", weekday: 1, minuteOfDay: 7 * 60 + 30 });
  });

  it("opens the morning window at 07:30:00 and closes it at 10:00:00 local time in EDT and in EST", () => {
    // Monday after spring-forward (EDT, UTC-4).
    expect(inMorningWindow(at("2026-03-09T11:29:59Z"))).toBe(false);
    expect(inMorningWindow(at("2026-03-09T11:30:00Z"))).toBe(true);
    expect(inMorningWindow(at("2026-03-09T13:59:59Z"))).toBe(true);
    expect(inMorningWindow(at("2026-03-09T14:00:00Z"))).toBe(false);
    // Monday after fall-back (EST, UTC-5).
    expect(inMorningWindow(at("2026-11-02T12:29:59Z"))).toBe(false);
    expect(inMorningWindow(at("2026-11-02T12:30:00Z"))).toBe(true);
    expect(inMorningWindow(at("2026-11-02T14:59:59Z"))).toBe(true);
    expect(inMorningWindow(at("2026-11-02T15:00:00Z"))).toBe(false);
  });

  it("has no morning window on weekends, including both change Sundays", () => {
    expect(inMorningWindow(at("2026-03-08T12:30:00Z"))).toBe(false);
    expect(inMorningWindow(at("2026-11-01T13:30:00Z"))).toBe(false);
    expect(inMorningWindow(at("2026-10-17T12:30:00Z"))).toBe(false);
  });

  it("refuses a freeze whose 60-minute window reaches 07:30 and allows one that ends a second before", () => {
    // Tuesday 2026-10-20 is EDT: 06:30:00 local = 10:30:00Z.
    expect(freezeWindowRefusal(at("2026-10-20T10:30:00Z"))).toMatch(/07:30-10:00/);
    expect(freezeWindowRefusal(at("2026-10-20T10:29:59Z"))).toBeNull();
    // Starting inside the window, or at 09:59, is refused; 10:00:00 is allowed.
    expect(freezeWindowRefusal(at("2026-10-20T12:00:00Z"))).not.toBeNull();
    expect(freezeWindowRefusal(at("2026-10-20T13:59:00Z"))).not.toBeNull();
    expect(freezeWindowRefusal(at("2026-10-20T14:00:00Z"))).toBeNull();
  });

  it("applies the freeze rule in EST after fall-back and ignores weekends", () => {
    // Monday 2026-11-02 is EST: 06:45 local = 11:45Z (window reaches 07:45) is refused; 05:00 local is allowed.
    expect(freezeWindowRefusal(at("2026-11-02T11:45:00Z"))).not.toBeNull();
    expect(freezeWindowRefusal(at("2026-11-02T10:00:00Z"))).toBeNull();
    // Sunday 2026-11-01 08:00 EST.
    expect(freezeWindowRefusal(at("2026-11-01T13:00:00Z"))).toBeNull();
  });

  it("releases the morning hold at exactly 10:00 local in EDT and in EST, and not outside the window", () => {
    expect(morningRelease(at("2026-03-09T12:00:00Z"))?.toISOString()).toBe("2026-03-09T14:00:00.000Z");
    expect(morningRelease(at("2026-11-02T13:17:45.250Z"))?.toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(morningRelease(at("2026-11-02T15:00:00Z"))).toBeNull();
    expect(morningRelease(at("2026-11-01T13:00:00Z"))).toBeNull();
  });
});
