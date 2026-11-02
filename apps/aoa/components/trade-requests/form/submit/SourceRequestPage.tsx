import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { RequestLoadFailed, RequestNotFound } from "@/components/trade-requests/detail/DirectLinkStates";
import { TradeRequestsNotSetUp } from "@/components/trade-requests/WorkspaceNotices";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import { NEW_REQUEST_COPY } from "@/lib/trade-requests/new-request";
import { canCloneToNewRequest, canEditAndResubmit, type SourceFormMode } from "@/lib/trade-requests/new-request-submit";
import { tradeRequestDetailRoute } from "@/lib/trade-requests/routes";
import { loadSourceRequest } from "@/lib/trade-requests/submit";
import styles from "../NewRequestForm.module.css";
import { SourceRequestForm } from "./NewRequestSubmit";

/**
 * The edit and clone forms. The source is read when the form opens, so a
 * resubmission is checked against that version. An address for an action the
 * viewer is not offered (AC-46, AC-47) shows the request instead.
 */
export async function SourceRequestPage({ mode, id, role }: { mode: SourceFormMode; id: string; role: string }) {
  const load = await loadSourceRequest(id);
  if (load.kind === "not_set_up") return <TradeRequestsNotSetUp />;
  if (load.kind === "not_found") return <RequestNotFound />;
  if (load.kind === "failed") return <RequestLoadFailed message={load.message} />;
  const { request } = load;
  const offered = mode === "edit" ? canEditAndResubmit(role, request.status) : canCloneToNewRequest(role, request.status);
  if (!offered) redirect(tradeRequestDetailRoute(request.id));
  return (
    <div className={styles.page}>
      <PageHeader eyebrow={TRADE_REQUESTS_COPY.eyebrow} title={NEW_REQUEST_COPY.pageTitle} />
      <SourceRequestForm key={`${mode}-${request.id}`} mode={mode} source={request} />
    </div>
  );
}
