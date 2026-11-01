/**
 * GET /api/reports/export — CSV of one report table.
 *
 * Same order as the two Wave A exports, because the order IS the control: authenticate (401) →
 * authorize `reports:read` with the denial recorded (403) → parse the filters → run the report →
 * write `REPORT_EXPORTED` with the row count → only then hand back the body. `reportCsv` does the last
 * two steps and awaits the ledger row before the stream exists, so a downloaded report can never
 * predate its entry.
 *
 * This route is deliberately INSIDE the middleware matcher: it is a staff surface behind the session,
 * not a machine surface, and a redirect to /sign-in is the right answer for a browser that has been
 * signed out. `/api/mcp`, `/api/ingest`, `/api/export` and `/api/integrations` are the exclusions, and
 * this is not one of them (guardrails G3b/G3c).
 *
 * There is no `scope` parameter and no compliance-only variant, because there is nothing to gate: a
 * report is counts, percentiles and enum values over tickets the viewer can already list. The file
 * carries no subject, no requester, no body and no comment — the row count on the ledger entry is the
 * whole of what left.
 */
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { UnauthorizedError } from "@/lib/errors";
import { csvExportFilename } from "@/lib/export-filename";
import { canReadReports } from "@/lib/rbac";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { requireViewerOrThrow } from "@/lib/session";
import { reportCsvExtended } from "@/server/reports";
import { parseReportQuery } from "@/server/reports-query";
import type { Viewer } from "@/types/domain";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    }
    throw e;
  }

  const ctx = getRequestContextFromRequest(req);
  const actor = actorFromViewer(viewer);

  if (!canReadReports(viewer.groups)) {
    // I5: every denial is evidence. A failed denial row fails the request rather than answering 403
    // unrecorded.
    await recordDenied(actor, ctx, "reports:read path:/api/reports/export");
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const sp = new URL(req.url).searchParams;
  const query = parseReportQuery(sp);

  const stream = await reportCsvExtended(viewer, query, ctx);

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvExportFilename(`report-${query.key}`, query.granularity, new Date())}"`,
      ...NO_STORE,
    },
  });
}
