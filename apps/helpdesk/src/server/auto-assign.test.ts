/**
 * Auto-assignment selection — the pure half.
 *
 * `rankCandidates` is the whole policy: everything else in the module is the query that produces its
 * input. Testing it here means the rota's behaviour — including the parts that only show up on a tie —
 * is pinned without a database, and the DB-gated file next door only has to prove the query finds the
 * right people.
 */
import { describe, expect, it } from "vitest";
import { QUEUE_ACCESS } from "@/lib/rbac";
import { QUEUE_KEYS } from "@/types/domain";
import { pickFrom, rankCandidates, writingGroupsFor, type AutoAssignCandidate } from "@/server/auto-assign";

const T0 = new Date("2026-09-20T12:00:00.000Z");

function candidate(over: Partial<AutoAssignCandidate> & { id: string }): AutoAssignCandidate {
  return {
    email: `${over.id}@wm-helpdesk.local`,
    openAssignments: 0,
    lastAssignedAt: null,
    updatedAt: T0,
    ...over,
  };
}

function at(offsetMinutes: number): Date {
  return new Date(T0.getTime() + offsetMinutes * 60_000);
}

describe("writingGroupsFor", () => {
  it("is derived from the RBAC table rather than restated", () => {
    for (const q of QUEUE_KEYS) {
      const expected = (Object.keys(QUEUE_ACCESS) as Array<keyof typeof QUEUE_ACCESS>).filter(
        (g) => QUEUE_ACCESS[g][q] === "WRITE",
      );
      expect(writingGroupsFor(q).sort()).toEqual(expected.sort());
    }
  });

  it("names exactly the one operational group per queue the matrix grants WRITE to", () => {
    expect(writingGroupsFor("OPERATIONS")).toEqual(["ops_team"]);
    expect(writingGroupsFor("CLIENT_SERVICE")).toEqual(["client_services"]);
    expect(writingGroupsFor("ADVICE")).toEqual(["advisors"]);
  });

  it("never includes compliance_officers — read plus annotate is not the ability to work a ticket", () => {
    for (const q of QUEUE_KEYS) expect(writingGroupsFor(q)).not.toContain("compliance_officers");
  });
});

describe("rankCandidates", () => {
  it("puts the lightest load first, whatever the other fields say", () => {
    const ranked = rankCandidates([
      candidate({ id: "busy", openAssignments: 9, lastAssignedAt: null }),
      candidate({ id: "light", openAssignments: 1, lastAssignedAt: at(-1) }),
      candidate({ id: "idle", openAssignments: 0, lastAssignedAt: at(-1) }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["idle", "light", "busy"]);
  });

  it("breaks a tie on load with the least recently assigned — the round-robin", () => {
    const ranked = rankCandidates([
      candidate({ id: "just-had-one", openAssignments: 2, lastAssignedAt: at(-1) }),
      candidate({ id: "yesterday", openAssignments: 2, lastAssignedAt: at(-1440) }),
      candidate({ id: "an-hour-ago", openAssignments: 2, lastAssignedAt: at(-60) }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["yesterday", "an-hour-ago", "just-had-one"]);
  });

  it("treats 'never assigned in the lookback' as the oldest possible turn", () => {
    const ranked = rankCandidates([
      candidate({ id: "recent", openAssignments: 0, lastAssignedAt: at(-5) }),
      candidate({ id: "never", openAssignments: 0, lastAssignedAt: null }),
      candidate({ id: "old", openAssignments: 0, lastAssignedAt: at(-100_000) }),
    ]);
    expect(ranked[0].id).toBe("never");
  });

  it("falls back to the oldest User.updatedAt, then to the id, so the order is total", () => {
    const ranked = rankCandidates([
      candidate({ id: "b", updatedAt: at(-10) }),
      candidate({ id: "a", updatedAt: at(-10) }),
      candidate({ id: "c", updatedAt: at(-99) }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("is deterministic: the same input in any order produces the same winner", () => {
    const people = [
      candidate({ id: "p1", openAssignments: 3, lastAssignedAt: at(-10) }),
      candidate({ id: "p2", openAssignments: 1, lastAssignedAt: at(-1) }),
      candidate({ id: "p3", openAssignments: 1, lastAssignedAt: at(-2) }),
      candidate({ id: "p4", openAssignments: 1, lastAssignedAt: at(-2), updatedAt: at(-500) }),
    ];
    const winners = new Set<string | null>();
    for (const order of [people, [...people].reverse(), [people[2], people[0], people[3], people[1]]]) {
      winners.add(pickFrom(order));
    }
    expect([...winners]).toEqual(["p4"]);
  });

  it("does not mutate its input", () => {
    const people = [candidate({ id: "z", openAssignments: 5 }), candidate({ id: "a", openAssignments: 1 })];
    const before = people.map((p) => p.id);
    rankCandidates(people);
    expect(people.map((p) => p.id)).toEqual(before);
  });
});

describe("pickFrom", () => {
  it("returns null for an empty rota rather than inventing an assignee", () => {
    expect(pickFrom([])).toBeNull();
  });

  it("rotates: giving the winner a ticket moves the turn to the next person", () => {
    // One round of the rota, applied by hand exactly as `createTicketCore` would apply it.
    let people = [
      candidate({ id: "a", openAssignments: 0, lastAssignedAt: at(-30) }),
      candidate({ id: "b", openAssignments: 0, lastAssignedAt: at(-20) }),
      candidate({ id: "c", openAssignments: 0, lastAssignedAt: at(-10) }),
    ];
    const order: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      const winner = pickFrom(people);
      order.push(winner);
      people = people.map((p) =>
        p.id === winner ? { ...p, openAssignments: p.openAssignments + 1, lastAssignedAt: at(i) } : p,
      );
    }
    expect(order).toEqual(["a", "b", "c"]);
  });
});
