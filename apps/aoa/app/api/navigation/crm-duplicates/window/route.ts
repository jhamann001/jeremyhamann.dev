import { auth } from "@/auth";
import { listCrmDuplicateWindow } from "@/lib/data/crm-duplicate-review";
import { parseCrmWindowRequest } from "@/lib/navigation/crm-window-query";
import { WindowPageError } from "@/lib/navigation/window-page";

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
    try { query = parseCrmWindowRequest(new URL(request.url).searchParams, true); }
    catch { return respond({ error: "invalid_crm_window_query" }, 400); }
    const result = await listCrmDuplicateWindow({ role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null },
      query.filters.duplicateView, query.filters.type || null, query.window);
    if (!result.ok) return result.reason === "forbidden"
      ? respond({ error: "forbidden" }, 403) : respond({ error: "disabled" }, 404);
    const { ok: _ok, ...page } = result;
    return respond(page);
  } catch (error) {
    if (error instanceof WindowPageError && error.kind === "changed") return respond({ error: "crm_window_changed" }, 409);
    return respond({ error: "crm_window_unavailable" }, 503);
  }
}
