import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { TradeReconciliationPrototype } from "@/components/operations";
import { Pill, SectionLabel } from "@/components/ui";
import { tradeReconciliationPageData } from "@/lib/data/trade-reconciliation";
import { operationsTradeReconciliationPreviewEnabled } from "@/lib/flags";
import { toDateStr } from "@/lib/market-calendar";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { reconciliationNavigation } from "@/lib/operations/reconciliation-history-query";
import { RunReconciliationForm } from "./RunReconciliationForm";
import styles from "./page.module.css";

type QueryValue = string | string[] | undefined;

function first(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function TradeReconciliationPage({ searchParams }: {
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!operationsTradeReconciliationPreviewEnabled() || !canAccessOperationsTools(role)) notFound();
  const query = await searchParams;
  const identity = { role, email: session.user.email ?? null };
  const data = await tradeReconciliationPageData(identity, first(query.run));
  const maximumRunDate = toDateStr(new Date());
  const initialRunDate = first(query.date) ?? data.run?.runDate ?? maximumRunDate;
  const message = first(query.message);
  const isDevelopment = process.env.APP_ENV?.toLowerCase() === "dev";
  const navigation = reconciliationNavigation(new URLSearchParams(Object.entries(query).flatMap(([key, value]) => {
    const item = first(value);
    return item === undefined ? [] : [[key, item]];
  })));

  return (
    <>
      <Link className={styles.back} href="/operations" prefetch>← Operations Tools</Link>
      <SectionLabel>Operations · Trade reconciliation</SectionLabel>
      <div className={styles.titleRow}>
        <div><h1>Trade Reconciliation</h1><p>Compare Apex and Meridian records, then explain operational exceptions without rewriting the raw result.</p></div>
        <div className={styles.titleActions}>
          <a className={styles.exportLink} href="/api/operations/trade-reconciliation/export">Export all runs</a>
          <Pill tone="green">{isDevelopment ? "Live development data" : "Saved reconciliation history"}</Pill>
        </div>
      </div>
      <RunReconciliationForm
        key={`${data.run?.id ?? "blank"}:${initialRunDate}`}
        initialRunDate={initialRunDate}
        maximumRunDate={maximumRunDate}
      />
      {message === "run-complete" && <p className={styles.success} role="status">Reconciliation completed and saved.</p>}
      {message === "invalid-date" && <p className={styles.error} role="alert">Choose a valid NYSE run date on or before today.</p>}
      {message === "run-failed" && <p className={styles.error} role="alert">The source query or save failed. No incomplete run was stored.</p>}
      {message === "source-truncated" && <p className={styles.error} role="alert">The warehouse returned an incomplete source response. No reconciliation was saved. Retry after the source query can return every record.</p>}
      {message === "source-limit-exceeded" && <p className={styles.error} role="alert">This reconciliation supports up to 10,000 rows per source. The selected date exceeds that limit, so no reconciliation was saved. Larger runs require source pagination.</p>}
      <div className={styles.runMeta} role="note">
        <span><b>Run date</b>{data.run?.runDate ?? "No run selected"}</span>
        <span><b>Trade date</b>{data.run?.tradeDate ?? "—"}</span>
        <span><b>Completed at</b>{data.run ? displayTimestamp(data.run.completedAt) : "—"}</span>
        <span><b>Algorithm</b>{data.run?.algorithmVersion ?? "account-aware-v2"}</span>
        <span><b>Run ID</b><code>{data.run?.id ?? "—"}</code></span>
      </div>
      <div className={styles.warning}>{isDevelopment && <b>Development only. </b>}This page reads fixed, reviewed warehouse queries. Access is limited to Operations/Admin, account IDs are masked before persistence, and source rows never enter logs.</div>
      <TradeReconciliationPrototype
        key={data.run?.id ?? "blank"}
        currentRunAvailable={Boolean(data.run)}
        initialRows={data.run?.rows ?? []}
        initialHistory={data.history}
        historyInitiallyLoaded={data.historyLoaded}
        initialRunNote={data.run?.runNote ?? ""}
        liveRunId={data.run?.id ?? null}
        initialSummary={data.run?.summary ?? null}
        historyIsSynthetic={false}
        navigationScope={session.navigationScope ?? ""}
        initialNavigation={navigation}
      />
    </>
  );
}
