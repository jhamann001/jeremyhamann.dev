import { auth } from "@/auth";
import { reconciliationHistoryPage } from "@/lib/data/reconciliation-history";
import { operationsTradeReconciliationPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { parseReconciliationHistoryQuery } from "@/lib/operations/reconciliation-history-query";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const headers = { ...NO_STORE, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsTradeReconciliationPreviewEnabled() || !canAccessOperationsTools(role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  let query;
  try { query = parseReconciliationHistoryQuery(new URL(request.url).searchParams); }
  catch { return Response.json({ error: "invalid_history_query" }, { status: 400, headers }); }
  try {
    const result = await reconciliationHistoryPage({ role, email: session.user.email ?? null }, query.view, query.page);
    if (query.snapshot !== null && result.snapshot !== query.snapshot) return Response.json({ error: "history_changed" }, { status: 409, headers });
    if (query.page > result.pageCount) return Response.json({ error: "page_out_of_range" }, { status: 416, headers });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: "history_unavailable" }, { status: 503, headers });
  }
}
