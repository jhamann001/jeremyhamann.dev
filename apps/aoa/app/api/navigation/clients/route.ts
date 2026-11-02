import { auth } from "@/auth";
import { getClientDirectory } from "@/lib/data/clients";
import { parseClientDirectoryQuery } from "@/lib/navigation/client-query";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "client_directory_unavailable" }, { status: 503, headers: { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": "" } }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  let query;
  try { query = parseClientDirectoryQuery(new URL(request.url).searchParams, true); }
  catch { return Response.json({ error: "invalid_client_query" }, { status: 400, headers }); }
  try {
    const page = await getClientDirectory({
      role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null,
    }, query.filters, query.page, query.pageSize);
    if (query.snapshot && query.snapshot !== page.snapshot) return Response.json({ error: "client_directory_changed" }, { status: 409, headers });
    if (query.page !== page.page) return Response.json({ error: "client_page_out_of_range" }, { status: 416, headers });
    return Response.json({ ...page, meta: { counts: page.counts } }, { headers });
  } catch {
    return Response.json({ error: "client_directory_unavailable" }, { status: 503, headers });
  }
}
