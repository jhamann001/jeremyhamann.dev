import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardBody, Pill, SectionLabel } from "@/components/ui";
import {
  operationsAcatTransferDashboardEnabled,
  operationsFeeRequestsPreviewEnabled,
  operationsToolsEnabled,
  operationsTradeReconciliationPreviewEnabled,
} from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import styles from "./page.module.css";

export default async function OperationsToolsPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsToolsEnabled() || !canAccessOperationsTools(role)) notFound();
  const tradePreviewEnabled = operationsTradeReconciliationPreviewEnabled();
  const feeRequestsEnabled = operationsFeeRequestsPreviewEnabled();
  const transferDashboardEnabled = operationsAcatTransferDashboardEnabled();
  const isDevelopment = process.env.APP_ENV?.toLowerCase() === "dev";

  return (
    <>
      <SectionLabel>Operations · Internal tools</SectionLabel>
      <div className={styles.titleRow}>
        <div>
          <h1>Operations Tools</h1>
          <p>AOA-native operating workflows replacing the remaining FeeStore tools in controlled releases.</p>
        </div>
        <Pill tone="gold">{isDevelopment ? "Development" : "Operations"}</Pill>
      </div>

      <div className={styles.notice} role="note">
        {isDevelopment
          ? <><b>Development rollout.</b> Trade Reconciliation and controlled fee-request intake are available for testing.</>
          : <><b>Operations workflows.</b> Run trade reconciliation, review saved history, and manage fee requests.</>}
      </div>

      <div className={styles.grid}>
        <Card className={styles.toolCard}>
          <CardBody>
            <div className={styles.cardTop}><span className={styles.number}>01</span><Pill tone={tradePreviewEnabled ? "green" : "gray"}>{tradePreviewEnabled ? (isDevelopment ? "Live in dev" : "Available") : "Disabled"}</Pill></div>
            <h2>Trade Reconciliation</h2>
            <p>Run the account-aware comparison, isolate breaks, explain valid exceptions, and inspect saved history.</p>
            {tradePreviewEnabled ? <Link className={styles.action} href="/operations/trade-reconciliation" prefetch>Open reconciliation →</Link> : <span className={styles.disabled}>Not enabled in this environment</span>}
          </CardBody>
        </Card>

        <Card className={styles.toolCard}>
          <CardBody>
            <div className={styles.cardTop}><span className={styles.number}>02</span><Pill tone={feeRequestsEnabled ? "green" : "gray"}>{feeRequestsEnabled ? (isDevelopment ? "Live in dev" : "Available") : "Disabled"}</Pill></div>
            <h2>Fee Credits &amp; Service Guarantees</h2>
            <p>Submit account-linked fee-credit and billing-exception requests to a controlled pending queue.</p>
            {feeRequestsEnabled ? <Link className={styles.action} href="/operations/fee-requests" prefetch>Open request intake →</Link> : <span className={styles.disabled}>Not enabled in this environment</span>}
          </CardBody>
        </Card>

        {transferDashboardEnabled && (
          <Card className={styles.toolCard}>
            <CardBody>
              <div className={styles.cardTop}><span className={styles.number}>03</span><Pill tone="green">{isDevelopment ? "Live in dev" : "Available"}</Pill></div>
              <h2>Transfer Dashboard</h2>
              <p>Review transfer volume, cycle time, residuals, data quality, and reconciliation supplied by the tracker.</p>
              <Link className={styles.action} href="/operations/transfer-dashboard" prefetch>Open transfer dashboard →</Link>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
