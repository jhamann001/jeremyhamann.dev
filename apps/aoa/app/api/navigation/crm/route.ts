import { auth } from "@/auth";
import { listCrmIdentities } from "@/lib/data/crm-explorer";
import { parseCrmNavigationRequest } from "@/components/crm/crm-navigation-query";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let scope = "";
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store", Vary: "Cookie", "X-AOA-Navigation-Scope": scope,
  } });
  try {
    const session = await auth();
    scope = session?.navigationScope ?? "";
    if (!session?.user) return respond({ error: "unauthorized" }, 401);
    let query;
    try { query = parseCrmNavigationRequest(new URL(request.url).searchParams, false); }
    catch { return respond({ error: "invalid_crm_query" }, 400); }
    const result = await listCrmIdentities({
      role: (session.user as { role?: string }).role ?? "VIEWER",
      email: session.user.email ?? null,
    }, {
      q: query.filters.query, type: query.filters.type, state: query.filters.state,
      exceptionsOnly: query.filters.exceptionsOnly, page: query.page, pageSize: query.pageSize,
    });
    if (!result.ok) return respond({ error: result.reason }, result.reason === "forbidden" ? 403 : 404);
    if (query.snapshot !== null && query.snapshot !== result.snapshot) return respond({ error: "crm_list_changed" }, 409);
    if (result.page > result.pageCount) return respond({ error: "crm_page_out_of_range" }, 416);
    return respond({
      rows: result.rows, page: result.page, pageSize: result.pageSize, total: result.total,
      pageCount: result.pageCount, snapshot: result.snapshot, meta: result.stats,
    });
  } catch { return respond({ error: "crm_list_unavailable" }, 503); }
}
