"use client";

/**
 * The body of /reports: the whole-range tiles, the chart, and the data table behind a toggle.
 *
 * It is a client component for exactly one reason — the data-table toggle — and it receives the report
 * already computed by the page (G1: a component never reaches a `@/server/*` read module). Chart and
 * table render from the SAME `rows` array: there is no second fetch, no second shape and no way
 * for the picture and the numbers under it to disagree.
 *
 * Phones get the tiles in a two-column grid and the table as stacked rows; the flip is the single `md`
 * breakpoint. The table is the accessible copy of the chart, so it is reachable at every width —
 * the toggle changes whether it is EXPANDED, never whether it exists at the smaller size only.
 */
import { useState } from "react";
import { ChevronDown, Table2 } from "lucide-react";
import type { ReportRow } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportRankChart, ReportTimeChart } from "@/components/reports/report-chart";
import { formatSeriesValue, seriesLabel } from "@/components/reports/series-meta";

export type ReportPayload = {
  key: string;
  from: string;
  to: string;
  granularity: string;
  series: string[];
  rows: ReportRow[];
  totals: Record<string, number>;
  generatedAt: string;
};

export type ReportViewProps = {
  result: ReportPayload;
  /** How this report is drawn; decided server-side from the report key. */
  chart: "bars" | "line" | "rank";
  /** "Volume · Sep 1 to Sep 30 ET" — the chart's accessible caption. */
  caption: string;
};

/** Which totals earn a tile: the whole-range summary, in the order the report declared them. */
function tileKeys(totals: Record<string, number>): string[] {
  return Object.keys(totals).slice(0, 8);
}

export function ReportView({ result, chart, caption }: ReportViewProps): React.JSX.Element {
  const [showData, setShowData] = useState(false);
  const tiles = tileKeys(result.totals);
  const columns = [...result.series];

  return (
    <section className="flex flex-col gap-4" data-report={result.key}>
      {tiles.length > 0 ? (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {tiles.map((key) => (
            <li key={key} className="rounded-lg border bg-card p-3 text-card-foreground">
              <p className="text-xs text-muted-foreground">{seriesLabel(key)}</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">{formatSeriesValue(key, result.totals[key])}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {chart === "rank" ? (
        <ReportRankChart rows={result.rows} series={result.series} caption={caption} />
      ) : (
        <ReportTimeChart rows={result.rows} series={result.series} kind={chart} caption={caption} />
      )}

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between md:w-auto md:justify-start"
          aria-expanded={showData}
          aria-controls={`report-data-${result.key}`}
          onClick={() => setShowData((v) => !v)}
        >
          <span className="flex items-center gap-2">
            <Table2 aria-hidden />
            {showData ? "Hide the numbers" : `Show the numbers (${result.rows.length})`}
          </span>
          <ChevronDown aria-hidden className={showData ? "rotate-180 transition-transform" : "transition-transform"} />
        </Button>

        <div id={`report-data-${result.key}`} hidden={!showData}>
          {result.rows.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No rows in this range.
            </p>
          ) : (
            <>
              {/* Phone: one card per row, every column as a labelled pair — no horizontal scroll. */}
              <ul className="flex flex-col gap-2 md:hidden">
                {result.rows.map((row) => (
                  <li key={row.bucket} className="rounded-lg border bg-card p-3 text-card-foreground">
                    <p className="text-sm font-medium">{row.label}</p>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                      {columns.map((c) => (
                        <div key={c} className="flex items-baseline justify-between gap-2">
                          <dt className="truncate text-xs text-muted-foreground">{seriesLabel(c)}</dt>
                          <dd className="shrink-0 tabular-nums">{formatSeriesValue(c, row.values[c])}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>

              {/* md+: the table, in the one element-level horizontal scroller R2 allows. */}
              <div data-slot="table-container" className="relative hidden w-full overflow-x-auto rounded-lg border md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Period</TableHead>
                      {columns.map((c) => (
                        <TableHead key={c} scope="col" className="text-right">
                          {seriesLabel(c)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((row) => (
                      <TableRow key={row.bucket}>
                        <TableCell className="font-medium">{row.label}</TableCell>
                        {columns.map((c) => (
                          <TableCell key={c} className="text-right tabular-nums">
                            {formatSeriesValue(c, row.values[c])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
