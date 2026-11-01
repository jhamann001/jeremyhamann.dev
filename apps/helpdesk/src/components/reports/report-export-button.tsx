import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportExportHref, type ReportQueryLike } from "@/components/reports/report-query-params";

/**
 * Plain anchor to `/api/reports/export`, styled as a button — no client component, no fetch, no blob:
 * the browser downloads the route's response and the route is the thing that authorizes and records it.
 *
 * The href is built from the SAME serializer the filter bar navigates with, so the file always covers
 * the set on screen. The caption is not decoration: `REPORT_EXPORTED` is written before the first
 * byte, and an operator should know that before they click, not discover it in a ledger
 * review afterwards.
 */
export function ReportExportButton({ query }: { query: ReportQueryLike }): React.JSX.Element {
  return (
    <div className="flex flex-col items-stretch gap-0.5 md:items-end">
      <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
        <a href={reportExportHref(query)} download data-report-export>
          <Download aria-hidden />
          Download CSV
        </a>
      </Button>
      <span className="text-center text-[11px] text-muted-foreground md:text-right">Export is itself audited</span>
    </div>
  );
}
