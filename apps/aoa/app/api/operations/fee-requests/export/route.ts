import { auth } from "@/auth";
import { operationsFeeRequestExportRows } from "@/lib/data/operations-fee-requests";
import { operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { csvAttachment, feeRequestExportFilename, feeRequestsToCsv } from "@/lib/operations/operations-export-csv";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", Vary: "Cookie" };

function exportArea(url: string): "credits" | "exceptions" | null {
  const params = new URL(url).searchParams;
  const names = [...params.keys()];
  if (names.length !== 1 || names[0] !== "area") return null;
  const area = params.get("area");
  return area === "credits" || area === "exceptions" ? area : null;
}

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const headers = { ...NO_STORE, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsFeeRequestsPreviewEnabled() || !canAccessOperationsTools(role)) {
    return Response.json({ error: "unavailable" }, { status: 403, headers });
  }
  const area = exportArea(request.url);
  if (!area) return Response.json({ error: "invalid_fee_request_export" }, { status: 400, headers });
  try {
    const rows = await operationsFeeRequestExportRows({ role, email: session.user.email ?? null }, area);
    return csvAttachment(feeRequestsToCsv(rows), feeRequestExportFilename(area), headers);
  } catch {
    return Response.json({ error: "fee_request_export_unavailable" }, { status: 503, headers });
  }
}
