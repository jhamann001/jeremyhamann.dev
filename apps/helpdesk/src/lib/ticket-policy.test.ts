/**
 * Ticket status / priority policy (§g S2 tests).
 */
import { describe, expect, it } from "vitest";
import { ALLOWED_STATUS_TRANSITIONS, OPEN_STATUSES, TICKET_PRIORITIES, TICKET_STATUSES } from "@/types/domain";
import type { TicketStatus } from "@/types/domain";
import { allowedTransitions, canTransition, isOpenStatus, isTerminalStatus, priorityRank } from "@/lib/ticket-policy";

/** §b.6, copied by hand. */
const EXPECTED: Record<TicketStatus, TicketStatus[]> = {
  NEW: ["OPEN", "PENDING_CLIENT", "PENDING_INTERNAL", "RESOLVED"],
  OPEN: ["PENDING_CLIENT", "PENDING_INTERNAL", "RESOLVED"],
  PENDING_CLIENT: ["OPEN", "RESOLVED"],
  PENDING_INTERNAL: ["OPEN", "RESOLVED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
  // VOIDED is a key with no edges IN and no edges OUT. `voidTicket` writes the
  // transition itself — ops_team, a recorded reason, refused once a PUBLIC reply exists — so putting
  // it in this table would hand every holder of `queue:write` a one-click way to empty the board.
  VOIDED: [],
};

describe("canTransition (§b.6 state machine)", () => {
  for (const from of TICKET_STATUSES) {
    for (const to of TICKET_STATUSES) {
      const allowed = EXPECTED[from].includes(to);
      it(`${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, () => {
        expect(canTransition(from, to)).toBe(allowed);
      });
    }
  }

  it("agrees with ALLOWED_STATUS_TRANSITIONS and never allows a self-transition", () => {
    for (const from of TICKET_STATUSES) {
      expect(canTransition(from, from)).toBe(false);
      for (const to of TICKET_STATUSES) {
        expect(canTransition(from, to)).toBe(ALLOWED_STATUS_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("CLOSED is reachable only from RESOLVED; NEW is reachable from nothing", () => {
    for (const from of TICKET_STATUSES) {
      expect(canTransition(from, "CLOSED")).toBe(from === "RESOLVED");
      expect(canTransition(from, "NEW")).toBe(false);
    }
  });
});

describe("allowedTransitions", () => {
  it("returns the §b.6 list for every status", () => {
    for (const from of TICKET_STATUSES) expect(allowedTransitions(from)).toEqual(EXPECTED[from]);
  });

  it("returns a copy — mutating it does not touch the frozen table", () => {
    const list = allowedTransitions("NEW");
    list.push("CLOSED");
    expect(allowedTransitions("NEW")).toEqual(EXPECTED.NEW);
    expect(ALLOWED_STATUS_TRANSITIONS.NEW).toEqual(EXPECTED.NEW);
    expect(canTransition("NEW", "CLOSED")).toBe(false);
  });

  it("CLOSED has no transitions (terminal, §b.9)", () => {
    expect(allowedTransitions("CLOSED")).toEqual([]);
  });
});

describe("isTerminalStatus / isOpenStatus", () => {
  it("CLOSED and VOIDED are the terminal statuses, and nothing else is", () => {
    // VOIDED is terminal for a stronger reason than CLOSED. A closed ticket can still be
    // continued — a requester reply opens a NEW ticket linked back to it — whereas a
    // voided ticket is asserted never to have happened, so nothing transitions out of it and nothing
    // transitions into it through the state machine either.
    for (const s of TICKET_STATUSES) expect(isTerminalStatus(s)).toBe(s === "CLOSED" || s === "VOIDED");
  });

  it("open statuses are exactly OPEN_STATUSES; RESOLVED and CLOSED are not open", () => {
    for (const s of TICKET_STATUSES) {
      expect(isOpenStatus(s)).toBe((OPEN_STATUSES as readonly TicketStatus[]).includes(s));
    }
    expect(isOpenStatus("NEW")).toBe(true);
    expect(isOpenStatus("OPEN")).toBe(true);
    expect(isOpenStatus("PENDING_CLIENT")).toBe(true);
    expect(isOpenStatus("PENDING_INTERNAL")).toBe(true);
    expect(isOpenStatus("RESOLVED")).toBe(false);
    expect(isOpenStatus("CLOSED")).toBe(false);
  });

  it("every status is open, resolved or terminal — no status falls through", () => {
    for (const s of TICKET_STATUSES) {
      expect(isOpenStatus(s) || s === "RESOLVED" || isTerminalStatus(s)).toBe(true);
    }
  });
});

describe("priorityRank", () => {
  it("is the index in TICKET_PRIORITIES (URGENT 0 … LOW 3)", () => {
    expect(priorityRank("URGENT")).toBe(0);
    expect(priorityRank("HIGH")).toBe(1);
    expect(priorityRank("STANDARD")).toBe(2);
    expect(priorityRank("LOW")).toBe(3);
    for (const p of TICKET_PRIORITIES) expect(priorityRank(p)).toBe(TICKET_PRIORITIES.indexOf(p));
  });

  it("sorts most-urgent first when used as a comparator key", () => {
    const shuffled = ["LOW", "STANDARD", "URGENT", "HIGH"] as const;
    expect([...shuffled].sort((a, b) => priorityRank(a) - priorityRank(b))).toEqual([...TICKET_PRIORITIES]);
  });
});
