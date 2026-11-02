import { auth } from "@/auth";
import { canReadAudit, listAuditLog } from "@/lib/data/audit-log";
import { listRowChanges } from "@/lib/data/row-changes";
import { parseAuditNavigationQuery } from "@/lib/navigation/audit-query";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "audit_results_unavailable" }, { status: 503, headers: { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": "" } }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  if (!canReadAudit(identity.role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  let query;
  try { query = parseAuditNavigationQuery(new URL(request.url).searchParams, true); }
  catch { return Response.json({ error: "invalid_audit_query" }, { status: 400, headers }); }
  try {
    const result = query.view === "changes" ? await listRowChanges(identity, query) : await listAuditLog(identity, query);
    if (!result.ok) return Response.json({ error: "forbidden" }, { status: 403, headers });
    if (query.snapshot && query.snapshot !== result.snapshot) return Response.json({ error: "audit_results_changed" }, { status: 409, headers });
    if (query.page > result.pageCount) return Response.json({ error: "audit_page_out_of_range" }, { status: 416, headers });
    const { rows, page, pageSize, pageCount, total, snapshot } = result;
    const meta = { actions: "actions" in result ? result.actions : [], actors: result.actors,
      tables: "tables" in result ? result.tables : [], ops: "ops" in result ? result.ops : [] };
    return Response.json({ rows, page, pageSize, pageCount, total, snapshot, meta }, { headers });
  } catch { return Response.json({ error: "audit_results_unavailable" }, { status: 503, headers }); }
}
