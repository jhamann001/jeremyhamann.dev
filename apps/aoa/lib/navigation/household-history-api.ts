import "server-only";
import { auth } from "@/auth";
import { getHouseholdHistoryPage } from "@/lib/data/household-history";
import { parseHouseholdHistoryQuery, type HouseholdHistoryKind } from "./household-history-query";
import { NAVIGATION_HEADERS } from "./progressive-page";

export async function householdHistoryResponse(request: Request, kind: HouseholdHistoryKind): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "household_history_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  let query;
  try { query = parseHouseholdHistoryQuery(new URL(request.url).searchParams, kind); }
  catch { return Response.json({ error: "invalid_household_history_query" }, { status: 400, headers }); }
  try {
    const result = await getHouseholdHistoryPage({
      role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null,
    }, query.householdId, kind, query);
    if (!result) return Response.json({ error: "household_unavailable" }, { status: 404, headers });
    if (query.snapshot && query.snapshot !== result.snapshot) return Response.json({ error: "household_history_changed" }, { status: 409, headers });
    if (result.page !== query.page) return Response.json({ error: "household_history_page_out_of_range" }, { status: 416, headers });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: "household_history_unavailable" }, { status: 503, headers });
  }
}
