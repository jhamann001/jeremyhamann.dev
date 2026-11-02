import { auth } from "@/auth";
import { listCrmIdentityWindow } from "@/lib/data/crm-explorer";
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
    try { query = parseCrmWindowRequest(new URL(request.url).searchParams, false); }
    catch { return respond({ error: "invalid_crm_window_query" }, 400); }
    const result = await listCrmIdentityWindow({ role: (session.user as { role?: string }).role ?? "VIEWER", email: session.user.email ?? null }, {
      q: query.filters.query, type: query.filters.type, state: query.filters.state, exceptionsOnly: query.filters.exceptionsOnly,
    }, query.window);
    if (!result.ok) return result.reason === "forbidden"
      ? respond({ error: "forbidden" }, 403) : respond({ error: "disabled" }, 404);
    const { ok: _ok, ...page } = result;
    return respond(page);
  } catch (error) {
    if (error instanceof WindowPageError && error.kind === "changed") return respond({ error: "crm_window_changed" }, 409);
    return respond({ error: "crm_window_unavailable" }, 503);
  }
}
