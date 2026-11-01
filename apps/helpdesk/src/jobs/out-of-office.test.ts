/**
 * Out-of-office reassignment — the pure half.
 *
 * `backupIsUsable` is the whole of the "never chain, never hand work to somebody who cannot do it"
 * rule, and every branch of it is a way a ticket could end up looking assigned while nobody is
 * working it. The DB-gated file next door proves the query and the transaction.
 */
import { describe, expect, it } from "vitest";
import { MACHINE_ACTOR_EMAILS } from "@/server/users";
import { OUT_OF_OFFICE_MAX_MOVES_PER_RUN, backupIsUsable } from "@/jobs/out-of-office";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const ABSENT = "u_absent";

function backup(over: Partial<{ id: string; email: string; isActive: boolean; outOfOfficeUntil: Date | null }> = {}) {
  return {
    id: "u_backup",
    email: "backup@wm-helpdesk.local",
    isActive: true,
    outOfOfficeUntil: null,
    ...over,
  };
}

describe("backupIsUsable", () => {
  it("accepts an active colleague who is in the office", () => {
    expect(backupIsUsable(backup(), ABSENT, NOW)).toBe(true);
  });

  it("refuses a backup nobody named", () => {
    expect(backupIsUsable(undefined, ABSENT, NOW)).toBe(false);
  });

  it("refuses somebody as their own backup — the row the DB CHECK also refuses", () => {
    expect(backupIsUsable(backup({ id: ABSENT }), ABSENT, NOW)).toBe(false);
  });

  it("refuses a deactivated account, which cannot sign in to work the ticket", () => {
    expect(backupIsUsable(backup({ isActive: false }), ABSENT, NOW)).toBe(false);
  });

  it("refuses a backup who is themselves away — it never chains to a second hop", () => {
    expect(backupIsUsable(backup({ outOfOfficeUntil: new Date(NOW.getTime() + 60_000) }), ABSENT, NOW)).toBe(false);
  });

  it("accepts a backup whose own absence has ended", () => {
    expect(backupIsUsable(backup({ outOfOfficeUntil: new Date(NOW.getTime() - 60_000) }), ABSENT, NOW)).toBe(true);
  });

  it("treats the exact return instant as back at work, matching the `> now` read everywhere else", () => {
    expect(backupIsUsable(backup({ outOfOfficeUntil: NOW }), ABSENT, NOW)).toBe(true);
  });

  it("refuses every machine identity, whatever groups a future change might grant them", () => {
    for (const email of MACHINE_ACTOR_EMAILS) {
      expect(backupIsUsable(backup({ email }), ABSENT, NOW), email).toBe(false);
      expect(backupIsUsable(backup({ email: email.toUpperCase() }), ABSENT, NOW), email).toBe(false);
    }
  });
});

describe("the per-run bound", () => {
  it("is finite, so a firm-wide holiday cannot rewrite the whole board in one execution", () => {
    expect(OUT_OF_OFFICE_MAX_MOVES_PER_RUN).toBeGreaterThan(0);
    expect(Number.isInteger(OUT_OF_OFFICE_MAX_MOVES_PER_RUN)).toBe(true);
  });
});
