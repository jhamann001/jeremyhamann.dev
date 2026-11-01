/**
 * The report URL serializer and the series label/format map — the two client-side pieces of /reports.
 *
 * This file lives under `src/components/**`, so G1 applies to it as much as to the components: it may
 * import types and client modules and NOTHING from `@/server/*`. The round-trip against the server's
 * tolerant parser is asserted from the other side of that line, in `src/server/reports.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { reportExportHref, reportHref, reportQueryToParams } from "@/components/reports/report-query-params";
import { formatSeriesValue, seriesLabel, seriesUnit } from "@/components/reports/series-meta";

const QUERY = {
  key: "volume",
  from: "2026-09-01",
  to: "2026-09-30",
  granularity: "week",
};

describe("reportQueryToParams", () => {
  it("always writes the four scalars, in a stable order", () => {
    expect(reportQueryToParams(QUERY).toString()).toBe("report=volume&from=2026-09-01&to=2026-09-30&granularity=week");
  });

  it("writes multi-values as repeated bare keys (convention 12, guardrail G11)", () => {
    const qs = reportQueryToParams({
      ...QUERY,
      queueKey: ["OPERATIONS", "ADVICE"],
      priority: ["URGENT"],
      category: ["WIRE_TRANSFER", "ACAT"],
    }).toString();
    expect(qs).toContain("queueKey=OPERATIONS&queueKey=ADVICE");
    expect(qs).toContain("priority=URGENT");
    expect(qs).toContain("category=WIRE_TRANSFER&category=ACAT");
    expect(qs).not.toContain("[]");
    expect(qs).not.toContain("%5B%5D");
    expect(qs).not.toContain("OPERATIONS%2CADVICE");
  });

  it("omits an empty multi-value rather than writing an empty key", () => {
    const qs = reportQueryToParams({ ...QUERY, queueKey: [], category: [] }).toString();
    expect(qs).not.toContain("queueKey");
    expect(qs).not.toContain("category");
  });

  it("points the page and the export at the same filters", () => {
    const q = { ...QUERY, queueKey: ["OPERATIONS"] };
    expect(reportHref("/reports", q)).toBe(`/reports?${reportQueryToParams(q).toString()}`);
    expect(reportExportHref(q)).toBe(`/api/reports/export?${reportQueryToParams(q).toString()}`);
  });
});

describe("series metadata", () => {
  it("names every series a report can emit, and falls back to the key rather than blank", () => {
    expect(seriesLabel("p50")).toBe("Median");
    expect(seriesLabel("metPct")).toBe("Both met");
    expect(seriesLabel("created.OPERATIONS")).toBe("Created · Operations");
    expect(seriesLabel("something-new")).toBe("something-new");
  });

  it("knows which series are counts, percentages and durations", () => {
    expect(seriesUnit("created")).toBe("count");
    expect(seriesUnit("sharePct")).toBe("percent");
    expect(seriesUnit("p90")).toBe("minutes");
    expect(seriesUnit("created.ADVICE")).toBe("count");
    expect(seriesUnit("unknown")).toBe("count");
  });

  it("prints a duration as a duration, not as a number of minutes", () => {
    expect(formatSeriesValue("p50", 134)).toBe("2h 14m");
    expect(formatSeriesValue("p50", 45)).toBe("45m");
    expect(formatSeriesValue("p50", 0)).toBe("—");
    expect(formatSeriesValue("metPct", 87.5)).toBe("87.5%");
    expect(formatSeriesValue("created", 12)).toBe("12");
    expect(formatSeriesValue("created", undefined)).toBe("—");
  });
});
