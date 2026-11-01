/**
 * The review queue's PURE halves — query parsing, the firm-clock window, and the CSV writer
 *. No database: the DB-backed readers are covered by
 * `src/server/compliance.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { FIRM_TIME_ZONE_LABEL } from "@/lib/firm-time";
import {
  parseReviewQuery,
  REVIEW_CSV_COLUMNS,
  REVIEW_DEFAULT_WINDOW_DAYS,
  REVIEW_STATES,
  reviewExportFilters,
  reviewQueryToParams,
  reviewRowsToCsv,
  reviewWindow,
} from "@/server/reviews";
import type { ReplyReviewRow, ReviewQuery } from "@/server/reviews";

const DEFAULT: ReviewQuery = { from: null, to: null, queueKey: null, state: "UNREVIEWED" };

function row(over: Partial<ReplyReviewRow> = {}): ReplyReviewRow {
  return {
    commentId: "cmt_1",
    ticketId: "tkt_1",
    ticketNumber: 1042,
    ticketPath: "/tickets/wm/1042",
    subject: "Wire confirmation",
    queueKey: "OPERATIONS",
    category: "WIRE_TRANSFER",
    author: { id: "u1", name: "Olive Ops", email: "olive@example.test", image: null },
    authorLabel: "Olive Ops",
    sentAt: "2026-09-18T14:30:00.000Z",
    deliveryStatus: "SENT",
    excerpt: "Your wire settled on Tuesday.",
    excerptTruncated: false,
    attachmentCount: 0,
    retracted: false,
    stamps: [],
    ...over,
  };
}

describe("parseReviewQuery", () => {
  it("defaults to the unreviewed queue with no narrowing", () => {
    expect(parseReviewQuery({})).toEqual(DEFAULT);
    expect(parseReviewQuery(new URLSearchParams())).toEqual(DEFAULT);
  });

  it("reads every filter from bare repeated keys (convention 12 — never `key[]`)", () => {
    const p = new URLSearchParams("from=2026-09-01&to=2026-09-30&queue=ADVICE&state=REVIEWED");
    expect(parseReviewQuery(p)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      queueKey: "ADVICE",
      state: "REVIEWED",
    });
  });

  it("falls back rather than throwing on anything hand-edited", () => {
    // A filter is a convenience. A bad query string should narrow nothing, not 500 a compliance page.
    const p = new URLSearchParams("from=yesterday&to=&queue=PAYROLL&state=SHRED");
    expect(parseReviewQuery(p)).toEqual(DEFAULT);
    expect(parseReviewQuery({ from: ["2026-09-01", "2026-01-01"] }).from).toBe("2026-09-01");
    expect(parseReviewQuery({ from: "2026-9-1" }).from).toBeNull();
  });

  it("round-trips through reviewQueryToParams, omitting the defaults", () => {
    expect(reviewQueryToParams(DEFAULT).toString()).toBe("");
    const q: ReviewQuery = { from: "2026-09-01", to: "2026-09-30", queueKey: "OPERATIONS", state: "ALL" };
    expect(parseReviewQuery(reviewQueryToParams(q))).toEqual(q);
  });

  it("REVIEW_STATES is the whole vocabulary and UNREVIEWED is the default", () => {
    expect([...REVIEW_STATES]).toEqual(["UNREVIEWED", "REVIEWED", "ALL"]);
    for (const s of REVIEW_STATES) expect(parseReviewQuery({ state: s }).state).toBe(s);
  });
});

describe("reviewWindow", () => {
  const NOW = new Date("2026-09-20T18:00:00.000Z");

  it("opens the default window REVIEW_DEFAULT_WINDOW_DAYS before now and never closes it", () => {
    const w = reviewWindow(DEFAULT, NOW);
    expect(w.lt).toBeNull();
    expect(NOW.getTime() - w.gte.getTime()).toBe(REVIEW_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });

  it("`to` means the WHOLE firm day, not its first instant", () => {
    // one clock. 2026-09-20 in New York is UTC-4, so the day runs 04:00Z → 04:00Z.
    const w = reviewWindow({ ...DEFAULT, from: "2026-09-20", to: "2026-09-20" }, NOW);
    expect(w.gte.toISOString()).toBe("2026-09-20T04:00:00.000Z");
    expect(w.lt?.toISOString()).toBe("2026-09-21T04:00:00.000Z");
    // A reply sent at 23:59 firm time on the chosen day is inside the window.
    const lateThatDay = new Date("2026-09-21T03:59:00.000Z");
    expect(lateThatDay >= w.gte && w.lt !== null && lateThatDay < w.lt).toBe(true);
  });

  it("crosses the DST boundary without losing or duplicating a day", () => {
    // 2026-11-01 is the US fall-back Sunday: that firm day is 25 hours long.
    const w = reviewWindow({ ...DEFAULT, from: "2026-11-01", to: "2026-11-01" }, NOW);
    expect(w.gte.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(w.lt?.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect((w.lt as Date).getTime() - w.gte.getTime()).toBe(25 * 60 * 60 * 1000);

    // 2026-03-08 is the spring-forward Sunday: 23 hours.
    const spring = reviewWindow({ ...DEFAULT, from: "2026-03-08", to: "2026-03-08" }, NOW);
    expect((spring.lt as Date).getTime() - spring.gte.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe("reviewExportFilters", () => {
  it("records the applied narrowing and the resolved instants, and no free text", () => {
    const NOW = new Date("2026-09-20T18:00:00.000Z");
    const f = reviewExportFilters({ from: "2026-09-01", to: "2026-09-30", queueKey: "ADVICE", state: "ALL" }, NOW);
    expect(f).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      queue: "ADVICE",
      state: "ALL",
      windowStart: "2026-09-01T04:00:00.000Z",
      windowEnd: "2026-10-01T04:00:00.000Z",
    });
    expect(reviewExportFilters(DEFAULT, NOW).windowEnd).toBeNull();
  });
});

describe("reviewRowsToCsv", () => {
  it("writes a header whose width matches the column list, even with no rows", () => {
    const csv = reviewRowsToCsv([], true);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(1);
    expect(lines[0].split(",")).toHaveLength(REVIEW_CSV_COLUMNS.length);
    expect(lines[0]).toContain("ticketNumber");
    expect(reviewRowsToCsv([], false)).toBe("");
  });

  it("writes one line for an unstamped reply and one line PER STAMP otherwise", () => {
    const unstamped = reviewRowsToCsv([row()], false).trimEnd().split("\r\n");
    expect(unstamped).toHaveLength(1);
    expect(unstamped[0]).toContain(",false,"); // stamped = false

    const twice = reviewRowsToCsv(
      [
        row({
          stamps: [
            {
              id: "s1",
              commentId: "cmt_1",
              verdict: "APPROVED",
              note: null,
              reviewer: { id: "u2", name: "Cleo CCO", email: "cleo@example.test", image: null },
              createdAt: "2026-09-19T12:00:00.000Z",
            },
            {
              id: "s2",
              commentId: "cmt_1",
              verdict: "FLAGGED",
              note: "disclaimer variant is wrong",
              reviewer: { id: "u3", name: null, email: "dana@example.test", image: null },
              createdAt: "2026-09-19T13:00:00.000Z",
            },
          ],
        }),
      ],
      false,
    )
      .trimEnd()
      .split("\r\n");
    expect(twice).toHaveLength(2);
    expect(twice[0]).toContain("APPROVED");
    expect(twice[1]).toContain("FLAGGED");
    // A reviewer with no display name is identified by their address, never by an empty cell.
    expect(twice[1]).toContain("dana@example.test");
    // The note itself never leaves; only whether there was one.
    expect(twice[1]).not.toContain("disclaimer variant is wrong");
    expect(twice[0].endsWith("false")).toBe(true);
    expect(twice[1].endsWith("true")).toBe(true);
  });

  it("never carries a reply body", () => {
    const csv = reviewRowsToCsv([row({ excerpt: "SECRET-BODY-TEXT", excerptTruncated: true })], true);
    expect(csv).not.toContain("SECRET-BODY-TEXT");
  });

  it("neutralises a formula and quotes a subject containing a comma or a quote", () => {
    const csv = reviewRowsToCsv([row({ subject: '=cmd|"/c calc"!A1, and "quoted"' })], false);
    expect(csv).not.toMatch(/,=cmd/);
    expect(csv).toContain('""quoted""');
  });

  it("prints the firm clock beside the ISO instant, with the zone label", () => {
    const csv = reviewRowsToCsv([row()], false);
    expect(csv).toContain("2026-09-18T14:30:00.000Z");
    expect(csv).toContain(FIRM_TIME_ZONE_LABEL);
  });
});
