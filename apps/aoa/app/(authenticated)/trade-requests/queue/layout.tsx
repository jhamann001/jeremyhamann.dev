import { RequestStatusActions } from "@/components/trade-requests/detail/status-actions";
import { ResubmitCloneActions } from "@/components/trade-requests/detail/resubmit-clone-actions";
import { QueueExportAction } from "@/components/trade-requests/queue/export-action";
import { TradingQueue } from "@/components/trade-requests/queue/TradingQueue";
import { getRequestSession } from "@/lib/auth/request-session";
import { tradeRequestExporter } from "@/lib/trade-requests/detail-view";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";

// The Trading Queue and any request opened over it (/trade-requests/queue/{id})
// share this layout, so moving between them never remounts the queue.
export default async function TradeRequestsQueueLayout({ children }: { children: React.ReactNode }) {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  const session = await getRequestSession();
  const exporter = tradeRequestExporter(session?.user);
  return (
    <>
      <TradingQueue
        reviewer={access.role === "ADMIN" || access.role === "OPERATIONS"}
        role={access.role}
        exporter={exporter}
        actions={<QueueExportAction exporter={exporter} />}
        detail={{ actions: <><RequestStatusActions role={access.role} /><ResubmitCloneActions role={access.role} /></> }}
      />
      {children}
    </>
  );
}
