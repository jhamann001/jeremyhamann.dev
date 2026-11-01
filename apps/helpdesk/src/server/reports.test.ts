/**
 * B7 reporting — the half that needs no database.
 *
 * Firm-clock range arithmetic, bucket edges across a DST boundary, the presets, the tolerant URL
 * parser, the label maps' totality and the CSV writer. The DB-backed half — queue scoping, the VOIDED
 * exclusion, the percentiles, the callback credit and the `REPORT_EXPORTED` row — is in
 * `reports.integration.test.ts`.
 *
 * Every instant asserted here is UTC, because that is what the database stores; the *dates* are firm
 * local. The two only line up at 04:00Z (EDT) or 05:00Z (EST), which is exactly the arithmetic these
 * tests exist to pin.
 */
import { describe, expect, it } from "vitest";
import type { ReportKey } from "@/types/domain";
import { REPORT_GRANULARITIES, REPORT_KEYS } from "@/types/domain";
import {
  EXTENDED_REPORT_KEYS,
  EXTENDED_REPORT_LABELS,
  MAX_RANGE_DAYS,
  REPORT_CHART_KINDS,
  REPORT_DESCRIPTIONS,
  REPORT_PRESETS,
  REPORT_PRESET_LABELS,
  activePreset,
  addCivilDays,
  civilDaysBetween,
  civilFromInstant,
  civilToString,
  formatReportDate,
  isReportKey,
  isTimeSeriesReport,
  parseCivilDate,
  parseReportQuery,
  presetRange,
  reportBuckets,
  reportFilters,
  resolveRange,
  startOfCivilWeek,
} from "@/server/reports-query";
import { REPORT_LABELS, reportCsvColumns, reportToCsv } from "@/server/reports";
import { reportExportHref, reportQueryToParams } from "@/components/reports/report-query-params";

/** 2026-09-20 12:00 UTC = 08:00 ET, comfortably inside the firm day in either DST state. */
const NOW = new Date("2026-09-20T12:00:00.000Z");

describe("civil dates on the firm clock", () => {
  it("rejects text that is not a real calendar date", () => {
    expect(parseCivilDate("2026-02-31")).toBeNull();
    expect(parseCivilDate("2026-13-01")).toBeNull();
    expect(parseCivilDate("20260901")).toBeNull();
    expect(parseCivilDate(" 2026-09-01 ")).toEqual({ y: 2026, m: 9, d: 1 });
  });

  it("reads the firm-local date of an instant, not the UTC one", () => {
    // 01:30 UTC on the 20th is 21:30 ET on the 19th — the evening a desk is still working.
    expect(civilToString(civilFromInstant(new Date("2026-09-20T01:30:00.000Z")))).toBe("2026-09-19");
    expect(civilToString(civilFromInstant(new Date("2026-09-20T12:00:00.000Z")))).toBe("2026-09-20");
  });

  it("adds days and finds Mondays without tripping over month ends", () => {
    expect(civilToString(addCivilDays({ y: 2026, m: 2, d: 28 }, 1))).toBe("2026-03-01");
    expect(civilToString(addCivilDays({ y: 2026, m: 1, d: 1 }, -1))).toBe("2025-12-31");
    // 2026-09-20 is a Sunday; its ISO week starts Monday the 14th.
    expect(civilToString(startOfCivilWeek({ y: 2026, m: 9, d: 20 }))).toBe("2026-09-14");
    expect(civilToString(startOfCivilWeek({ y: 2026, m: 9, d: 14 }))).toBe("2026-09-14");
  });

  it("formats a date string as a date, never as an instant", () => {
    // The trap this helper exists for: new Date("2026-09-01") is UTC midnight, which is Aug 31 ET.
    expect(formatReportDate("2026-09-01")).toBe("Sep 1, 2026");
    expect(formatReportDate("not-a-date")).toBe("not-a-date");
  });
});

describe("resolveRange", () => {
  it("bounds the range at firm midnight, with an exclusive upper edge", () => {
    const r = resolveRange({ from: "2026-09-01", to: "2026-09-30" });
    expect(r.fromAt.toISOString()).toBe("2026-09-01T04:00:00.000Z"); // EDT
    expect(r.toAt.toISOString()).toBe("2026-10-01T04:00:00.000Z"); // the day AFTER `to`
    expect(r.days).toBe(30);
  });

  it("uses the standard-time offset in winter", () => {
    const r = resolveRange({ from: "2026-01-05", to: "2026-01-05" });
    expect(r.fromAt.toISOString()).toBe("2026-01-05T05:00:00.000Z"); // EST
    expect(r.toAt.toISOString()).toBe("2026-01-06T05:00:00.000Z");
    expect(r.days).toBe(1);
  });

  it("reads a backwards range the way it was meant, and clamps an absurd one", () => {
    const swapped = resolveRange({ from: "2026-09-30", to: "2026-09-01" });
    expect([swapped.fromDate, swapped.toDate]).toEqual(["2026-09-01", "2026-09-30"]);

    const huge = resolveRange({ from: "2000-01-01", to: "2026-09-30" });
    expect(huge.days).toBe(MAX_RANGE_DAYS);
    expect(huge.toDate).toBe("2026-09-30");
    expect(civilDaysBetween(parseCivilDate(huge.fromDate)!, parseCivilDate(huge.toDate)!)).toBe(MAX_RANGE_DAYS - 1);
  });
});

describe("reportBuckets", () => {
  it("emits one bucket per day, including the empty ones", () => {
    const range = resolveRange({ from: "2026-09-01", to: "2026-09-07" });
    const buckets = reportBuckets(range, "day");
    expect(buckets).toHaveLength(7);
    expect(buckets[0].key).toBe("2026-09-01");
    expect(buckets[6].key).toBe("2026-09-07");
    expect(buckets[0].end.toISOString()).toBe(buckets[1].start.toISOString());
  });

  it("crosses the spring-forward boundary without losing or duplicating a day", () => {
    // 2026-03-08 is the US DST change: the day is 23 hours long, and its midnight moves from 05:00Z
    // to 04:00Z. The buckets have to stay one calendar day each on both sides of it.
    const range = resolveRange({ from: "2026-03-07", to: "2026-03-09" });
    const buckets = reportBuckets(range, "day");
    expect(buckets.map((b) => b.key)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(buckets[0].start.toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(buckets[1].start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(buckets[2].start.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(buckets[1].end.getTime() - buckets[1].start.getTime()).toBe(23 * 3_600_000);
  });

  it("truncates week buckets to the Monday Postgres date_trunc would return", () => {
    const range = resolveRange({ from: "2026-09-16", to: "2026-09-30" });
    const buckets = reportBuckets(range, "week");
    expect(buckets.map((b) => b.key)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
    // The first bucket is PARTIAL: its natural start precedes the range, and rows are still filtered.
    expect(buckets[0].start.getTime()).toBeLessThan(range.fromAt.getTime());
  });

  it("emits one bucket per calendar month", () => {
    const range = resolveRange({ from: "2026-11-15", to: "2027-01-02" });
    expect(reportBuckets(range, "month").map((b) => b.key)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });

  it("labels day, week and month buckets differently", () => {
    const range = resolveRange({ from: "2026-09-14", to: "2026-09-14" });
    expect(reportBuckets(range, "day")[0].label).toMatch(/^Sep 14/);
    expect(reportBuckets(range, "week")[0].label).toMatch(/^Week of Sep 14/);
    expect(reportBuckets(range, "month")[0].label).toBe("Sep 2026");
  });
});

describe("presets", () => {
  it("last-7 covers today and the six days before it, on the firm clock", () => {
    expect(presetRange("last-7", NOW)).toEqual({ from: "2026-09-14", to: "2026-09-20", granularity: "day" });
  });

  it("this-month starts on the 1st; last-month is the whole previous month", () => {
    expect(presetRange("this-month", NOW)).toMatchObject({ from: "2026-09-01", to: "2026-09-20" });
    expect(presetRange("last-month", NOW)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(presetRange("ytd", NOW)).toMatchObject({ from: "2026-01-01", to: "2026-09-20", granularity: "month" });
  });

  it("recognises the applied dates as a preset, and custom dates as none", () => {
    expect(activePreset({ from: "2026-09-14", to: "2026-09-20" }, NOW)).toBe("last-7");
    expect(activePreset({ from: "2026-09-13", to: "2026-09-20" }, NOW)).toBeNull();
  });

  it("every preset has a label", () => {
    for (const p of REPORT_PRESETS) expect(REPORT_PRESET_LABELS[p]).toBeTruthy();
  });
});

describe("parseReportQuery", () => {
  it("defaults to volume over the last 30 firm-local days, grouped by day", () => {
    expect(parseReportQuery({}, NOW)).toEqual({
      key: "volume",
      from: "2026-08-22",
      to: "2026-09-20",
      granularity: "day",
    });
  });

  it("drops an unknown report, granularity, queue, priority or category rather than failing", () => {
    const q = parseReportQuery(
      { report: "not-a-report", granularity: "fortnight", queueKey: "MARKETING", priority: "SEVERE", category: "NOPE" },
      NOW,
    );
    expect(q.key).toBe("volume");
    expect(q.granularity).toBe("day");
    expect(q.queueKey).toBeUndefined();
    expect(q.priority).toBeUndefined();
    expect(q.category).toBeUndefined();
  });

  it("expands a preset and never round-trips it, so a shared link keeps its dates", () => {
    const q = parseReportQuery({ report: "backlog", preset: "last-7" }, NOW);
    expect(q).toMatchObject({ key: "backlog", from: "2026-09-14", to: "2026-09-20" });
    expect(reportQueryToParams(q).get("preset")).toBeNull();
  });

  it("accepts multi-values as repeated bare keys and as a comma list (convention 12)", () => {
    const repeated = parseReportQuery(new URLSearchParams("queueKey=OPERATIONS&queueKey=ADVICE"), NOW);
    expect(repeated.queueKey).toEqual(["OPERATIONS", "ADVICE"]);
    const comma = parseReportQuery({ category: "WIRE_TRANSFER,ACAT" }, NOW);
    expect(comma.category).toEqual(["WIRE_TRANSFER", "ACAT"]);
  });

  it("falls back to the default range when the dates are unparseable, and normalizes a backwards one", () => {
    expect(parseReportQuery({ from: "yesterday", to: "" }, NOW)).toMatchObject({ from: "2026-08-22", to: "2026-09-20" });
    expect(parseReportQuery({ from: "2026-09-10", to: "2026-09-01" }, NOW)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-10",
    });
  });

  it("round-trips through the URL serializer the filter bar and the export link share", () => {
    const original = parseReportQuery(
      { report: "sla-attainment", from: "2026-09-01", to: "2026-09-30", granularity: "week", queueKey: "OPERATIONS", priority: "URGENT" },
      NOW,
    );
    expect(parseReportQuery(reportQueryToParams(original), NOW)).toEqual(original);
    expect(reportExportHref(original)).toContain("/api/reports/export?report=sla-attainment");
  });

  it("never writes a `key[]` style multi-value (guardrail G11)", () => {
    const qs = reportQueryToParams({
      key: "volume",
      from: "2026-09-01",
      to: "2026-09-02",
      granularity: "day",
      queueKey: ["OPERATIONS", "ADVICE"],
    }).toString();
    expect(qs).toContain("queueKey=OPERATIONS&queueKey=ADVICE");
    expect(qs).not.toContain("%5B%5D");
  });
});

describe("report catalog", () => {
  it("every contract key has a label, and REPORT_LABELS covers exactly ReportKey", () => {
    for (const key of REPORT_KEYS) expect(REPORT_LABELS[key as ReportKey]).toBeTruthy();
  });

  it("every extended key has a label, a description and a chart kind", () => {
    for (const key of EXTENDED_REPORT_KEYS) {
      expect(EXTENDED_REPORT_LABELS[key]).toBeTruthy();
      expect(REPORT_DESCRIPTIONS[key]).toBeTruthy();
      expect(["bars", "line", "rank"]).toContain(REPORT_CHART_KINDS[key]);
      expect(isReportKey(key)).toBe(true);
    }
    // Integration round 1: B7's two keys landed in `REPORT_KEYS` itself, so `EXTENDED_REPORT_KEYS` is
    // now an ALIAS of it rather than a superset — the collapse the deviation note said would be
    // mechanical. What still has to hold is that there is ONE list: re-spreading and re-appending
    // would have given twelve entries with `resolution-mix` and `desk-health` twice, and this picker
    // iterates it.
    expect([...EXTENDED_REPORT_KEYS]).toEqual([...REPORT_KEYS]);
    expect(new Set(EXTENDED_REPORT_KEYS).size).toBe(EXTENDED_REPORT_KEYS.length);
    // The two keys the deviation note declared are present, and nothing else was silently added.
    expect(EXTENDED_REPORT_KEYS).toContain("resolution-mix");
    expect(EXTENDED_REPORT_KEYS).toContain("desk-health");
    expect(EXTENDED_REPORT_KEYS.length).toBe(10);
  });

  it("ranked reports are the ones with no period axis", () => {
    for (const key of EXTENDED_REPORT_KEYS) {
      expect(isTimeSeriesReport(key)).toBe(REPORT_CHART_KINDS[key] !== "rank");
    }
    expect(REPORT_GRANULARITIES).toEqual(["day", "week", "month"]);
  });

  it("reportFilters records what SELECTS rows and nothing else", () => {
    const q = parseReportQuery({ report: "volume", queueKey: "OPERATIONS", priority: "URGENT" }, NOW);
    const filters = reportFilters(q);
    expect(filters).toEqual({ granularity: "day", queueKey: ["OPERATIONS"], priority: ["URGENT"] });
    expect(filters).not.toHaveProperty("from");
    expect(filters).not.toHaveProperty("key");
  });
});

describe("CSV", () => {
  const RESULT = {
    key: "first-response" as const,
    from: "2026-09-01",
    to: "2026-09-02",
    granularity: "day" as const,
    series: ["p50", "p90", "responded"],
    rows: [
      { bucket: "2026-09-01", label: "Sep 1", values: { p50: 12.5, p90: 44, responded: 3 } },
      { bucket: "2026-09-02", label: "Sep 2", values: { p50: 0, p90: 0, responded: 0 } },
    ],
    totals: { p50: 13.25, p90: 50, created: 9, responded: 3, unanswered: 6, respondedPct: 33.33 },
    generatedAt: "2026-09-20T12:00:00.000Z",
  };

  it("carries the row series first, then the totals-only columns", () => {
    expect(reportCsvColumns(RESULT)).toEqual([
      "bucket",
      "label",
      "p50",
      "p90",
      "responded",
      "created",
      "unanswered",
      "respondedPct",
    ]);
  });

  it("writes RFC 4180 lines and a TOTAL row carrying the whole-range figures", () => {
    const csv = reportToCsv(RESULT);
    const lines = csv.split("\r\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("bucket,label,p50,p90,responded,created,unanswered,respondedPct");
    expect(lines[1]).toBe("2026-09-01,Sep 1,12.5,44,3,,,");
    expect(lines).toHaveLength(4);
    // The range median is the DATABASE's, not an average of the daily ones.
    expect(lines[3]).toBe("TOTAL,Whole range 2026-09-01 to 2026-09-02,13.25,50,3,9,6,33.33");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("neutralizes a label a spreadsheet would evaluate", () => {
    // Agent names reach the label column, and a name is whatever Okta says it is.
    const csv = reportToCsv({
      ...RESULT,
      key: "agent-load" as never,
      series: ["open"],
      rows: [{ bucket: "u_1", label: "=SUM(A1:A9)", values: { open: 2 } }],
      totals: { open: 2 },
    });
    // Prefixed with an apostrophe; unquoted, because the value carries no comma, quote or newline.
    expect(csv).toContain("u_1,'=SUM(A1:A9),2");
  });
});
