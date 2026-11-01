import { describe, expect, it } from "vitest";
import {
  dateTimeLocalToIso,
  followUpState,
  isoToDateTimeLocal,
  ticketFlags,
  type TicketFlagFields,
} from "@/components/tickets/flag-state";

/**
 * Every instant here is a UTC literal, and every expectation is the answer on the FIRM clock
 * (America/New_York, src/lib/firm-time.ts) — never `new Date(y, m, d)`, which would re-introduce the
 * ambient zone this module exists to remove. The suite is run under TZ=UTC and under a far-away zone
 * (TZ=Australia/Sydney) and must produce identical results, because the badge and the dashboard's
 * Overdue filter render from different processes in different zones and have to agree.
 *
 * NOW = 2026-09-19 14:00 ET. The firm day started at 2026-09-19T04:00Z; UTC's day started five hours
 * earlier, and the browser's may start at yet another instant. Those three boundaries disagreeing is
 * exactly what the bug was.
 */
const NOW = new Date("2026-09-19T18:00:00Z");

const CLEAN: TicketFlagFields = {
  isComplaint: false,
  complaintFiledAt: null,
  escalationTarget: "NONE",
  followUpAt: null,
};

describe("followUpState", () => {
  it("is 'none' for null, empty and unparseable values", () => {
    expect(followUpState(null, NOW)).toBe("none");
    expect(followUpState(undefined, NOW)).toBe("none");
    expect(followUpState("", NOW)).toBe("none");
    expect(followUpState("not a date", NOW)).toBe("none");
  });

  it("is 'scheduled' for a future instant", () => {
    expect(followUpState("2026-09-20T03:30:00Z", NOW)).toBe("scheduled"); // 23:30 ET today
    expect(followUpState("2026-09-25T13:00:00Z", NOW)).toBe("scheduled");
  });

  it("is 'due' once the instant has passed but is still today on the firm clock", () => {
    expect(followUpState("2026-09-19T17:59:00Z", NOW)).toBe("due"); // 13:59 ET
    expect(followUpState("2026-09-19T04:00:00Z", NOW)).toBe("due"); // 00:00 ET, the boundary itself
  });

  it("is 'due' exactly at the instant (inclusive bound)", () => {
    expect(followUpState("2026-09-19T18:00:00Z", NOW)).toBe("due");
  });

  it("is 'overdue' strictly before the firm zone's midnight", () => {
    expect(followUpState("2026-09-19T03:59:00Z", NOW)).toBe("overdue"); // 23:59 ET yesterday
    expect(followUpState("2026-09-01T13:00:00Z", NOW)).toBe("overdue");
  });

  /**
   * The regression this module was rewritten for. Between the firm zone's midnight and UTC's, a
   * boundary read from the ambient clock answered differently in a UTC container than in an Eastern
   * browser: a 23:30 ET follow-up read "due" on one surface and "overdue" on the other, on one page.
   */
  it("gives one answer for an instant between Eastern midnight and UTC midnight", () => {
    const followUpAt = "2026-09-19T03:30:00Z"; // 23:30 ET on the 18th — yesterday's callback
    const duringTheDisputedWindow = [
      new Date("2026-09-19T04:30:00Z"), // 00:30 ET on the 19th (UTC still on the 19th's small hours)
      new Date("2026-09-19T12:00:00Z"), // 08:00 ET, desk open
      new Date("2026-09-20T01:00:00Z"), // 21:00 ET, still the 19th on the firm clock
    ];
    for (const now of duringTheDisputedWindow) {
      expect(followUpState(followUpAt, now), now.toISOString()).toBe("overdue");
    }
  });

  it("does not call today's earlier callback overdue just because UTC has rolled over", () => {
    // 2026-09-20T02:00Z is 22:00 ET on the 19th: UTC is already on the 20th, the firm clock is not.
    expect(followUpState("2026-09-19T13:00:00Z", new Date("2026-09-20T02:00:00Z"))).toBe("due");
  });

  it("uses the standard-time offset in winter", () => {
    const winterNow = new Date("2026-01-15T18:00:00Z"); // 13:00 ET
    expect(followUpState("2026-01-15T05:00:00Z", winterNow)).toBe("due"); // 00:00 ET
    expect(followUpState("2026-01-15T04:59:00Z", winterNow)).toBe("overdue"); // 23:59 ET on the 14th
  });
});

describe("ticketFlags", () => {
  it("returns nothing for a clean ticket", () => {
    expect(ticketFlags(CLEAN, { now: NOW })).toEqual([]);
  });

  it("orders complaint, then escalation, then follow-up", () => {
    const flags = ticketFlags(
      {
        isComplaint: true,
        complaintFiledAt: "2026-09-10T13:00:00Z",
        escalationTarget: "COMPLIANCE",
        followUpAt: "2026-09-01T13:00:00Z",
      },
      { now: NOW },
    );
    expect(flags.map((f) => f.key)).toEqual(["complaint", "escalated:COMPLIANCE", "follow-up:overdue"]);
    expect(flags.map((f) => f.tone)).toEqual(["complaint", "escalated", "followUpOverdue"]);
  });

  it("carries the filed instant on the complaint flag and never invents one", () => {
    const filed = "2026-09-10T13:00:00Z";
    expect(ticketFlags({ ...CLEAN, isComplaint: true, complaintFiledAt: filed }, { now: NOW })[0]?.at).toBe(filed);
    expect(ticketFlags({ ...CLEAN, isComplaint: true, complaintFiledAt: null }, { now: NOW })[0]?.at).toBeNull();
  });

  it("labels the escalation target with its display label, never the raw enum", () => {
    const [flag] = ticketFlags({ ...CLEAN, escalationTarget: "FRAUD" }, { now: NOW });
    expect(flag?.label).toBe("Escalated: Fraud");
    expect(flag?.at).toBeNull();
  });

  it("emits no flag for escalationTarget NONE", () => {
    expect(ticketFlags({ ...CLEAN, escalationTarget: "NONE" }, { now: NOW })).toEqual([]);
  });

  it("hides a scheduled follow-up in list mode and shows it when asked", () => {
    const future = { ...CLEAN, followUpAt: "2026-09-25T13:00:00Z" };
    expect(ticketFlags(future, { now: NOW })).toEqual([]);
    const shown = ticketFlags(future, { now: NOW, includeScheduledFollowUp: true });
    expect(shown.map((f) => f.key)).toEqual(["follow-up:scheduled"]);
    expect(shown[0]?.label).toBe("Follow-up");
  });

  it("shows a due follow-up in list mode without the opt-in", () => {
    const flags = ticketFlags({ ...CLEAN, followUpAt: "2026-09-19T12:00:00Z" }, { now: NOW });
    expect(flags.map((f) => f.key)).toEqual(["follow-up:due"]);
    expect(flags[0]?.label).toBe("Follow-up due");
  });

  it("never emits two follow-up flags at once", () => {
    const flags = ticketFlags(
      { ...CLEAN, followUpAt: "2026-09-01T13:00:00Z" },
      { now: NOW, includeScheduledFollowUp: true },
    );
    expect(flags.filter((f) => f.key.startsWith("follow-up"))).toHaveLength(1);
  });

  /**
   * The two surfaces that render a ticket's flags on one page — the server-rendered header and the
   * client-rendered properties panel — pass the same ticket and (bar render latency) the same instant.
   * Pinned to one instant they must produce byte-identical descriptors, whichever process evaluates
   * them: that identity is what makes "the header says due, the panel says overdue" impossible.
   */
  it("is a pure function of the ticket and the instant, so both surfaces derive the same badge", () => {
    const ticket: TicketFlagFields = {
      isComplaint: true,
      complaintFiledAt: "2026-09-10T13:00:00Z",
      escalationTarget: "COMPLIANCE",
      followUpAt: "2026-09-19T03:30:00Z",
    };
    const header = ticketFlags(ticket, { now: NOW, includeScheduledFollowUp: true });
    const panel = ticketFlags(ticket, { now: NOW, includeScheduledFollowUp: true });
    expect(panel).toEqual(header);
    expect(header.map((f) => f.key)).toEqual(["complaint", "escalated:COMPLIANCE", "follow-up:overdue"]);
  });
});

describe("datetime-local conversions", () => {
  it("round-trips a firm wall-clock value", () => {
    const iso = dateTimeLocalToIso("2026-09-19T14:30");
    expect(iso).toBe("2026-09-19T18:30:00.000Z");
    expect(isoToDateTimeLocal(iso)).toBe("2026-09-19T14:30");
  });

  /**
   * The picker and the badge above it must name one time. Before the firm clock, a 14:30 ET follow-up
   * printed "18:30" in a UTC-rendered header while the control three inches below still read "14:30".
   */
  it("shows the wall clock the badge prints, from either side of the boundary", () => {
    const iso = dateTimeLocalToIso("2026-09-22T14:30");
    expect(isoToDateTimeLocal(iso)).toBe("2026-09-22T14:30");
  });

  it("accepts an optional seconds component the picker may emit", () => {
    expect(isoToDateTimeLocal(dateTimeLocalToIso("2026-09-19T14:30:00"))).toBe("2026-09-19T14:30");
  });

  it("pads single-digit months, days, hours and minutes", () => {
    expect(isoToDateTimeLocal(dateTimeLocalToIso("2026-01-02T03:04"))).toBe("2026-01-02T03:04");
  });

  it("round-trips across both sides of the daylight-saving change", () => {
    for (const value of ["2026-01-15T08:00", "2026-07-15T08:00", "2026-12-31T23:59"]) {
      expect(isoToDateTimeLocal(dateTimeLocalToIso(value))).toBe(value);
    }
  });

  it("returns null for blank, malformed and impossible values", () => {
    expect(dateTimeLocalToIso("")).toBeNull();
    expect(dateTimeLocalToIso("2026-09-19")).toBeNull();
    expect(dateTimeLocalToIso("2026-02-31T10:00")).toBeNull();
    expect(dateTimeLocalToIso("2026-09-19T25:00")).toBeNull();
  });

  it("returns an empty string for a missing or unparseable instant", () => {
    expect(isoToDateTimeLocal(null)).toBe("");
    expect(isoToDateTimeLocal(undefined)).toBe("");
    expect(isoToDateTimeLocal("")).toBe("");
    expect(isoToDateTimeLocal("nonsense")).toBe("");
  });
});
