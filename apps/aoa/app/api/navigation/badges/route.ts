import { auth } from "@/auth";
import { navCounts } from "@/lib/data/nav-counts";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "navigation_counts_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  if (new URL(request.url).search) return Response.json({ error: "invalid_navigation_counts_query" }, { status: 400, headers });
  if (request.signal.aborted) return Response.json({ error: "navigation_counts_unavailable" }, { status: 503, headers });
  try {
    const counts = await navCounts({ role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null });
    return Response.json(counts, { headers });
  } catch { return Response.json({ error: "navigation_counts_unavailable" }, { status: 503, headers }); }
}
