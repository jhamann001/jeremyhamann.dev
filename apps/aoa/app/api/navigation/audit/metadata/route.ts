import { auth } from "@/auth";
import { canReadAudit } from "@/lib/data/audit-log";
import { getRowChangeMetadata } from "@/lib/data/row-changes";
import { parseAuditMetadataQuery } from "@/lib/navigation/audit-window-query";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "audit_metadata_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  if (!canReadAudit(identity.role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  let query;
  try { query = parseAuditMetadataQuery(new URL(request.url).searchParams); }
  catch { return Response.json({ error: "invalid_audit_metadata_query" }, { status: 400, headers }); }
  try {
    const result = await getRowChangeMetadata(identity, query);
    if (!result.ok) return Response.json({ error: "forbidden" }, { status: 403, headers });
    const { total, tables, ops, actors } = result;
    return Response.json({ total, tables, ops, actors }, { headers });
  } catch { return Response.json({ error: "audit_metadata_unavailable" }, { status: 503, headers }); }
}
