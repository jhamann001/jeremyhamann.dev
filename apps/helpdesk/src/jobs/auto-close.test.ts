/**
 * Auto-close — the pure half.
 *
 * `cutoffFor` is one line, and it is the line the whole job turns on: get it wrong by a factor of 60
 * and the desk closes a fortnight of correspondence in an afternoon. The DB-gated file next door
 * proves the query's refusals (an outstanding follow-up, a status that is not RESOLVED).
 */
import { describe, expect, it } from "vitest";
import { AUTO_CLOSE_MAX_PER_RUN, autoCloseDedupeKey, cutoffFor } from "@/jobs/auto-close";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

describe("cutoffFor", () => {
  it("is exactly N calendar days before now", () => {
    expect(cutoffFor(NOW, 14).getTime()).toBe(NOW.getTime() - 14 * DAY);
    expect(cutoffFor(NOW, 1).getTime()).toBe(NOW.getTime() - DAY);
  });

  it("does not pause, shorten or round for weekends — the clocks in this app are 24x7 (§d)", () => {
    // A Friday-afternoon resolve with a 3-day window comes due on Monday afternoon, not Wednesday.
    const friday = new Date("2026-09-18T16:00:00.000Z");
    const monday = new Date("2026-09-21T16:00:00.000Z");
    expect(cutoffFor(monday, 3).getTime()).toBe(friday.getTime());
  });

  it("is minutes-accurate rather than date-truncated, so a run at 09:00 and one at 17:00 differ", () => {
    const morning = new Date("2026-09-20T09:00:00.000Z");
    expect(cutoffFor(NOW, 7).getTime() - cutoffFor(morning, 7).getTime()).toBe(3 * 60 * 60_000);
  });
});

describe("autoCloseDedupeKey", () => {
  it("carries the occurrence, so a reopened-and-reclosed ticket notifies a second time", () => {
    const first = autoCloseDedupeKey("t1", new Date("2026-09-20T12:00:00.000Z"));
    const second = autoCloseDedupeKey("t1", new Date("2026-10-04T12:00:00.000Z"));
    expect(first).toBe("auto-close:t1:2026-09-20");
    expect(second).toBe("auto-close:t1:2026-10-04");
    // The keys are permanent (Notification rows are never deleted and nothing prunes them), so two
    // closes that share a key would mean the second one told nobody.
    expect(first).not.toBe(second);
  });

  it("collapses a re-run on the same firm day, which is a repeat and not an event", () => {
    const morning = autoCloseDedupeKey("t1", new Date("2026-09-20T13:00:00.000Z"));
    const evening = autoCloseDedupeKey("t1", new Date("2026-09-20T23:00:00.000Z"));
    expect(morning).toBe(evening);
  });

  it("reads the firm clock, not UTC: 02:00 UTC is still the previous New York day", () => {
    expect(autoCloseDedupeKey("t1", new Date("2026-09-21T01:30:00.000Z"))).toBe("auto-close:t1:2026-09-20");
  });

  it("is per ticket", () => {
    const at = new Date("2026-09-20T12:00:00.000Z");
    expect(autoCloseDedupeKey("t1", at)).not.toBe(autoCloseDedupeKey("t2", at));
  });

  it("declines to collapse an unreadable instant rather than inventing a key", () => {
    expect(autoCloseDedupeKey("t1", new Date(Number.NaN))).toBeNull();
  });
});

describe("the per-run bound", () => {
  it("is finite, so a first run over a long backlog closes in batches", () => {
    expect(AUTO_CLOSE_MAX_PER_RUN).toBeGreaterThan(0);
    expect(Number.isInteger(AUTO_CLOSE_MAX_PER_RUN)).toBe(true);
  });
});
