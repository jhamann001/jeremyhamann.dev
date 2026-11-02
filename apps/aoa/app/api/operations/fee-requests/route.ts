import { auth } from "@/auth";
import { operationsFeeRequestDirectory } from "@/lib/data/operations-fee-requests";
import { operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { parseFeeRequestQuery } from "@/lib/operations/fee-request-query";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const headers = { ...NO_STORE, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsFeeRequestsPreviewEnabled() || !canAccessOperationsTools(role)) {
    return Response.json({ error: "unavailable" }, { status: 403, headers });
  }
  let query;
  try { query = parseFeeRequestQuery(new URL(request.url).searchParams); }
  catch { return Response.json({ error: "invalid_fee_request_query" }, { status: 400, headers }); }
  try {
    const result = await operationsFeeRequestDirectory({ role, email: session.user.email ?? null }, query);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof Error && error.message === "fee_request_directory_changed") {
      return Response.json({ error: "fee_request_directory_changed" }, { status: 409, headers });
    }
    if (error instanceof Error && error.message === "fee_request_page_out_of_range") {
      return Response.json({ error: "fee_request_page_out_of_range" }, { status: 416, headers });
    }
    return Response.json({ error: "fee_request_directory_unavailable" }, { status: 503, headers });
  }
}
