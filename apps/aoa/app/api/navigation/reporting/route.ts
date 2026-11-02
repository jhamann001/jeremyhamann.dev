import { auth } from "@/auth";
import { getCrmReportingDatasets } from "@/lib/data/crm-reporting";
import { crmReportProgressivePage, parseCrmReportNavigationRequest } from "@/lib/crm/reporting-query";

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
    let parsed;
    try { parsed = parseCrmReportNavigationRequest(new URL(request.url).searchParams); }
    catch { return respond({ error: "invalid_report_query" }, 400); }
    const result = await getCrmReportingDatasets({
      role: (session.user as { role?: string }).role ?? "VIEWER",
      email: session.user.email ?? null,
    }, parsed.query);
    if (!result.ok) return respond({ error: result.reason }, result.reason === "disabled" ? 404 : 403);
    const dataset = result.datasets[0];
    if (!dataset?.available || !dataset.snapshot || dataset.rowIds?.length !== dataset.rows.length) {
      return respond({ error: "report_unavailable" }, 503);
    }
    if (parsed.snapshot !== null && parsed.snapshot !== dataset.snapshot) return respond({ error: "report_changed" }, 409);
    if (dataset.page !== parsed.query.page) return respond({ error: "report_page_out_of_range" }, 416);
    return respond(crmReportProgressivePage(dataset));
  } catch { return respond({ error: "report_unavailable" }, 503); }
}
