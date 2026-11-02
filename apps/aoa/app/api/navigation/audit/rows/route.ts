import { auth } from "@/auth";
import { canReadAudit } from "@/lib/data/audit-log";
import { listRowChangeWindow } from "@/lib/data/row-changes";
import { parseAuditWindowQuery } from "@/lib/navigation/audit-window-query";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "audit_rows_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  if (!canReadAudit(identity.role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  let query;
  try { query = parseAuditWindowQuery(new URL(request.url).searchParams); }
  catch { return Response.json({ error: "invalid_audit_window" }, { status: 400, headers }); }
  try {
    const result = await listRowChangeWindow(identity, query);
    if (!result.ok) {
      return result.reason === "forbidden"
        ? Response.json({ error: "forbidden" }, { status: 403, headers })
        : Response.json({ error: "audit_rows_changed" }, { status: 409, headers });
    }
    const { rows, firstPage, pageSize, loaded, snapshot, hasMore, meta } = result;
    return Response.json({ rows, firstPage, pageSize, loaded, snapshot, hasMore, meta }, { headers });
  } catch { return Response.json({ error: "audit_rows_unavailable" }, { status: 503, headers }); }
}
