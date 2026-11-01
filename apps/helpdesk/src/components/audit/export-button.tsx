import { Download } from "lucide-react";
import type { AuditQuery } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { auditQueryToParams } from "@/components/audit/audit-query-params";

/**
 * Plain anchor to the CSV route, styled as a button. The current filters travel in the query string
 * through the shared serializer (convention 12); the cursor is dropped so the export always covers the
 * whole filtered set, not the page the viewer happens to be on. The route writes AUDIT_LOG_EXPORTED
 * before the first byte streams, which is what the caption tells the user.
 */
export function ExportButton({ query }: { query: AuditQuery }): React.JSX.Element {
  const href = "/api/compliance/audit/export?" + auditQueryToParams(query, { includeCursor: false }).toString();
  return (
    <div className="flex flex-col items-stretch gap-0.5 md:items-end">
      <Button asChild variant="outline" size="sm" className="w-full md:w-auto">
        <a href={href} download data-audit-export>
          <Download aria-hidden />
          Export CSV
        </a>
      </Button>
      <span className="text-center text-[11px] text-muted-foreground md:text-right">Export is itself audited</span>
    </div>
  );
}
