import { describe, expect, it } from "vitest";
import { DEFAULT_SLA_POLICIES, SLA_WARNING_THRESHOLD_MS, TICKET_PRIORITIES } from "@/types/domain";
import type { SlaTimerFields } from "@/types/domain";
import {
  DEFAULT_WARNING_MINUTES,
  computeDueDates,
  computeSlaStatus,
  describeSlaPolicy,
  formatSlaMinutes,
  slaPolicyFor,
  slaPolicyWithWarningFor,
  slaWarningMs,
  toDate,
} from "@/lib/sla";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const MIN = 60_000;

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

function timers(overrides: Partial<SlaTimerFields> = {}): SlaTimerFields {
  return {
    firstResponseDueAt: at(60 * MIN),
    resolutionDueAt: at(8 * 60 * MIN),
    firstRespondedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe("computeSlaStatus — FIRST_RESPONSE phase", () => {
  it("ON_TRACK with the first-response clock live", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: at(2 * 60 * MIN) }), NOW);
    expect(r).toEqual({
      phase: "FIRST_RESPONSE",
      status: "ON_TRACK",
      dueAt: at(2 * 60 * MIN).toISOString(),
      remainingMs: 2 * 60 * MIN,
      firstResponseMet: null,
      resolutionMet: null,
      // Every evaluation now reports the band that produced it. With no policy passed
      // that is the historical 30 minutes and no name — stated here so a change to the default would
      // fail an exact-shape assertion rather than pass one that ignores the field.
      warningMinutes: 30,
      policyName: null,
    });
  });

  it("exactly 30 minutes remaining → ON_TRACK (strict threshold)", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: at(SLA_WARNING_THRESHOLD_MS) }), NOW);
    expect(r.status).toBe("ON_TRACK");
    expect(r.remainingMs).toBe(SLA_WARNING_THRESHOLD_MS);
  });

  it("29:59 remaining → WARNING", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: at(29 * MIN + 59_000) }), NOW);
    expect(r.status).toBe("WARNING");
    expect(r.remainingMs).toBe(29 * MIN + 59_000);
  });

  it("30 min minus 1 ms remaining → WARNING", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: at(SLA_WARNING_THRESHOLD_MS - 1) }), NOW);
    expect(r.status).toBe("WARNING");
  });

  it("exactly due (remaining 0) → WARNING", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: at(0) }), NOW);
    expect(r.status).toBe("WARNING");
    expect(r.remainingMs).toBe(0);
  });

  it("-1 ms → BREACHED", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: at(-1) }), NOW);
    expect(r.status).toBe("BREACHED");
    expect(r.remainingMs).toBe(-1);
    expect(r.phase).toBe("FIRST_RESPONSE");
  });
});

describe("computeSlaStatus — RESOLUTION phase", () => {
  it("first response on time → resolution clock, firstResponseMet true", () => {
    const r = computeSlaStatus(
      timers({ firstRespondedAt: at(-10 * MIN), firstResponseDueAt: at(-5 * MIN), resolutionDueAt: at(3 * 60 * MIN) }),
      NOW,
    );
    expect(r).toEqual({
      phase: "RESOLUTION",
      status: "ON_TRACK",
      dueAt: at(3 * 60 * MIN).toISOString(),
      remainingMs: 3 * 60 * MIN,
      firstResponseMet: true,
      resolutionMet: null,
      warningMinutes: 30,
      policyName: null,
    });
  });

  it("late first response with an open resolution clock shows the resolution timer with firstResponseMet false", () => {
    const r = computeSlaStatus(
      timers({ firstResponseDueAt: at(-30 * MIN), firstRespondedAt: at(-5 * MIN), resolutionDueAt: at(45 * MIN) }),
      NOW,
    );
    expect(r.phase).toBe("RESOLUTION");
    expect(r.status).toBe("ON_TRACK");
    expect(r.firstResponseMet).toBe(false);
    expect(r.resolutionMet).toBeNull();
    expect(r.remainingMs).toBe(45 * MIN);
  });

  it("resolution WARNING / due / BREACHED boundaries", () => {
    const base = { firstRespondedAt: at(-60 * MIN), firstResponseDueAt: at(-30 * MIN) };
    expect(computeSlaStatus(timers({ ...base, resolutionDueAt: at(SLA_WARNING_THRESHOLD_MS) }), NOW).status).toBe(
      "ON_TRACK",
    );
    expect(computeSlaStatus(timers({ ...base, resolutionDueAt: at(SLA_WARNING_THRESHOLD_MS - 1) }), NOW).status).toBe(
      "WARNING",
    );
    expect(computeSlaStatus(timers({ ...base, resolutionDueAt: at(0) }), NOW).status).toBe("WARNING");
    expect(computeSlaStatus(timers({ ...base, resolutionDueAt: at(-1) }), NOW).status).toBe("BREACHED");
  });
});

describe("computeSlaStatus — COMPLETE phase", () => {
  it("MET when both first response and resolution were on time", () => {
    const r = computeSlaStatus(
      timers({
        firstResponseDueAt: at(-6 * 60 * MIN),
        firstRespondedAt: at(-7 * 60 * MIN),
        resolutionDueAt: at(-1 * 60 * MIN),
        resolvedAt: at(-2 * 60 * MIN),
      }),
      NOW,
    );
    expect(r).toEqual({
      phase: "COMPLETE",
      status: "MET",
      dueAt: at(-60 * MIN).toISOString(),
      remainingMs: 60 * MIN,
      firstResponseMet: true,
      resolutionMet: true,
      // A COMPLETE verdict is decided by the two due dates, never by the band — but the band it was
      // computed with is still reported, so a reader is never left guessing which one applied.
      warningMinutes: 30,
      policyName: null,
    });
  });

  it("BREACHED when resolution was late even though first response was on time", () => {
    const r = computeSlaStatus(
      timers({
        firstResponseDueAt: at(-6 * 60 * MIN),
        firstRespondedAt: at(-7 * 60 * MIN),
        resolutionDueAt: at(-2 * 60 * MIN),
        resolvedAt: at(-1 * 60 * MIN),
      }),
      NOW,
    );
    expect(r.status).toBe("BREACHED");
    expect(r.firstResponseMet).toBe(true);
    expect(r.resolutionMet).toBe(false);
    expect(r.remainingMs).toBe(-60 * MIN);
  });

  it("BREACHED when first response was late even though resolution was on time (terminal verdict needs both)", () => {
    const r = computeSlaStatus(
      timers({
        firstResponseDueAt: at(-7 * 60 * MIN),
        firstRespondedAt: at(-6 * 60 * MIN),
        resolutionDueAt: at(-1 * 60 * MIN),
        resolvedAt: at(-2 * 60 * MIN),
      }),
      NOW,
    );
    expect(r.status).toBe("BREACHED");
    expect(r.firstResponseMet).toBe(false);
    expect(r.resolutionMet).toBe(true);
  });

  it("with no first response, resolvedAt stands in for the first-response verdict", () => {
    const met = computeSlaStatus(
      timers({ firstResponseDueAt: at(-1 * 60 * MIN), resolutionDueAt: at(60 * MIN), resolvedAt: at(-2 * 60 * MIN) }),
      NOW,
    );
    expect(met.status).toBe("MET");
    expect(met.firstResponseMet).toBe(true);

    const late = computeSlaStatus(
      timers({ firstResponseDueAt: at(-3 * 60 * MIN), resolutionDueAt: at(60 * MIN), resolvedAt: at(-2 * 60 * MIN) }),
      NOW,
    );
    expect(late.status).toBe("BREACHED");
    expect(late.firstResponseMet).toBe(false);
    expect(late.resolutionMet).toBe(true);
  });

  it("resolution exactly at the due instant counts as met", () => {
    const due = at(-60 * MIN);
    const r = computeSlaStatus(
      timers({ firstResponseDueAt: at(-2 * 60 * MIN), firstRespondedAt: at(-3 * 60 * MIN), resolutionDueAt: due, resolvedAt: due }),
      NOW,
    );
    expect(r.status).toBe("MET");
    expect(r.remainingMs).toBe(0);
  });

  it("COMPLETE ignores `now` entirely", () => {
    const t = timers({
      firstResponseDueAt: at(-6 * 60 * MIN),
      firstRespondedAt: at(-7 * 60 * MIN),
      resolutionDueAt: at(-1 * 60 * MIN),
      resolvedAt: at(-2 * 60 * MIN),
    });
    expect(computeSlaStatus(t, NOW)).toEqual(computeSlaStatus(t, at(365 * 24 * 60 * MIN)));
  });
});

describe("inputs", () => {
  it("accepts ISO strings and Dates interchangeably", () => {
    const asDates = timers({ firstResponseDueAt: at(45 * MIN) });
    const asStrings: SlaTimerFields = {
      firstResponseDueAt: toDate(asDates.firstResponseDueAt).toISOString(),
      resolutionDueAt: toDate(asDates.resolutionDueAt).toISOString(),
      firstRespondedAt: null,
      resolvedAt: null,
    };
    expect(computeSlaStatus(asStrings, NOW)).toEqual(computeSlaStatus(asDates, NOW));
  });

  it("defaults `now` to the current time", () => {
    const r = computeSlaStatus(timers({ firstResponseDueAt: new Date(Date.now() + 10 * 60 * MIN) }));
    expect(r.status).toBe("ON_TRACK");
  });

  it("toDate", () => {
    const d = new Date("2026-01-02T03:04:05.006Z");
    expect(toDate(d)).toBe(d);
    expect(toDate("2026-01-02T03:04:05.006Z").getTime()).toBe(d.getTime());
  });
});

describe("computeDueDates / slaPolicyFor", () => {
  it("stamps both due dates from createdAt for every default policy", () => {
    const createdAt = new Date("2026-09-16T09:30:00.000Z");
    for (const priority of TICKET_PRIORITIES) {
      const policy = DEFAULT_SLA_POLICIES[priority];
      const due = computeDueDates(createdAt, policy);
      expect(due.firstResponseDueAt.getTime()).toBe(createdAt.getTime() + policy.firstResponseMinutes * MIN);
      expect(due.resolutionDueAt.getTime()).toBe(createdAt.getTime() + policy.resolutionMinutes * MIN);
    }
    const urgent = computeDueDates(createdAt, DEFAULT_SLA_POLICIES.URGENT);
    expect(urgent.firstResponseDueAt.toISOString()).toBe("2026-09-16T10:00:00.000Z");
    expect(urgent.resolutionDueAt.toISOString()).toBe("2026-09-16T11:30:00.000Z");
  });

  it("slaPolicyFor prefers the row and falls back to the code default", () => {
    expect(slaPolicyFor("URGENT", { firstResponseMinutes: 15, resolutionMinutes: 90 })).toEqual({
      firstResponseMinutes: 15,
      resolutionMinutes: 90,
    });
    expect(slaPolicyFor("STANDARD", null)).toEqual({ firstResponseMinutes: 240, resolutionMinutes: 1440 });
    expect(slaPolicyFor("LOW", undefined)).toEqual({ firstResponseMinutes: 480, resolutionMinutes: 4320 });
    expect(slaPolicyFor("HIGH", undefined)).toEqual({ firstResponseMinutes: 60, resolutionMinutes: 480 });
  });
});

// ---------------------------------------------------------------------------
// the warning band is per-priority policy, read live
// ---------------------------------------------------------------------------

describe("warningMinutes", () => {
  it("defaults to the historical 30-minute constant when no policy is passed", () => {
    expect(DEFAULT_WARNING_MINUTES).toBe(30);
    expect(slaWarningMs(undefined)).toBe(SLA_WARNING_THRESHOLD_MS);
    expect(slaWarningMs(null)).toBe(SLA_WARNING_THRESHOLD_MS);
    expect(slaWarningMs({})).toBe(SLA_WARNING_THRESHOLD_MS);
  });

  it("widens the band: a 2-hour policy calls WARNING what the default calls ON_TRACK", () => {
    const t = timers({ firstResponseDueAt: at(90 * MIN) });
    expect(computeSlaStatus(t, NOW).status).toBe("ON_TRACK");
    expect(computeSlaStatus(t, NOW, { warningMinutes: 120 }).status).toBe("WARNING");
  });

  it("narrows the band: a 5-minute policy calls ON_TRACK what the default calls WARNING", () => {
    const t = timers({ firstResponseDueAt: at(20 * MIN) });
    expect(computeSlaStatus(t, NOW).status).toBe("WARNING");
    expect(computeSlaStatus(t, NOW, { warningMinutes: 5 }).status).toBe("ON_TRACK");
  });

  it("0 disables the band entirely — ON_TRACK until the instant it is overdue", () => {
    const policy = { warningMinutes: 0 };
    expect(computeSlaStatus(timers({ firstResponseDueAt: at(1) }), NOW, policy).status).toBe("ON_TRACK");
    expect(computeSlaStatus(timers({ firstResponseDueAt: at(0) }), NOW, policy).status).toBe("ON_TRACK");
    expect(computeSlaStatus(timers({ firstResponseDueAt: at(-1) }), NOW, policy).status).toBe("BREACHED");
  });

  it("keeps the boundary rule at the policy's own edge: exactly W → ON_TRACK, W-1ms → WARNING", () => {
    const policy = { warningMinutes: 45 };
    expect(computeSlaStatus(timers({ firstResponseDueAt: at(45 * MIN) }), NOW, policy).status).toBe("ON_TRACK");
    expect(computeSlaStatus(timers({ firstResponseDueAt: at(45 * MIN - 1) }), NOW, policy).status).toBe("WARNING");
  });

  it("applies to the RESOLUTION clock too, not only the first-response clock", () => {
    const t = timers({ firstRespondedAt: at(-10 * MIN), resolutionDueAt: at(50 * MIN) });
    expect(computeSlaStatus(t, NOW).status).toBe("ON_TRACK");
    expect(computeSlaStatus(t, NOW, { warningMinutes: 60 }).status).toBe("WARNING");
  });

  it("never changes a COMPLETE verdict — a closed clock has no warning band", () => {
    const t = timers({
      firstResponseDueAt: at(-3 * 60 * MIN),
      firstRespondedAt: at(-4 * 60 * MIN),
      resolutionDueAt: at(-1 * 60 * MIN),
      resolvedAt: at(-2 * 60 * MIN),
    });
    const noBand = computeSlaStatus(t, NOW, { warningMinutes: 0 });
    const wideBand = computeSlaStatus(t, NOW, { warningMinutes: 600 });

    // The VERDICT is identical: a closed clock is judged by its two due dates and nothing else.
    // Compared field by field rather than with a whole-object `toEqual`, because the two evaluations
    // are deliberately NOT identical any more — each one reports the band it was given, which is the
    // point of `warningMinutes` riding on the result. Asserting object equality here would force the
    // band to be dropped from a COMPLETE evaluation, and then the popover on a resolved ticket could
    // not say which policy was in force.
    for (const key of ["phase", "status", "dueAt", "remainingMs", "firstResponseMet", "resolutionMet"] as const) {
      expect(noBand[key], key).toEqual(wideBand[key]);
    }
    expect(noBand.status).toBe("MET");
    expect(noBand.warningMinutes).toBe(0);
    expect(wideBand.warningMinutes).toBe(600);
  });

  it("falls back to the default for a malformed or negative band rather than deleting the band", () => {
    const t = timers({ firstResponseDueAt: at(20 * MIN) });
    expect(computeSlaStatus(t, NOW, { warningMinutes: Number.NaN }).status).toBe("WARNING");
    expect(computeSlaStatus(t, NOW, { warningMinutes: -10 }).status).toBe("WARNING");
  });

  it("slaPolicyWithWarningFor carries the band, defaulting a row that has none", () => {
    for (const p of TICKET_PRIORITIES) {
      expect(slaPolicyWithWarningFor(p, null)).toEqual({
        firstResponseMinutes: DEFAULT_SLA_POLICIES[p].firstResponseMinutes,
        resolutionMinutes: DEFAULT_SLA_POLICIES[p].resolutionMinutes,
        warningMinutes: DEFAULT_WARNING_MINUTES,
      });
    }
    expect(
      slaPolicyWithWarningFor("URGENT", { firstResponseMinutes: 15, resolutionMinutes: 60, warningMinutes: 5 }),
    ).toEqual({ firstResponseMinutes: 15, resolutionMinutes: 60, warningMinutes: 5 });
  });
});

describe("policy rendering", () => {
  it("formatSlaMinutes is exact and compact", () => {
    expect(formatSlaMinutes(0)).toBe("0m");
    expect(formatSlaMinutes(45)).toBe("45m");
    expect(formatSlaMinutes(120)).toBe("2h");
    expect(formatSlaMinutes(150)).toBe("2h 30m");
    expect(formatSlaMinutes(1440)).toBe("1d");
    expect(formatSlaMinutes(4320)).toBe("3d");
    expect(formatSlaMinutes(2130)).toBe("1d 11h 30m");
  });

  it("describeSlaPolicy reads as a sentence, and says so when there is no warning band", () => {
    expect(describeSlaPolicy({ firstResponseMinutes: 30, resolutionMinutes: 120, warningMinutes: 30 })).toBe(
      "first response 30m · resolve 2h · warn 30m before due",
    );
    expect(describeSlaPolicy({ firstResponseMinutes: 30, resolutionMinutes: 120, warningMinutes: 0 })).toBe(
      "first response 30m · resolve 2h · no warning band",
    );
  });
});
