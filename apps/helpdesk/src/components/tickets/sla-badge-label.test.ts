/**
 * S4 — SlaBadge wording (docs/ARCHITECTURE.md §d badge mapping).
 *
 * `SlaBadge` itself is JSX and is NOT imported here: the frozen `vitest.config.ts` does not override
 * tsconfig's `jsx: "preserve"`, so vitest cannot load a file containing JSX syntax (see
 * `markdown-renderer.tsx`). The badge's visible text, aria-label and tooltip lines all come from the pure
 * `sla-badge-label.ts` helpers pinned below; the §d classes are untouched constants in `sla-badge.tsx`.
 */
import { describe, expect, it } from "vitest";
import type { SlaTimerFields } from "@/types/domain";
import { formatDuration } from "@/lib/format";
import { computeSlaStatus } from "@/lib/sla";
import { sentenceCase, slaBadgeAriaLabel, slaBadgeLabel, slaCompleteDetail } from "@/components/tickets/sla-badge-label";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function timers(overrides: Partial<SlaTimerFields> = {}): SlaTimerFields {
  return {
    firstResponseDueAt: at(HOUR),
    resolutionDueAt: at(8 * HOUR),
    firstRespondedAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

/** HD-12 shape: resolved 9h before the resolution deadline, first response 4h late → COMPLETE / BREACHED. */
const LATE_FIRST_RESPONSE = timers({
  firstResponseDueAt: at(-20 * HOUR),
  resolutionDueAt: at(4 * HOUR),
  firstRespondedAt: at(-16 * HOUR),
  resolvedAt: at(-5 * HOUR),
});

/** Both clocks met with time to spare → COMPLETE / MET. */
const MET = timers({
  firstResponseDueAt: at(-20 * HOUR),
  resolutionDueAt: at(4 * HOUR),
  firstRespondedAt: at(-21 * HOUR - 5 * MIN),
  resolvedAt: at(-5 * HOUR),
});

describe("slaBadgeLabel — §d mapping", () => {
  it("live phases: status · remaining time (or just the time when compact)", () => {
    const onTrack = computeSlaStatus(timers({ firstResponseDueAt: at(HOUR + 12 * MIN) }), NOW);
    expect(slaBadgeLabel(onTrack)).toBe("On track · 1h 12m");
    expect(slaBadgeLabel(onTrack, true)).toBe("1h 12m");
    const warning = computeSlaStatus(timers({ firstResponseDueAt: at(18 * MIN) }), NOW);
    expect(slaBadgeLabel(warning)).toBe("Warning · 18m");
    const breached = computeSlaStatus(timers({ firstResponseDueAt: at(-23 * MIN) }), NOW);
    expect(slaBadgeLabel(breached)).toBe("Breached · -23m");
    const resolutionClock = computeSlaStatus(timers({ firstRespondedAt: at(-10 * MIN), resolutionDueAt: at(2 * HOUR) }), NOW);
    expect(resolutionClock.phase).toBe("RESOLUTION");
    expect(slaBadgeLabel(resolutionClock)).toBe("On track · 2h");
  });

  it("COMPLETE: a bare verdict — 'Met' / 'Breached' with NO duration (F5: 'Breached · 9h' read as a contradiction)", () => {
    const breached = computeSlaStatus(LATE_FIRST_RESPONSE, NOW);
    expect(breached).toMatchObject({ phase: "COMPLETE", status: "BREACHED", remainingMs: 9 * HOUR, firstResponseMet: false, resolutionMet: true });
    expect(slaBadgeLabel(breached)).toBe("Breached");
    expect(slaBadgeLabel(breached, true)).toBe("Breached");
    expect(slaBadgeLabel(breached)).not.toContain("·");

    const met = computeSlaStatus(MET, NOW);
    expect(met).toMatchObject({ phase: "COMPLETE", status: "MET" });
    expect(slaBadgeLabel(met)).toBe("Met");
    expect(slaBadgeLabel(met, true)).toBe("Met");
  });

  it("aria-label mirrors the visible text: remaining time on live phases only", () => {
    expect(slaBadgeAriaLabel(computeSlaStatus(timers({ firstResponseDueAt: at(HOUR + 12 * MIN) }), NOW))).toBe("SLA On track, 1h 12m");
    expect(slaBadgeAriaLabel(computeSlaStatus(LATE_FIRST_RESPONSE, NOW))).toBe("SLA Breached");
    expect(slaBadgeAriaLabel(computeSlaStatus(MET, NOW))).toBe("SLA Met");
  });
});

describe("slaCompleteDetail — tooltip deltas for the COMPLETE phase", () => {
  it("is null for live phases", () => {
    expect(slaCompleteDetail(timers(), computeSlaStatus(timers(), NOW))).toBeNull();
    const t = timers({ firstRespondedAt: at(-10 * MIN) });
    expect(slaCompleteDetail(t, computeSlaStatus(t, NOW))).toBeNull();
  });

  it("HD-12 shape: 'resolved 9h before the resolution deadline' + 'first response missed by 4h'", () => {
    const d = slaCompleteDetail(LATE_FIRST_RESPONSE, computeSlaStatus(LATE_FIRST_RESPONSE, NOW));
    expect(d).toEqual({
      resolution: "resolved 9h before the resolution deadline",
      firstResponse: "first response missed by 4h",
    });
  });

  it("MET shape: both clocks with time to spare", () => {
    const d = slaCompleteDetail(MET, computeSlaStatus(MET, NOW));
    expect(d).toEqual({
      resolution: "resolved 9h before the resolution deadline",
      firstResponse: "first response 1h 5m before its deadline",
    });
  });

  it("late resolution reads 'resolution missed by …'", () => {
    const t = timers({ firstResponseDueAt: at(-3 * HOUR), resolutionDueAt: at(-2 * HOUR), firstRespondedAt: at(-4 * HOUR), resolvedAt: at(-HOUR - 37 * MIN) });
    const e = computeSlaStatus(t, NOW);
    expect(e.status).toBe("BREACHED");
    expect(slaCompleteDetail(t, e)).toEqual({
      resolution: "resolution missed by 23m",
      firstResponse: "first response 1h before its deadline",
    });
  });

  it("resolved without a public reply counts the first response at resolution (§d) and says so", () => {
    const t = timers({ firstResponseDueAt: at(-3 * HOUR), resolutionDueAt: at(HOUR), firstRespondedAt: null, resolvedAt: at(-2 * HOUR) });
    const e = computeSlaStatus(t, NOW);
    expect(e).toMatchObject({ phase: "COMPLETE", status: "BREACHED", firstResponseMet: false, resolutionMet: true });
    expect(slaCompleteDetail(t, e)).toEqual({
      resolution: "resolved 3h before the resolution deadline",
      firstResponse: "first response missed by 1h (no public reply — counted at resolution)",
    });
  });

  it("uses the same duration formatter as the live badge", () => {
    expect(formatDuration(9 * HOUR)).toBe("9h");
    expect(sentenceCase("resolved 9h before the resolution deadline")).toBe("Resolved 9h before the resolution deadline");
    expect(sentenceCase("")).toBe("");
  });
});
