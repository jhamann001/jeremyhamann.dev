/**
 * Follow-up nudges — the pure half.
 *
 * The two things worth pinning without a database are the DEDUPE KEY and the SLACK LINE.
 *
 * The key is a firm-local calendar date, and it is the reason the job can be run twice without
 * nudging twice. A UTC date would roll over at 19:00 or 20:00 New York time, so an evening run and a
 * morning run would disagree about which day a commitment belonged to and the desk would be nudged
 * twice for one date, every day, for the whole of the eastern evening.
 *
 * The line is text that would leave the building if a webhook were ever configured, so it is asserted
 * against `assertPiiLight` — the same mechanical backstop the SLA digest uses.
 */
import { describe, expect, it } from "vitest";
import { assertPiiLight, slackPayloadText } from "@/jobs/slack";
import {
  FOLLOW_UP_MAX_PER_RUN,
  FOLLOW_UP_STATUSES,
  firmDateKey,
  firmDaysBetween,
  followUpDigestLines,
  followUpNudgeLine,
  type FollowUpCandidate,
} from "@/jobs/follow-up-nudges";

function candidate(over: Partial<FollowUpCandidate> = {}): FollowUpCandidate {
  return {
    id: "t1",
    number: 1042,
    queueKey: "OPERATIONS",
    priority: "HIGH",
    followUpAt: new Date("2026-09-20T13:00:00.000Z"),
    dueOn: "2026-09-20",
    daysOverdue: 0,
    ...over,
  };
}

describe("firmDateKey", () => {
  it("reads the FIRM calendar date, not the container's", () => {
    // 01:30 UTC on 21 September is still the evening of the 20th in New York.
    expect(firmDateKey(new Date("2026-09-21T01:30:00.000Z"))).toBe("2026-09-20");
    // Midday UTC is the same day either way.
    expect(firmDateKey(new Date("2026-09-20T12:00:00.000Z"))).toBe("2026-09-20");
  });

  it("is stable across a whole firm day, so two runs in one day produce one key", () => {
    const keys = new Set<string | null>();
    // 00:05 to 23:05 New York on 2026-09-20 (EDT, UTC-4), i.e. 04:05 UTC onwards.
    const midnightNy = Date.UTC(2026, 8, 20, 4, 5);
    for (let hour = 0; hour < 24; hour++) {
      keys.add(firmDateKey(new Date(midnightNy + hour * 3_600_000)));
    }
    expect([...keys]).toEqual(["2026-09-20"]);
  });

  it("pads to YYYY-MM-DD so the keys sort lexicographically", () => {
    expect(firmDateKey(new Date("2026-01-02T17:00:00.000Z"))).toBe("2026-01-02");
  });

  it("returns null for an unreadable instant rather than throwing inside a job", () => {
    expect(firmDateKey(new Date(Number.NaN))).toBeNull();
  });
});

describe("firmDaysBetween", () => {
  it("counts calendar days on the firm clock, not elapsed 24-hour periods", () => {
    // 23:00 on the 19th to 01:00 on the 20th, New York: two hours, one day.
    const late = new Date("2026-09-20T03:00:00.000Z");
    const early = new Date("2026-09-20T05:00:00.000Z");
    expect(firmDaysBetween(late, early)).toBe(1);
  });

  it("is 0 for two instants on the same firm day", () => {
    expect(firmDaysBetween(new Date("2026-09-20T13:00:00.000Z"), new Date("2026-09-20T23:00:00.000Z"))).toBe(0);
  });

  it("is negative for a date still in the future", () => {
    expect(firmDaysBetween(new Date("2026-09-22T16:00:00.000Z"), new Date("2026-09-20T16:00:00.000Z"))).toBe(-2);
  });
});

describe("the statuses a follow-up survives", () => {
  it("covers the open board plus RESOLVED, and never CLOSED or VOIDED", () => {
    expect([...FOLLOW_UP_STATUSES]).toEqual(["NEW", "OPEN", "PENDING_CLIENT", "PENDING_INTERNAL", "RESOLVED"]);
    expect(FOLLOW_UP_STATUSES as readonly string[]).not.toContain("CLOSED");
    expect(FOLLOW_UP_STATUSES as readonly string[]).not.toContain("VOIDED");
  });
});

describe("the digest lines", () => {
  it("reads as one scannable line per commitment", () => {
    expect(followUpNudgeLine(candidate(), "https://desk.example.com").text).toBe(
      ":calendar: FOLLOW-UP | <https://desk.example.com/tickets/wm/1042|HD-1042> | OPERATIONS | HIGH | due today",
    );
    expect(followUpNudgeLine(candidate({ daysOverdue: 3 }), undefined).text).toContain("3d overdue");
  });

  it("carries a header with counts and nothing else", () => {
    const lines = followUpDigestLines([candidate(), candidate({ number: 7, daysOverdue: 2 })], undefined);
    expect(lines[0].text).toBe("*WM help desk — follow-ups:* 2 follow-ups due (1 overdue)");
    expect(lines).toHaveLength(3);
  });

  it("says nothing at all when there is nothing due", () => {
    expect(followUpDigestLines([], undefined)).toEqual([]);
  });

  it("is PII-light: no subject, no requester, no address, no body", () => {
    const lines = followUpDigestLines(
      [candidate(), candidate({ number: 9, priority: "URGENT", queueKey: "CLIENT_SERVICE", daysOverdue: 11 })],
      "https://desk.example.com",
    );
    for (const line of lines) expect(() => assertPiiLight(line.text)).not.toThrow();
    // And the payload the poster would build passes the same check in one piece.
    expect(() => slackPayloadText(lines)).not.toThrow();
  });
});

describe("the per-run bound", () => {
  it("is finite, so a first run over a neglected board nudges in batches", () => {
    expect(FOLLOW_UP_MAX_PER_RUN).toBeGreaterThan(0);
    expect(Number.isInteger(FOLLOW_UP_MAX_PER_RUN)).toBe(true);
  });
});
