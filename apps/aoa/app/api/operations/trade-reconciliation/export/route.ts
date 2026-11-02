import { auth } from "@/auth";
import { exportTradeReconciliationRuns } from "@/lib/data/trade-reconciliation-export";
import { operationsTradeReconciliationPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { csvAttachment, tradeReconciliationRunsToCsv } from "@/lib/operations/operations-export-csv";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const FILENAME = "trade-reconciliation-runs.csv";

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const headers = { ...NO_STORE, "X-AOA-Navigation-Scope": session.navigationScope ?? "" };
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsTradeReconciliationPreviewEnabled() || !canAccessOperationsTools(role)) {
    return Response.json({ error: "forbidden" }, { status: 403, headers });
  }
  if (new URL(request.url).searchParams.size > 0) {
    return Response.json({ error: "invalid_trade_reconciliation_export" }, { status: 400, headers });
  }
  try {
    const rows = await exportTradeReconciliationRuns({ role, email: session.user.email ?? null });
    return csvAttachment(tradeReconciliationRunsToCsv(rows), FILENAME, headers);
  } catch {
    return Response.json({ error: "trade_reconciliation_export_unavailable" }, { status: 503, headers });
  }
}
