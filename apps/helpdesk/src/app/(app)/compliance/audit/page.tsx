import { ScrollText } from "lucide-react";
import { getRequestContext } from "@/lib/request-context";
import { requireGroup } from "@/lib/session";
import { queryAuditLog } from "@/server/audit-log";
import { parseAuditQuery } from "@/server/validation";
import { Skeleton } from "@/components/ui/skeleton";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { ChainVerifyButton } from "@/components/audit/chain-verify-button";
import { ExportButton } from "@/components/audit/export-button";

export const dynamic = "force-dynamic";

/**
 * Compliance Audit Log. compliance_officers only — `requireGroup`
 * redirects everyone else to /no-access (whose render records the denial). Rendering this page is itself
 * evidence: `queryAuditLog` writes AUDIT_LOG_VIEWED with the applied filters before returning rows, and a
 * failed insert throws into the (app) error boundary so no rows are shown unrecorded.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const viewer = await requireGroup("compliance_officers");
  const q = parseAuditQuery(await searchParams);
  const ctx = await getRequestContext();

  // CONTRACT-GAP: §g S7 does not mention a prefetch guard for this page and queryAuditLog does not check
  // ctx.isPrefetch. I11's rule ("a prefetch is not a human action and is never logged") is the conservative
  // reading, so a router prefetch renders a skeleton and writes no AUDIT_LOG_VIEWED row; only a real
  // navigation does.
  if (ctx.isPrefetch) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const page = await queryAuditLog(viewer, q, ctx);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:gap-2">
        <div className="flex min-w-0 items-center gap-2 md:mr-auto">
          <ScrollText aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Compliance Audit Log</h1>
            <p className="text-xs text-muted-foreground">
              Append-only, hash-chained ledger of every view, change and denial. Newest first.
            </p>
          </div>
        </div>
        {/* Phone: one 2-col row of 44px controls; the verdict Alert spans below it (col-span-full, order-last).
            md+: `contents` dissolves the wrapper so both sit in the header row as before. */}
        <div className="grid grid-cols-2 items-start gap-2 md:contents">
          <ChainVerifyButton />
          <ExportButton query={q} />
        </div>
      </header>

      <AuditFilters query={q} />

      <AuditTable page={page} query={q} />

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        Viewing and exporting this log are themselves recorded.
      </footer>
    </div>
  );
}
