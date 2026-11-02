import { auth } from "@/auth";
import { getDealDirectory, exportMatchingDeals } from "@/lib/data/deals";
import { canSeeArchivedDeals } from "@/lib/data/deal-archive";
import { dealsToCsv } from "@/components/deals/deal-export";
import { parseDealsQuery } from "@/lib/navigation/deals-query";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "deals_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const identity = { role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null };
  let query;
  try { query = parseDealsQuery(new URL(request.url).searchParams, true); }
  catch { return Response.json({ error: "invalid_deals_query" }, { status: 400, headers }); }
  if (query.filters.archived && !canSeeArchivedDeals(identity.role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try {
    if (query.exportCsv) {
      const rows = await exportMatchingDeals(identity, query.filters);
      return new Response(dealsToCsv(rows), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=deals-export.csv" } });
    }
    const page = await getDealDirectory(identity, query.filters, query.page, query.pageSize);
    if (query.snapshot && query.snapshot !== page.snapshot) return Response.json({ error: "deals_changed" }, { status: 409, headers });
    if (query.page > page.pageCount) return Response.json({ error: "deals_page_out_of_range" }, { status: 416, headers });
    return Response.json(page, { headers });
  } catch { return Response.json({ error: "deals_unavailable" }, { status: 503, headers }); }
}
