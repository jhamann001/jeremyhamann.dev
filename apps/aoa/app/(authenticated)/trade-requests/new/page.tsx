import { PageHeader } from "@/components/ui";
import { NewRequestSubmitForm } from "@/components/trade-requests/form/submit/NewRequestSubmit";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import { NEW_REQUEST_COPY } from "@/lib/trade-requests/new-request";
import styles from "@/components/trade-requests/form/NewRequestForm.module.css";

export default async function TradeRequestsNewRequestPage() {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  return (
    <div className={styles.page}>
      <PageHeader eyebrow={TRADE_REQUESTS_COPY.eyebrow} title={NEW_REQUEST_COPY.pageTitle} />
      <NewRequestSubmitForm />
    </div>
  );
}
