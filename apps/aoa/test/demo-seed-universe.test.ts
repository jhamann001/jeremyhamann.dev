// The demo seed's shared ground: the universe's ids (the ones the other demos give the same records, and the CRM's
// own id shape AoA keys on) and the firm's calendar every seeded date sits on. Pure: no database.
import { describe, expect, it } from "vitest";
import { CEDAR_RIDGE_USER_ID_RE } from "@/lib/ingest/validate";
import {
  addBusinessDays, businessDayOnOrBefore, businessDaysBetween, firmToday, isFirmBusinessDay, newYorkOffsetHours, pastBusinessInstant,
} from "@/lib/demo/seed/calendar";
import { createSeedContext } from "@/lib/demo/seed/context";
import {
  accountUlid, cedarRidgeUserId, crmId, demoUuid, householdIds, loadUniverse, personIds, staffSfId, storyDealId,
  storyTrackerId, storyTradeRequestId, storyTransferId,
} from "@/lib/demo/seed/universe";

const universe = loadUniverse();

/** Folds an 18-character CRM id back to its 15-character form using its case checksum (the CRM's own rule). */
function checksumHolds(id: string): boolean {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  return [0, 1, 2].every((chunk) => {
    const bits = alphabet.indexOf(id[15 + chunk]);
    return [0, 1, 2, 3, 4].every((i) => /[A-Z]/.test(id[chunk * 5 + i]) === ((bits & (1 << i)) !== 0));
  });
}

describe("the demo's ids", () => {
  it("gives every household and person a distinct CRM id in the CRM's 18-character form", () => {
    const households = [...householdIds(universe).values()];
    const people = [...personIds(universe).values()];
    expect(new Set(households).size).toBe(universe.households.length);
    expect(new Set(people).size).toBe(universe.people.length);
    for (const id of [...households, ...people]) {
      expect(id).toMatch(/^00[13][A-Za-z0-9]{15}$/);
      expect(checksumHolds(id)).toBe(true);
    }
    expect(householdIds(universe).get("alvarez")).toBe(crmId("001", 1001));
    expect(staffSfId(universe, "rachel-moss")).toMatch(/^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/);
  });

  it("gives people the Transfer Tracker demo's client ids and accounts the clearing firm's", () => {
    for (const p of universe.people) expect(cedarRidgeUserId(p.id)).toMatch(CEDAR_RIDGE_USER_ID_RE);
    const ulids = universe.accounts.map((a) => accountUlid(a.id));
    expect(new Set(ulids).size).toBe(universe.accounts.length);
    for (const id of ulids) expect(id).toMatch(/^01SYNTH[0-9A-HJKMNP-TV-Z]{19}$/);
  });

  it("names a story's records the way the other demos do", () => {
    expect(storyTransferId("T-298")).toMatch(/^c[0-9a-z]{24}$/);
    expect(storyTransferId("T-298")).not.toBe(storyTransferId("T-299"));
    expect(storyTrackerId("T-298")).toBe("tr-t298");
    expect(storyDealId("T-298")).toBe(crmId("006", 1298));
    expect(storyTradeRequestId("TR-1045")).toBe("REQ-00001045");
    expect(demoUuid("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(demoUuid("a")).toBe(demoUuid("a"));
    expect(demoUuid("a")).not.toBe(demoUuid("b"));
  });
});

describe("the firm's calendar", () => {
  it("counts ACATS business days, skipping weekends and market holidays", () => {
    expect(isFirmBusinessDay("2026-10-31")).toBe(false); // Saturday
    expect(isFirmBusinessDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(isFirmBusinessDay("2026-10-12")).toBe(true); // Columbus Day stays an ACATS day
    expect(businessDayOnOrBefore("2026-11-01")).toBe("2026-10-30");
    expect(addBusinessDays("2026-11-25", 1)).toBe("2026-11-27");
    expect(addBusinessDays("2026-11-02", -1)).toBe("2026-10-30");
    expect(businessDaysBetween("2026-10-30", "2026-11-03")).toBe(2);
  });

  it("anchors the seed on New York's business day and never dates history after the seed's clock", () => {
    const before = new Date("2026-11-02T11:00:00Z"); // 6 AM in New York, before the working day
    expect(firmToday(before)).toBe("2026-11-02");
    for (let i = 0; i < 50; i++) {
      expect(pastBusinessInstant("2026-11-02", `k${i}`, before).getTime()).toBeLessThanOrEqual(before.getTime());
    }
    // Outside daylight saving New York midnight is 05:00 UTC: the 07:00 UTC reset's "today" stays on today in
    // New York, in summer and in winter.
    for (const [day, now, midnight] of [
      ["2026-11-02", "2026-11-02T07:00:00Z", "2026-11-02T05:00:00Z"],
      ["2026-07-06", "2026-07-06T07:00:00Z", "2026-07-06T04:00:00Z"],
    ] as const) {
      for (let i = 0; i < 50; i++) {
        const at = pastBusinessInstant(day, `k${i}`, new Date(now)).getTime();
        expect(at, `${day} k${i}`).toBeGreaterThanOrEqual(Date.parse(midnight));
        expect(at, `${day} k${i}`).toBeLessThanOrEqual(Date.parse(now));
      }
    }
    expect(newYorkOffsetHours("2026-11-02")).toBe(5);
    expect(newYorkOffsetHours("2026-11-01")).toBe(5); // the switch day itself
    expect(newYorkOffsetHours("2026-10-31")).toBe(4);
    const ctx = createSeedContext(universe, {} as never, {} as never, new Date("2026-10-31T16:00:00Z"));
    expect(ctx.today).toBe("2026-10-30"); // a Saturday seed sits on Friday
    expect(ctx.householdId.get("okafor")).toBe(crmId("001", 1002));
  });
});
