import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { AcatTransferDashboard } from "@/components/operations/AcatTransferDashboard";
import { readAcatDashboard } from "@/lib/data/acat-dashboard";
import { operationsAcatTransferDashboardEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import styles from "@/components/operations/AcatTransferDashboard.module.css";

export const dynamic = "force-dynamic";

export default async function TransferDashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canAccessOperationsTools(role) || !operationsAcatTransferDashboardEnabled()) notFound();
  const result = await readAcatDashboard();
  if (result.ok) return <AcatTransferDashboard dashboard={result.dashboard} />;
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Transfer operations</h1>
        <p className={styles.subtitle}>Operational outcomes, cycle time, residual sweeps, and reconciliation coverage</p>
      </header>
      <div className={styles.body}>
        <div role="status" className={styles.errorBanner}>
          Transfer dashboard is unavailable.{" "}
          <Link className={styles.retry} href="/operations/transfer-dashboard">Retry</Link>
        </div>
      </div>
    </div>
  );
}
