import { auth } from "@/auth";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { fetchAcatList } from "@/lib/data/acat-status";
import { buildAcatTracking } from "@/lib/data/acat-tracking";
import { NAVIGATION_HEADERS } from "@/lib/navigation/progressive-page";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  let session;
  try { session = await auth(); }
  catch { return Response.json({ error: "acat_count_unavailable" }, { status: 503, headers: NAVIGATION_HEADERS }); }
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NAVIGATION_HEADERS });
  const headers = { ...NAVIGATION_HEADERS, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  if (!canSeeUnlinkedAcats((session.user as { role?: string }).role)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  if (new URL(request.url).search) return Response.json({ error: "invalid_acat_count_query" }, { status: 400, headers });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 5_000);
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal.aborted) controller.abort();
    const rows = await fetchAcatList({ signal: controller.signal });
    return Response.json({ count: buildAcatTracking(rows).summary.inFlight }, { headers });
  } catch { return Response.json({ error: "acat_count_unavailable" }, { status: 503, headers }); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
}
