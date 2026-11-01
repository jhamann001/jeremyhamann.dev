// @vitest-environment node

import { describe, expect, it } from "vitest";
import { USER_ID_PATTERN } from "../client-directory/source";
import {
  addBusinessDays,
  businessDayOnOrBefore,
  businessDaysBetween,
  businessInstant,
  clientUserId,
  firmToday,
  loadUniverse,
  pastBusinessInstant,
  staffEmail,
} from "./universe";

describe("demo universe helpers", () => {
  it("gives every universe person a stable directory id", () => {
    const universe = loadUniverse();
    const ids = universe.people.map((p) => clientUserId(p.id));
    expect(ids.every((id) => USER_ID_PATTERN.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(clientUserId(universe.people[0].id)).toBe(ids[0]);
  });

  it("counts New York market days, skipping weekends and holidays", () => {
    expect(addBusinessDays("2026-11-25", 1)).toBe("2026-11-27"); // Thanksgiving
    expect(addBusinessDays("2026-12-24", 1)).toBe("2026-12-28"); // Christmas, then the weekend
    expect(addBusinessDays("2026-12-28", -1)).toBe("2026-12-24");
    expect(businessDayOnOrBefore("2026-10-25")).toBe("2026-10-23"); // a Sunday
    expect(businessDaysBetween("2026-10-16", "2026-10-23")).toBe(5);
    for (const n of [1, 7, 30]) expect(businessDaysBetween("2026-06-01", addBusinessDays("2026-06-01", n))).toBe(n);
  });

  it("dates the firm's day in New York", () => {
    expect(firmToday(new Date("2026-10-27T03:30:00Z"))).toBe("2026-10-26");
    expect(firmToday(new Date("2026-10-27T07:00:00Z"))).toBe("2026-10-27");
  });

  it("keeps business instants at or before now, in order, when the reset runs before the working day", () => {
    const now = new Date("2026-10-27T06:00:00Z"); // 2 AM in New York
    expect(pastBusinessInstant("2026-10-26", "k1", now)).toEqual(businessInstant("2026-10-26", "k1"));
    const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
    const pairs = keys.map((k) => [businessInstant("2026-10-27", k).getTime(), pastBusinessInstant("2026-10-27", k, now).getTime()]);
    for (const [, clamped] of pairs) {
      expect(clamped).toBeLessThanOrEqual(now.getTime());
      expect(clamped).toBeGreaterThanOrEqual(Date.parse("2026-10-27T04:00:00Z"));
    }
    const byOriginal = [...pairs].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    expect(byOriginal).toEqual([...byOriginal].sort((a, b) => a - b));
    expect(pastBusinessInstant("2026-10-29", "k1", now).getTime()).toBe(now.getTime());
  });

  it("builds staff emails on the reserved example domain", () => {
    expect(staffEmail({ id: "jordan-reyes", name: "Jordan Reyes", role: "transfers", title: "" })).toBe("jordan.reyes@example.com");
  });
});
