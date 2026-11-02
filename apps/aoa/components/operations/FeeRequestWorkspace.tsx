"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader, StatTile } from "@/components/ui";
import type { OperationsFeeRequestDirectory } from "@/lib/data/operations-fee-requests";
import { DEFAULT_FEE_REQUEST_FILTERS, FEE_REQUEST_STATUSES, feeRequestListHref, feeRequestSearchParams, parseFeeRequestQuery, type FeeRequestFilters } from "@/lib/operations/fee-request-query";
import { FeeRequestCard } from "./FeeRequestCard";
import { useProgressiveFeeRequests } from "./useProgressiveFeeRequests";
import styles from "@/app/(authenticated)/operations/fee-requests/page.module.css";

export function FeeRequestWorkspace({ initial, filters, scope, defaultCreditedDate }: {
  initial: OperationsFeeRequestDirectory; filters: FeeRequestFilters; scope: string; defaultCreditedDate: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(filters);
  const [filterError, setFilterError] = useState("");
  const [pending, startTransition] = useTransition();
  const list = useProgressiveFeeRequests(initial, filters, scope, feeRequestListHref(filters, initial.page));
  const { directory, loadState } = list;
  const busy = pending || loadState === "loading" || loadState === "restoring";
  function navigate(next: FeeRequestFilters, page = 1) {
    try { parseFeeRequestQuery(feeRequestSearchParams(next)); }
    catch { setFilterError("Choose a valid submitted-date range, with the start on or before the end."); return; }
    setFilterError("");
    setDraft(next);
    if (!pending && feeRequestListHref(next, page) === feeRequestListHref(filters, initial.page)) return;
    list.pause();
    startTransition(() => router.push(feeRequestListHref(next, page), { scroll: false }));
  }
  const first = directory.total === 0 ? 0 : (directory.page - 1) * directory.pageSize + 1;
  const last = directory.rows.length ? first + directory.rows.length - 1 : 0;
  const counts = directory.counts;
  return (
    <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"}>
      <nav className={styles.tabs} aria-label="Request work areas">
        <button type="button" aria-current={filters.tab === "credits" ? "page" : undefined} disabled={pending}
          onClick={() => navigate({ ...filters, tab: "credits", type: "", sort: "submitted" })}>Fee credits</button>
        <button type="button" aria-current={filters.tab === "exceptions" ? "page" : undefined} disabled={pending}
          onClick={() => navigate({ ...filters, tab: "exceptions", type: "", sort: "submitted" })}>Service guarantees &amp; exceptions</button>
      </nav>
      <div className={styles.stats}>
        <StatTile label="Pending" value={counts.pending} />
        <StatTile label="Approved" value={counts.approved} />
        <StatTile label="Credited" value={counts.credited} />
        <StatTile label="Rejected / cancelled" value={counts.closed} />
      </div>
      <p className={styles.countNote}>Counts include all requests matching the selected work area and filters.</p>
      <Card className={styles.queueCard}>
        <CardHeader className={styles.cardHeader}>
          <h2>{filters.tab === "credits" ? "Fee credits" : "Service guarantees & exceptions"}</h2>
          <p>Search the complete authorized history. Submitted dates use Eastern time.</p>
        </CardHeader>
        <CardBody>
          <form className={styles.toolbar} onSubmit={(event) => { event.preventDefault(); navigate(draft); }}>
            <label className={styles.searchField}>Search client, household or request ID
              <input type="search" value={draft.query} maxLength={256} onChange={(event) => setDraft({ ...draft, query: event.target.value })} placeholder="Search requests" />
            </label>
            {filters.tab === "exceptions" && <label>Request type
              <select aria-label="Request type" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as FeeRequestFilters["type"] })}>
                <option value="">All exception types</option><option value="SERVICE_GUARANTEE">Service guarantee</option>
                <option value="BILLING_EXCEPTION">Billing exception</option><option value="LARGE_HOUSEHOLD_EXCEPTION">$10M+ household billing exception</option>
              </select>
            </label>}
            <label>Status<select aria-label="Status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as FeeRequestFilters["status"] })}>
              <option value="">All statuses</option>{FEE_REQUEST_STATUSES.map((status) => <option key={status} value={status}>{status[0] + status.slice(1).toLowerCase()}</option>)}
            </select></label>
            <label>Submitted from<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
            <label>Submitted through<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
            <label>Sort by<select aria-label="Sort by" value={draft.sort} onChange={(event) => setDraft({ ...draft, sort: event.target.value as FeeRequestFilters["sort"] })}>
              <option value="submitted">Submitted date</option>{filters.tab === "credits" ? <option value="amount">Recorded credit amount</option> : <option value="waiver">Waiver start</option>}
            </select></label>
            <label>Order<select aria-label="Order" value={draft.dir} onChange={(event) => setDraft({ ...draft, dir: event.target.value as FeeRequestFilters["dir"] })}>
              <option value="desc">{draft.sort === "amount" ? "Highest first" : "Newest first"}</option><option value="asc">{draft.sort === "amount" ? "Lowest first" : "Oldest first"}</option>
            </select></label>
            <div className={styles.toolbarActions}><button type="submit" disabled={pending}>Apply filters</button><button type="button" disabled={pending}
              onClick={() => navigate({ ...DEFAULT_FEE_REQUEST_FILTERS, tab: filters.tab })}>Reset filters</button></div>
          </form>
          {filterError && <p role="alert" className={styles.error}>{filterError}</p>}
          <p role="status" className={styles.resultCount}>{pending ? "Updating results…" : `${first.toLocaleString()}–${last.toLocaleString()} of ${directory.total.toLocaleString()} matching requests`}</p>
          {list.notice && <p role="status" className={styles.warning}>{list.notice}</p>}
          {loadState === "changed" ? <p role="alert" className={styles.warning}>Requests or your access changed. Refresh these results before continuing. <button onClick={list.retry}>Refresh results</button></p> :
            loadState === "unauthorized" ? <p role="status">Your session changed. Reloading authorized results…</p> :
            <div className={styles.requestList} aria-busy={busy}>
              {directory.rows.map((request) => <FeeRequestCard key={request.id} request={request} defaultCreditedDate={defaultCreditedDate}
                open={list.expandedIds.includes(request.id)} onToggle={(open) => list.toggleExpanded(request.id, open)}
                onOpen={() => list.rememberRequest(request.id)} />)}
              {!directory.rows.length && !busy && loadState !== "error" && <p className={styles.empty}>No requests match these filters.</p>}
            </div>}
          <div ref={list.sentinelRef} className={styles.paging}>
            {loadState === "error" && <p role="alert">The next results could not be loaded. <button onClick={list.retry}>Retry</button></p>}
            {busy && <p role="status">{loadState === "restoring" ? "Restoring your place in authorized results…" : "Loading requests…"}</p>}
            {list.canLoadMore && loadState !== "changed" && loadState !== "unauthorized" && <button type="button" disabled={busy} onClick={() => void list.loadMore()}>Load more requests</button>}
            {!list.canLoadMore && directory.total > 0 && loadState === "idle" && (list.lastPage < directory.pageCount
              ? <button type="button" onClick={() => navigate(filters, list.lastPage + 1)}>Continue to the next results</button>
              : <p role="status">All matching requests are shown{directory.page > 1 ? " in this final window" : ""}.</p>)}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
