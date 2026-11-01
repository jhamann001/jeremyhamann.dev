import { BarChart3 } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canReadReports } from "@/lib/rbac";
import { FIRM_TIME_ZONE_LABEL } from "@/lib/firm-time";
import { REPORT_GRANULARITIES } from "@/types/domain";
import { readableQueueOptions, runExtendedReport } from "@/server/reports";
import {
  EXTENDED_REPORT_KEYS,
  EXTENDED_REPORT_LABELS,
  REPORT_CHART_KINDS,
  REPORT_DESCRIPTIONS,
  REPORT_PRESETS,
  REPORT_PRESET_LABELS,
  activePreset,
  formatReportDate,
  isTimeSeriesReport,
  parseReportQuery,
  presetRange,
} from "@/server/reports-query";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportExportButton } from "@/components/reports/report-export-button";
import { ReportFilters } from "@/components/reports/report-filters";
import { ReportView } from "@/components/reports/report-view";

export const dynamic = "force-dynamic";

/**
 * Reports — B7 (reporting). The GATE below is the foundation's and is kept VERBATIM.
 *
 * Authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather than a 403
 * so the page's existence does not leak to someone who may not use it. Middleware refuses this path too
 * (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative — and
 * `@/server/reports` re-checks a third time by narrowing every query to the viewer's readable queues.
 *
 * The page itself writes NO audit row. A report is aggregate counts over rows the viewer can already
 * list and carries no record content, so §e's definition of a view does not reach it (CONTRACT §3.3
 * rule 5). The EXPORT is audited, before its first byte, by `/api/reports/export`.
 *
 * A router prefetch renders the skeleton instead of running the query: percentile aggregates over the
 * whole ticket table are the most expensive read in the app, and a hover should not buy one (I11's
 * reasoning applied to cost rather than to evidence).
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canReadReports(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "reports:read path:/reports");
    notFound();
  }

  const query = parseReportQuery(await searchParams);

  if (ctx.isPrefetch) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const now = new Date();
  const result = await runExtendedReport(viewer, query, ctx);
  const queues = readableQueueOptions(viewer);
  const caption = `${EXTENDED_REPORT_LABELS[query.key]}, ${formatReportDate(result.from)} to ${formatReportDate(result.to)}`;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:gap-2">
        <div className="flex min-w-0 items-center gap-2 md:mr-auto">
          <BarChart3 aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
            <p className="text-xs text-muted-foreground">{REPORT_DESCRIPTIONS[query.key]}</p>
          </div>
        </div>
        <ReportExportButton query={query} />
      </header>

      <ReportFilters
        query={query}
        reports={EXTENDED_REPORT_KEYS.map((key) => ({ key, label: EXTENDED_REPORT_LABELS[key] }))}
        queues={queues.map((q) => ({ key: q.key, label: q.label }))}
        granularities={REPORT_GRANULARITIES.map((g) => ({
          key: g,
          label: g === "day" ? "Day" : g === "week" ? "Week" : "Month",
        }))}
        presets={REPORT_PRESETS.map((key) => {
          const r = presetRange(key, now);
          return { key, label: REPORT_PRESET_LABELS[key], from: r.from, to: r.to, granularity: r.granularity };
        })}
        activePreset={activePreset(query, now)}
        supportsGranularity={isTimeSeriesReport(query.key)}
      />

      <ReportView result={result} chart={REPORT_CHART_KINDS[query.key]} caption={caption} />

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        Periods are firm-local ({FIRM_TIME_ZONE_LABEL}) and cover {formatReportDate(result.from)} through{" "}
        {formatReportDate(result.to)} inclusive. Counts are limited to the queues you can read, and tickets
        voided as entered in error are excluded from every figure except the void counter on Desk health.
      </footer>
    </div>
  );
}
