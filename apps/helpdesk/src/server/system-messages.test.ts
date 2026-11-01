/**
 * Pure tests for the auto-acknowledgement source policy.
 *
 * `AUTO_ACK_SOURCES` had no test of its own. That mattered once Decision #117 added a SECOND
 * source-classification list (`REQUESTER_AUTHORED_SOURCES`), because only the second one was pinned
 * against `TICKET_SOURCES` — so a tenth `TicketSource` would have been forced through a decision about
 * the client's opening entry while silently defaulting to "sends no acknowledgement". Both lists are
 * now partitioned, and the one place they disagree is asserted rather than left to a reader to
 * reconcile against two adjacent doc tables.
 */
import { describe, expect, it } from "vitest";
import { REQUESTER_AUTHORED_SOURCES, TICKET_SOURCES } from "@/types/domain";
import { AUTO_ACK_SOURCES } from "@/server/system-messages";

describe("AUTO_ACK_SOURCES", () => {
  /** Written out, so a tenth source fails here instead of tracking the implementation. */
  const NO_ACK_SOURCES = ["STAFF_FORM", "PHONE", "SLACK", "SYSTEM", "IMPORT", "API"] as const;

  it("is exactly the three channels a requester creates a ticket on", () => {
    expect([...AUTO_ACK_SOURCES].sort()).toEqual(["CLIENT_APP", "EMAIL", "VOICEMAIL"]);
  });

  it("partitions TicketSource: a source added later is on neither list and fails here", () => {
    expect([...AUTO_ACK_SOURCES, ...NO_ACK_SOURCES].sort()).toEqual([...TICKET_SOURCES].sort());
    expect(new Set([...AUTO_ACK_SOURCES, ...NO_ACK_SOURCES]).size).toBe(TICKET_SOURCES.length);
  });

  it("differs from REQUESTER_AUTHORED_SOURCES on VOICEMAIL, and ONLY on VOICEMAIL", () => {
    // The two lists answer different questions — who CREATED the ticket vs who wrote the TEXT of
    // `description` — and VOICEMAIL is the one channel where those answers diverge: a real caller
    // left the message, but the stored field is a transcript wrapped in phone system metadata. Pinning the
    // difference here means a later edit to either list has to face the other one.
    const inAckOnly = AUTO_ACK_SOURCES.filter((s) => !(REQUESTER_AUTHORED_SOURCES as readonly string[]).includes(s));
    const inAuthoredOnly = REQUESTER_AUTHORED_SOURCES.filter((s) => !AUTO_ACK_SOURCES.includes(s));
    expect(inAckOnly).toEqual(["VOICEMAIL"]);
    expect(inAuthoredOnly).toEqual([]);
  });

  it("is frozen, so no caller can widen the policy at run time", () => {
    expect(Object.isFrozen(AUTO_ACK_SOURCES)).toBe(true);
  });
});
