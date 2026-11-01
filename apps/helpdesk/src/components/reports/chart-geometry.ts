/**
 * Chart arithmetic — pure, no DOM, no React, no imports. Separated from the SVG so the numbers that
 * decide where a bar lands can be asserted in a unit test instead of eyeballed in a screenshot.
 *
 * Everything works in the SVG's own user-space units. The charts draw with
 * `preserveAspectRatio="none"` and put every piece of TEXT in HTML beside the drawing, so a stretched
 * viewBox distorts nothing a reader has to read (strokes carry `vector-effect="non-scaling-stroke"`).
 */

/** The user-space box every time-series chart draws into. Width is nominal; CSS stretches it. */
export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 200;

/**
 * An axis top a person can divide in their head: 1, 2, 2.5 or 5 × a power of ten, at or above `max`.
 * Zero (and anything negative, which a count cannot be) yields 1 so a flat empty chart still has a
 * scale and every bar in it is honestly zero-height rather than full-height.
 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** The largest value across every series of every row — the scale a grouped chart shares. */
export function seriesMax(rows: ReadonlyArray<{ values: Record<string, number> }>, series: readonly string[]): number {
  let max = 0;
  for (const row of rows) {
    for (const key of series) {
      const v = row.values[key];
      if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
    }
  }
  return max;
}

export type BarRect = { x: number; y: number; width: number; height: number };

/**
 * One rect per (row, series) for a grouped column chart.
 *
 * `groupGap` is a FRACTION of the slot (0–0.9), not a unit count, so the gap survives any bucket count:
 * 7 daily columns and 90 of them both keep their proportions. A zero value still returns a rect of
 * height 0 — the caller renders it, and a zero-height rect paints nothing, which is the truth.
 */
export function groupedBars(
  rows: ReadonlyArray<{ values: Record<string, number> }>,
  series: readonly string[],
  max: number,
  opts?: { width?: number; height?: number; groupGap?: number },
): BarRect[][] {
  const width = opts?.width ?? CHART_WIDTH;
  const height = opts?.height ?? CHART_HEIGHT;
  const gap = Math.min(Math.max(opts?.groupGap ?? 0.25, 0), 0.9);
  const top = niceMax(max);
  const out: BarRect[][] = [];
  if (rows.length === 0 || series.length === 0) return out;

  const slot = width / rows.length;
  const groupWidth = slot * (1 - gap);
  const barWidth = groupWidth / series.length;

  for (const [i, row] of rows.entries()) {
    const group: BarRect[] = [];
    for (const [j, key] of series.entries()) {
      const raw = row.values[key];
      const value = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
      const barHeight = (value / top) * height;
      group.push({
        x: i * slot + (slot - groupWidth) / 2 + j * barWidth,
        y: height - barHeight,
        width: barWidth,
        height: barHeight,
      });
    }
    out.push(group);
  }
  return out;
}

/**
 * `M0,200 L60,140 …` for one series. Rows are spaced evenly with the first point on the left edge and
 * the last on the right; a single row draws a one-unit-wide flat segment so the line is visible at all.
 */
export function linePath(
  rows: ReadonlyArray<{ values: Record<string, number> }>,
  key: string,
  max: number,
  opts?: { width?: number; height?: number },
): string {
  const width = opts?.width ?? CHART_WIDTH;
  const height = opts?.height ?? CHART_HEIGHT;
  const top = niceMax(max);
  if (rows.length === 0) return "";

  const step = rows.length === 1 ? 0 : width / (rows.length - 1);
  const points = rows.map((row, i) => {
    const raw = row.values[key];
    const value = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
    const x = rows.length === 1 ? 0 : i * step;
    const y = height - (value / top) * height;
    return `${round(x)},${round(y)}`;
  });
  if (rows.length === 1) points.push(`${round(width)},${points[0].split(",")[1]}`);
  return `M${points.join(" L")}`;
}

/** The closed area under a line, for the faint fill under a sparkline. "" when there is nothing to fill. */
export function areaPath(
  rows: ReadonlyArray<{ values: Record<string, number> }>,
  key: string,
  max: number,
  opts?: { width?: number; height?: number },
): string {
  const line = linePath(rows, key, max, opts);
  if (line === "") return "";
  const width = opts?.width ?? CHART_WIDTH;
  const height = opts?.height ?? CHART_HEIGHT;
  return `${line} L${round(width)},${height} L0,${height} Z`;
}

/** Fraction of `max` a value occupies, clamped to 0–1 — the width of one horizontal rank bar. */
export function rankFraction(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const top = niceMax(max);
  return Math.min(value / top, 1);
}

/**
 * Which row labels to print under a time chart: at most `limit`, always including the first and the
 * last, evenly spaced in between. A 90-day chart with 90 labels is a grey smear; one with 4 is a scale.
 */
export function labelIndices(count: number, limit: number): number[] {
  if (count <= 0) return [];
  if (count <= limit) return Array.from({ length: count }, (_, i) => i);
  if (limit <= 1) return [0];
  const step = (count - 1) / (limit - 1);
  const out = new Set<number>();
  for (let i = 0; i < limit; i++) out.add(Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
