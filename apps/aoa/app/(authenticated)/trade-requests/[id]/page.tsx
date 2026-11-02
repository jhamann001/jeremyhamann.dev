import { getRequestSession } from "@/lib/auth/request-session";
import { loadTradeRequestDetail } from "@/lib/trade-requests/detail";
import { tradeRequestExporter } from "@/lib/trade-requests/detail-view";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";
import { TradeRequestsNotSetUp } from "@/components/trade-requests/WorkspaceNotices";
import { QueueExportAction } from "@/components/trade-requests/queue/export-action";
import { TradingQueue } from "@/components/trade-requests/queue/TradingQueue";
import { RequestStatusActions } from "@/components/trade-requests/detail/status-actions";
import { ResubmitCloneActions } from "@/components/trade-requests/detail/resubmit-clone-actions";
import type { QueueDirectDetail } from "@/components/trade-requests/queue/QueueRequestDetail";

// A direct link: the Trading Queue with the request (loaded here) over it,
// including its Pre-approval Checklist.
export default async function TradeRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  const { id } = await params;
  const [load, session] = await Promise.all([loadTradeRequestDetail(id), getRequestSession()]);
  if (load.kind === "not_set_up") return <TradeRequestsNotSetUp />;
  const direct: QueueDirectDetail = load.kind === "found"
    ? { id, kind: "found", request: load.request, accounts: load.accounts }
    : load.kind === "failed" ? { id, kind: "failed", message: load.message } : { id, kind: "not_found" };
  const exporter = tradeRequestExporter(session?.user);
  return (
    <TradingQueue
      reviewer={access.role === "ADMIN" || access.role === "OPERATIONS"}
      role={access.role}
      exporter={exporter}
      actions={<QueueExportAction exporter={exporter} />}
      direct={direct}
      detail={{ actions: <><RequestStatusActions role={access.role} /><ResubmitCloneActions role={access.role} /></> }}
    />
  );
}
