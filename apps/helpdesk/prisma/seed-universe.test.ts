import { describe, expect, it } from "vitest";
import { inStaffHours, loadUniverse, viewingStart } from "../src/lib/demo/universe";
import { DEFAULT_SLA_POLICIES, TICKET_CATEGORIES, TICKET_PRIORITIES } from "../src/types/domain";
import type { TicketPriority } from "../src/types/domain";
import { historyFixtures, placeForViewing, storyFixtures } from "./seed-universe";

const universe = loadUniverse();
const policies = new Map(TICKET_PRIORITIES.map((p): [TicketPriority, (typeof DEFAULT_SLA_POLICIES)[TicketPriority]] => [p, DEFAULT_SLA_POLICIES[p]]));
const now = new Date("2026-10-28T07:00:00Z");

describe("the story tickets", () => {
  const stories = storyFixtures(universe, now);

  it("carry the universe's numbers, subjects and requesters", () => {
    expect(stories.map((s) => s.number)).toEqual(universe.stories.helpdesk.map((s) => Number(s.id.slice(3))));
    for (const [i, s] of stories.entries()) {
      const story = universe.stories.helpdesk[i]!;
      expect(s.subject).toBe(story.subject);
      expect(s.requesterName).toBe(story.requester);
    }
  });

  it("link to the other demos' ids", () => {
    const refs = Object.fromEntries(stories.map((s) => [s.number, s.externalRef]));
    expect(refs[2479]).toBe("Trade request TR-1046");
    expect(refs[2465]).toBe("Transfer T-305 · control CTL-10433");
    expect(refs[2470]).toBe("Trade request TR-1038");
  });
});

describe("the history", () => {
  const history = historyFixtures(universe, now, policies);

  it("is about 150 finished tickets covering every category and every source", () => {
    expect(history).toHaveLength(150);
    expect(new Set(history.map((h) => h.status))).toEqual(new Set(["RESOLVED", "CLOSED"]));
    expect(new Set(history.map((h) => h.category))).toEqual(new Set(TICKET_CATEGORIES));
    expect(new Set(history.map((h) => h.source)).size).toBe(8);
  });

  it("has every reply in staff hours, before the reset", () => {
    for (const h of history) {
      const created = now.getTime() - h.createdMinAgo * 60_000;
      for (const c of h.comments) {
        expect(c.atMin).toBeLessThan(h.createdMinAgo);
        expect(inStaffHours(new Date(created + c.atMin * 60_000))).toBe(true);
      }
    }
  });
});

describe("placeForViewing", () => {
  it("moves an answered open ticket's resolution clock into the viewing day, inside staff hours", () => {
    const viewStart = viewingStart(now);
    const [placed] = placeForViewing(
      [
        {
          ref: "T-1",
          category: "OTHER",
          status: "OPEN",
          createdMinAgo: 30,
          createdById: "staff_helen",
          subject: "s",
          description: "d",
          requesterName: "Gwen Spencer",
          requesterEmail: "gwen.spencer@example.com",
          comments: [{ visibility: "PUBLIC", authorId: "staff_helen", atMin: 10, body: "Hello" }],
          expectSla: { phase: "RESOLUTION", status: "WARNING" },
        },
      ],
      { now, close: new Date("2026-10-27T21:30:00Z"), viewStart, policies },
    );
    const created = now.getTime() - placed!.createdMinAgo * 60_000;
    const due = created + DEFAULT_SLA_POLICIES.STANDARD.resolutionMinutes * 60_000;
    expect(placed!.slaAt).toBe("VIEW");
    expect(due - viewStart.getTime()).toBeGreaterThan(0);
    expect(due - viewStart.getTime()).toBeLessThan(30 * 60_000);
    expect(inStaffHours(new Date(created + 10 * 60_000))).toBe(true);
  });
});
