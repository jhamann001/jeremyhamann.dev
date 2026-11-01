/**
 * Chart arithmetic (src/components/reports/chart-geometry.ts). Pure — no DOM, no React.
 *
 * These are the numbers a reader trusts without being able to check them: a bar twice as tall means
 * twice as many tickets. Asserting them here is the only way that claim is ever verified, because a
 * rendered chart's proportions are exactly what a source-level review cannot see.
 */
import { describe, expect, it } from "vitest";
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  areaPath,
  groupedBars,
  labelIndices,
  linePath,
  niceMax,
  rankFraction,
  seriesMax,
} from "@/components/reports/chart-geometry";

const rows = (...values: number[]): Array<{ values: Record<string, number> }> =>
  values.map((n) => ({ values: { n } }));

describe("niceMax", () => {
  it("rounds up to a scale a person can divide in their head", () => {
    expect(niceMax(7)).toBe(10);
    expect(niceMax(10)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(210)).toBe(250);
    expect(niceMax(0.4)).toBe(0.5);
  });

  it("never returns zero, so an empty chart still has a scale", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-4)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
  });
});

describe("seriesMax", () => {
  it("is the largest value across every drawn series", () => {
    const data = [
      { values: { a: 3, b: 9 } },
      { values: { a: 12, b: 1 } },
    ];
    expect(seriesMax(data, ["a", "b"])).toBe(12);
    expect(seriesMax(data, ["b"])).toBe(9);
    expect(seriesMax(data, ["missing"])).toBe(0);
  });
});

describe("groupedBars", () => {
  it("makes height proportional to value against the top of scale", () => {
    const groups = groupedBars(rows(5, 10), ["n"], 10);
    expect(groups).toHaveLength(2);
    expect(groups[1][0].height).toBe(CHART_HEIGHT); // 10 of 10
    expect(groups[0][0].height).toBe(CHART_HEIGHT / 2); // 5 of 10
    expect(groups[0][0].y).toBe(CHART_HEIGHT / 2); // grows upward from the baseline
  });

  it("keeps every group inside the box and leaves the declared gap between them", () => {
    const groups = groupedBars(rows(1, 1, 1, 1), ["n"], 1, { groupGap: 0.5 });
    const slot = CHART_WIDTH / 4;
    expect(groups[0][0].width).toBe(slot * 0.5);
    expect(groups[0][0].x).toBe(slot * 0.25);
    const last = groups[3][0];
    expect(last.x + last.width).toBeLessThanOrEqual(CHART_WIDTH);
  });

  it("splits the group between the series, in order", () => {
    const groups = groupedBars([{ values: { a: 2, b: 4 } }], ["a", "b"], 4);
    expect(groups[0]).toHaveLength(2);
    expect(groups[0][0].x).toBeLessThan(groups[0][1].x);
    expect(groups[0][0].width).toBe(groups[0][1].width);
    // The scale is niceMax(4) = 5, not 4, so the tallest bar is 4/5 of the box — which is the point of
    // a rounded axis: the top of the chart is a number on the scale, not the largest sample.
    expect(groups[0][1].height).toBe(CHART_HEIGHT * 0.8);
  });

  it("draws a zero (and a negative, and a missing key) as no bar at all", () => {
    const groups = groupedBars([{ values: { n: 0 } }, { values: { n: -3 } }, { values: {} }], ["n"], 10);
    for (const g of groups) expect(g[0].height).toBe(0);
  });

  it("returns nothing for no rows or no series", () => {
    expect(groupedBars([], ["n"], 10)).toEqual([]);
    expect(groupedBars(rows(1), [], 10)).toEqual([]);
  });
});

describe("linePath / areaPath", () => {
  it("spans the full width with the first point on the left edge", () => {
    const d = linePath(rows(0, 5, 10), "n", 10);
    expect(d.startsWith("M0,200")).toBe(true);
    expect(d).toContain(`${CHART_WIDTH},0`); // the last point, at full height
    expect(d.split(" L")).toHaveLength(3);
  });

  it("draws a single row as a flat segment rather than an invisible point", () => {
    const d = linePath(rows(4), "n", 10);
    expect(d.split(" L")).toHaveLength(2);
    expect(d.endsWith(`L${CHART_WIDTH},120`)).toBe(true);
  });

  it("closes the area down to the baseline", () => {
    const d = areaPath(rows(1, 2), "n", 2);
    expect(d.endsWith(`L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`)).toBe(true);
    expect(areaPath([], "n", 2)).toBe("");
  });
});

describe("rankFraction", () => {
  it("is the share of the top of scale, clamped to the bar", () => {
    expect(rankFraction(5, 10)).toBe(0.5);
    expect(rankFraction(0, 10)).toBe(0);
    expect(rankFraction(40, 10)).toBe(1);
  });
});

describe("labelIndices", () => {
  it("prints every label when there are few, and thins them evenly when there are many", () => {
    expect(labelIndices(4, 8)).toEqual([0, 1, 2, 3]);
    expect(labelIndices(90, 4)).toEqual([0, 30, 59, 89]);
    expect(labelIndices(0, 4)).toEqual([]);
  });

  it("always keeps the first and the last, so the axis has both ends", () => {
    for (const count of [5, 31, 90, 365]) {
      const idx = labelIndices(count, 4);
      expect(idx[0]).toBe(0);
      expect(idx.at(-1)).toBe(count - 1);
    }
  });
});
