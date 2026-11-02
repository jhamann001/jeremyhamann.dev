"use client";

import Link from "next/link";
import { Button, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { historyRowId } from "@/lib/navigation/reconciliation-history-pages";
import { reconciliationHref, type ReconciliationHistoryView } from "@/lib/operations/reconciliation-history-query";
import { useReconciliationHistory } from "./useReconciliationHistory";
import styles from "./TradeReconciliationPrototype.module.css";

function date(value?: string) {
  return value ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${value}T00:00:00.000Z`)) : "—";
}

export function ReconciliationHistoryWorkspace({ view, scope, href }: { view: ReconciliationHistoryView; scope: string; href: string }) {
  const history = useReconciliationHistory(view, scope, href);
  return <div ref={history.rootRef} aria-busy={history.status === "loading"}>
    {history.page && <>
      <p role="status">{history.page.rows.length} of {history.page.total} {view === "daily" ? "saved runs" : "periods"} shown</p>
      <div className={styles.tableWrap}><Table>
        <THead><TR>{view === "daily" ? <><TH>Run date</TH><TH>Trade date</TH><TH>Completed at</TH></> : <TH>Period</TH>}<TH>Raw matches</TH><TH>Explained</TH><TH>Unresolved</TH><TH>Meridian match rate</TH></TR></THead>
        <TBody>{history.page.rows.map((row) => <TR key={historyRowId(row, view)} data-history-id={historyRowId(row, view)}>
          {view === "daily" ? <>
            <TD><b><Link href={reconciliationHref({ tab: "current", history: "daily", run: row.runId })} onClick={() => history.rememberRun(row.runId!)}>{date(row.runDate ?? row.period)} →</Link></b></TD>
            <TD>{date(row.tradeDate)}</TD>
            <TD>{row.completedAt ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(row.completedAt)) : "—"}</TD>
          </> : <TD><b>{row.period}</b></TD>}
          <TD>{row.matched}</TD><TD>{row.explained}</TD><TD>{row.unresolved}</TD><TD>{row.rate}</TD>
        </TR>)}</TBody>
      </Table></div>
      {history.page.total === 0 && <p className={styles.empty}>No saved reconciliation history.</p>}
    </>}
    {history.notice && <p role="status">{history.notice}</p>}
    {history.status === "loading" && <p role="status">Loading reconciliation history…</p>}
    {history.status === "unauthorized" && <p role="status">Your session changed. Reloading authorized history…</p>}
    {history.status === "changed" && <p role="alert">Saved history changed while you were browsing. Refresh history to load a consistent result.</p>}
    {history.status === "error" && <p role="alert">History could not be loaded. Your loaded rows are retained.</p>}
    {["error", "changed"].includes(history.status) && <Button size="sm" onClick={history.retry}>{history.status === "changed" ? "Refresh history" : "Retry history"}</Button>}
    {history.status === "idle" && (history.canLoadMore
      ? <Button size="sm" onClick={history.loadMore}>{history.windowFull ? "Next 5,000 runs" : "Load more history"}</Button>
      : history.page && history.page.total > 0 && <p role="status">End of reconciliation history.</p>)}
    <div ref={history.sentinelRef} aria-hidden="true" />
  </div>;
}
