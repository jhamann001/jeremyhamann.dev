/**
 * Inline-SVG charts for /reports. No chart library: R9 forbids a new dependency, and the two shapes
 * this page needs (a grouped column / line over periods, and a ranked horizontal bar) are a dozen
 * rects and one path each.
 *
 * Three rules hold the whole file together:
 *
 *  - **The SVG carries no text.** Every label, legend, axis top and value is HTML beside the drawing,
 *    so the charts can stretch to any width with `preserveAspectRatio="none"` without distorting a
 *    single character. Strokes carry `vector-effect="non-scaling-stroke"` for the same reason.
 *  - **The picture is an alternative, never the only copy.** Each chart is `role="img"` with an
 *    `aria-label` that states what it plots and over what, and `ReportView` renders a real data table
 *    from the same rows. A number nobody can reach with a screen reader is not published.
 *  - **Colour is a token, never a literal.** `fill-primary`, `fill-chart-2`, `fill-destructive` are
 *    redefined per theme in `globals.css`, so the second palette lives there and no `dark:` class is
 *    needed here. That is a contract with the stylesheet, not a property of the utilities: the shadcn
 *    starter shipped `--chart-1 … --chart-5` identical in `:root` and `.dark`, which put the third
 *    series of the `sla-attainment` line chart at 2.30:1 on a dark card. `src/app/theme-tokens.test.ts`
 *    re-derives every ratio from the CSS and holds both ramps above the 3:1 WCAG 1.4.11 floor.
 *
 * Series in DIFFERENT units are never drawn on one axis: `chartableSeries` keeps the series that share
 * the first one's unit and leaves the rest to the table. A median in minutes and a count of tickets on
 * the same scale is a chart that lies politely.
 */
import { cn } from "cn";
import type { ReportRow } from "@/types/domain";
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
import { formatSeriesValue, seriesLabel, seriesUnit } from "@/components/reports/series-meta";

/** The series a single axis may honestly carry: those measured in the first series' unit. */
export function chartableSeries(series: readonly string[]): string[] {
  if (series.length === 0) return [];
  const unit = seriesUnit(series[0]);
  return series.filter((s) => seriesUnit(s) === unit);
}

/** Series 1 is the subject, 2 the comparison, 3 the exception; a breach is always the destructive tone. */
function toneClasses(key: string, index: number): { fill: string; stroke: string; dot: string } {
  if (key === "breached" || key === "reopened") {
    return { fill: "fill-destructive", stroke: "stroke-destructive", dot: "bg-destructive" };
  }
  switch (index) {
    case 0:
      return { fill: "fill-primary", stroke: "stroke-primary", dot: "bg-primary" };
    case 1:
      return { fill: "fill-chart-2", stroke: "stroke-chart-2", dot: "bg-chart-2" };
    default:
      return { fill: "fill-chart-3", stroke: "stroke-chart-3", dot: "bg-chart-3" };
  }
}

function Legend({ series }: { series: readonly string[] }): React.JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((key, i) => (
        <li key={key} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2.5 rounded-xs", toneClasses(key, i).dot)} />
          {seriesLabel(key)}
        </li>
      ))}
    </ul>
  );
}

export type ReportTimeChartProps = {
  rows: readonly ReportRow[];
  series: readonly string[];
  kind: "bars" | "line";
  /** Included in the accessible name: "Volume, 30 days to Sep 19". */
  caption: string;
};

/**
 * Periods along the x axis, one grouped column set (or one line per series) each. Empty periods are
 * rendered as empty, never closed up — a gap in the middle of a week is a fact about the desk.
 */
export function ReportTimeChart({ rows, series, kind, caption }: ReportTimeChartProps): React.JSX.Element {
  const drawn = chartableSeries(series);
  const max = seriesMax(rows, drawn);
  const top = niceMax(max);
  const unit = drawn.length > 0 ? drawn[0] : "";

  if (rows.length === 0 || drawn.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No data in this range.
      </p>
    );
  }

  const groups = kind === "bars" ? groupedBars(rows, drawn, max) : [];
  const ticks = labelIndices(rows.length, rows.length <= 8 ? rows.length : 4);
  const summary = `${caption}. ${drawn
    .map((key) => `${seriesLabel(key)} peaks at ${formatSeriesValue(key, seriesMax(rows, [key]))}`)
    .join("; ")}. Open the data table below for every value.`;

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <Legend series={drawn} />
        <span className="text-xs tabular-nums text-muted-foreground">Top of scale {formatSeriesValue(unit, top)}</span>
      </figcaption>

      <div className="rounded-lg border bg-card p-3 text-card-foreground">
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-40 w-full md:h-56"
        >
          {/* Three gridlines: the top of scale, the midpoint and the baseline. */}
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={0}
              x2={CHART_WIDTH}
              y1={CHART_HEIGHT * f}
              y2={CHART_HEIGHT * f}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {kind === "bars"
            ? groups.map((group, i) =>
                group.map((rect, j) => (
                  <rect
                    key={`${rows[i].bucket}-${drawn[j]}`}
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    className={toneClasses(drawn[j], j).fill}
                  />
                )),
              )
            : drawn.map((key, j) => (
                <g key={key}>
                  {j === 0 ? <path d={areaPath(rows, key, max)} className={cn(toneClasses(key, j).fill, "opacity-10")} /> : null}
                  <path
                    d={linePath(rows, key, max)}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    className={toneClasses(key, j).stroke}
                  />
                </g>
              ))}
        </svg>

        {/* The x axis, in HTML so it stays legible at every width. */}
        <ul aria-hidden className="mt-2 flex justify-between text-[0.6875rem] text-muted-foreground">
          {ticks.map((i) => (
            <li key={rows[i].bucket} className="truncate">
              {rows[i].label}
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

export type ReportRankChartProps = {
  rows: readonly ReportRow[];
  series: readonly string[];
  caption: string;
  /** Rows beyond this are still in the table; the chart shows the head of the ranking. */
  limit?: number;
};

/**
 * One horizontal bar per row, longest first, for the reports whose rows are a dimension rather than a
 * period (agents, categories, resolutions, health counters). The bar is drawn in SVG so it scales with
 * the row and needs no min-width; the value is printed beside it, because a bar with no number is a
 * shape.
 */
export function ReportRankChart({ rows, series, caption, limit = 12 }: ReportRankChartProps): React.JSX.Element {
  const primary = chartableSeries(series)[0] ?? series[0];
  if (rows.length === 0 || primary === undefined) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No data in this range.
      </p>
    );
  }

  const shown = [...rows]
    .sort((a, b) => (b.values[primary] ?? 0) - (a.values[primary] ?? 0))
    .slice(0, limit);
  const max = seriesMax(shown, [primary]);

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-xs text-muted-foreground">
        {caption} — by {seriesLabel(primary).toLowerCase()}
        {rows.length > shown.length ? `, top ${shown.length} of ${rows.length}` : ""}
      </figcaption>

      <ul className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
        {shown.map((row) => {
          const value = row.values[primary] ?? 0;
          return (
            <li key={row.bucket} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 tabular-nums">{formatSeriesValue(primary, value)}</span>
              </div>
              <svg
                role="img"
                aria-label={`${row.label}: ${formatSeriesValue(primary, value)}`}
                viewBox="0 0 100 4"
                preserveAspectRatio="none"
                className="h-2 w-full overflow-hidden rounded-xs bg-muted"
              >
                <rect x={0} y={0} height={4} width={rankFraction(value, max) * 100} className="fill-primary" />
              </svg>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
