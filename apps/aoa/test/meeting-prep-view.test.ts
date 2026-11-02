import { describe, expect, it } from "vitest";
import {
  MEETING_PREP_GENERATION_CAP,
  MEETING_PREP_NO_CLIENT_LINK_NOTE,
  canSaveMeetingPrepToPortrait,
  meetingPrepFailureLabel,
  meetingPrepRemaining,
  meetingPrepThrottled,
  prepAffordance,
  type MeetingPrepFailure,
} from "@/lib/data/meeting-prep-view";

// The PURE client-safe helpers behind the regeneration throttle and the failure
// toasts. The cap is an OWNER DECISION (2026-07-27, "allow 5-10" → 10, the
// generous end) — if it changes, it changes HERE and nowhere else.

describe("MEETING_PREP_GENERATION_CAP", () => {
  it("is the owner's chosen lifetime cap", () => {
    expect(MEETING_PREP_GENERATION_CAP).toBe(10);
  });
});

describe("meetingPrepThrottled", () => {
  it("is false below the cap", () => {
    for (const g of [0, 1, 5, MEETING_PREP_GENERATION_CAP - 1]) {
      expect(meetingPrepThrottled(g)).toBe(false);
    }
  });

  it("is true AT the cap (the 10th generation is the last one allowed)", () => {
    expect(meetingPrepThrottled(MEETING_PREP_GENERATION_CAP)).toBe(true);
  });

  it("is true OVER the cap (a row that somehow raced past it stays refused)", () => {
    expect(meetingPrepThrottled(MEETING_PREP_GENERATION_CAP + 1)).toBe(true);
    expect(meetingPrepThrottled(9_999)).toBe(true);
  });

  it("treats a missing count as a brand-new row (not throttled)", () => {
    expect(meetingPrepThrottled(null)).toBe(false);
    expect(meetingPrepThrottled(undefined)).toBe(false);
  });
});

describe("meetingPrepRemaining", () => {
  it("counts down from the cap and never goes negative", () => {
    expect(meetingPrepRemaining(null)).toBe(MEETING_PREP_GENERATION_CAP);
    expect(meetingPrepRemaining(1)).toBe(MEETING_PREP_GENERATION_CAP - 1);
    expect(meetingPrepRemaining(MEETING_PREP_GENERATION_CAP)).toBe(0);
    expect(meetingPrepRemaining(MEETING_PREP_GENERATION_CAP + 5)).toBe(0);
  });
});

describe("canSaveMeetingPrepToPortrait", () => {
  it("is true for a real client sf_id", () => {
    expect(canSaveMeetingPrepToPortrait("C-1")).toBe(true);
    expect(canSaveMeetingPrepToPortrait("003AAAAAAAAAAAAAAA")).toBe(true);
  });

  it("is false for an UNLINKED appointment — no portrait to attach to", () => {
    // Meeting.clientId is "" when mirror.appointment.client_sf_id is null (the
    // Priya-Raman seed case), and the readers may also hand back null/undefined.
    expect(canSaveMeetingPrepToPortrait("")).toBe(false);
    expect(canSaveMeetingPrepToPortrait("   ")).toBe(false);
    expect(canSaveMeetingPrepToPortrait(null)).toBe(false);
    expect(canSaveMeetingPrepToPortrait(undefined)).toBe(false);
  });
});

describe("MEETING_PREP_NO_CLIENT_LINK_NOTE", () => {
  it("is the SAME text the action refuses with, so the UI and server agree", () => {
    expect(meetingPrepFailureLabel("no_client_link")).toBe(
      MEETING_PREP_NO_CLIENT_LINK_NOTE,
    );
  });

  it("explains the cause rather than just saying no", () => {
    expect(MEETING_PREP_NO_CLIENT_LINK_NOTE).toMatch(/client record/i);
    expect(MEETING_PREP_NO_CLIENT_LINK_NOTE).toMatch(/portrait/i);
  });
});

describe("meetingPrepFailureLabel", () => {
  const ALL: MeetingPrepFailure[] = [
    "flag_off",
    "not_authorized",
    "not_found",
    "past_meeting",
    "throttled",
    "no_client_link",
    "write_failed",
    "config_error",
    "unauthorized",
    "model_not_found",
    "rate_limited",
    "upstream_error",
    "transport_error",
    "empty_response",
  ];

  it("has a non-empty label for every reason (total over the union)", () => {
    for (const r of ALL) {
      const label = meetingPrepFailureLabel(r);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("names the cap in the throttled message so the advisor knows why", () => {
    expect(meetingPrepFailureLabel("throttled")).toContain(
      String(MEETING_PREP_GENERATION_CAP),
    );
  });

  it("never leaks internals — no stack traces, SQL, model ids or env var names", () => {
    for (const r of ALL) {
      const label = meetingPrepFailureLabel(r);
      expect(label).not.toMatch(/gemini|vertex|postgres|prisma|select |Error:/i);
    }
  });
});

// --- Meetings-card action slot ------------------------------------------------
describe("prepAffordance", () => {
  it("offers the real button whenever AI prep is on, live or not", () => {
    expect(prepAffordance({ aiPrep: true, live: true })).toBe("interactive");
    expect(prepAffordance({ aiPrep: true, live: false })).toBe("interactive");
  });

  it("renders NOTHING for live appointments when AI prep is off", () => {
    // The regression this guards: the button used to render regardless of the
    // flag and opened the mockup panel over sf_id-keyed fixtures that a real
    // Slack-fed appointment never matches — a dead control in prod.
    expect(prepAffordance({ aiPrep: false, live: true })).toBe("none");
  });

  it("keeps the mockup fixture pill when AI prep is off and the card is preview", () => {
    expect(prepAffordance({ aiPrep: false, live: false })).toBe("pill");
  });
});
