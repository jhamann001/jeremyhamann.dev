import { useState } from "react";
import { Button, Pill, StatTile, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import {
  MAX_BACKFILL_FOLDERS,
  type ClientLinkPage,
  type ClientLinkQueueItem,
  type ClientLinkReviewState,
} from "@/lib/data/asset-map-client-link-contract";
import {
  CLIENT_LINK_COPY,
  QUEUE_FILTERS,
  canBulk,
  filterKey,
  queueFilterCounts,
  queueStats,
  reviewStateTone,
  selectAllToggles,
  selectAllView,
  type FailureView,
  type FolderSelection,
  type QueueFilterTotals,
  type QueueStatus,
} from "./client-link-model";
import { ClientLinkErrorNotice, WritesDisabledNotice } from "./ClientLinkNotices";
import styles from "./ClientLinking.module.css";

export type ClientLinkQueueProps = {
  page: ClientLinkPage;
  status: QueueStatus;
  failure: FailureView | null;
  reviewState: ClientLinkReviewState | null;
  query: string;
  selection: FolderSelection;
  canReview: boolean;
  /** Defaults to `!canReview`; false for a read-only role while writes are on. */
  writesDisabled?: boolean;
  onReviewState: (state: ClientLinkReviewState | null) => void;
  onQuery: (query: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onToggle: (item: ClientLinkQueueItem) => void;
  onPreviewBackfill: () => void;
  onReview: (runId: string) => void;
  onViewRun: (runId: string) => "select" | "not_loaded";
  filterTotals?: QueueFilterTotals;
};

export function ClientLinkQueue(props: ClientLinkQueueProps) {
  const { page, status, failure, reviewState, query, selection, canReview, writesDisabled = !canReview } = props;
  const [notLoaded, setNotLoaded] = useState(false);
  const stats = queueStats(page);
  const counts = queueFilterCounts(props.filterTotals ?? {});
  const full = selection.size >= MAX_BACKFILL_FOLDERS;
  const selectAll = selectAllView(page.items, selection);
  const viewRun = (runId: string) => setNotLoaded(props.onViewRun(runId) === "not_loaded");

  return (
    <section className={styles.section} aria-label={CLIENT_LINK_COPY.tabLinking}>
      {writesDisabled ? <WritesDisabledNotice text={CLIENT_LINK_COPY.writesDisabledQueue} /> : null}
      <div className={styles.stats}>
        <StatTile label={CLIENT_LINK_COPY.statFolders} value={stats.folders} caption={`${page.items.length} loaded`} />
        <StatTile label={CLIENT_LINK_COPY.statReady} value={stats.readyToBackfill} />
        <StatTile label={CLIENT_LINK_COPY.statComplete} value={stats.complete} />
        <StatTile label={CLIENT_LINK_COPY.statCoverage} value={`${stats.coverage.linked} / ${stats.coverage.runs}`} />
      </div>
      <ClientLinkErrorNotice failure={failure} onRetry={props.onRetry} />
      {notLoaded ? <div role="status" className={styles.notice}>{CLIENT_LINK_COPY.runNotLoaded}</div> : null}
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="group" aria-label={CLIENT_LINK_COPY.filterGroup}>
          {QUEUE_FILTERS.map((f) => {
            const count = counts[filterKey(f.id)];
            return (
              <button
                key={f.label}
                type="button"
                className={styles.segment}
                data-tone={f.id ? reviewStateTone(f.id) : undefined}
                aria-pressed={reviewState === f.id}
                onClick={() => props.onReviewState(f.id)}
              >
                <span>{f.label}</span>
                {count != null ? <span className={styles.segmentCount} data-filter-count={filterKey(f.id)}>{count}</span> : null}
              </button>
            );
          })}
        </div>
        <input
          className={styles.search}
          aria-label={CLIENT_LINK_COPY.searchFolders}
          placeholder={CLIENT_LINK_COPY.searchFolders}
          value={query}
          maxLength={200}
          onChange={(e) => props.onQuery(e.target.value)}
        />
      </div>
      <Table>
        <THead>
          <TR>
            <TH>
              {canReview ? (
                <input
                  type="checkbox"
                  aria-label={CLIENT_LINK_COPY.selectAll}
                  checked={selectAll.checked}
                  disabled={selectAll.disabled || status === "loading"}
                  onChange={() => selectAllToggles(page.items, selection).forEach((item) => props.onToggle(item))}
                />
              ) : null}
            </TH>
            <TH>Source folder</TH>
            <TH>Client link</TH>
            <TH>Existing runs</TH>
            <TH />
          </TR>
        </THead>
        <TBody>
          {page.items.map((item) => {
            const people = item.folder?.decision.people ?? [];
            const selected = selection.has(item.scope_key);
            return (
              <TR key={item.scope_key}>
                <TD>
                  {canReview ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.client_name} for backfill`}
                      checked={selected}
                      disabled={!canBulk(item) || (full && !selected)}
                      onChange={() => props.onToggle(item)}
                    />
                  ) : null}
                </TD>
                <TD>
                  <strong>{item.client_name}</strong>
                  <div className={styles.muted}>{item.source_scope?.source_folder_id ?? item.representative_run_id}</div>
                </TD>
                <TD>
                  <Pill tone={reviewStateTone(item.review_state)}>{item.review_state}</Pill>
                  <div className={styles.muted}>{people.map((p) => p.display_name).join(" + ")}</div>
                </TD>
                <TD>
                  {item.run_count - item.unlinked_run_count} of {item.run_count} linked
                </TD>
                <TD>
                  <div className={styles.actions}>
                    <Button size="sm" variant="ghost" onClick={() => viewRun(item.representative_run_id)}>
                      {CLIENT_LINK_COPY.viewRun}
                    </Button>
                    {canReview ? (
                      <Button size="sm" onClick={() => props.onReview(item.representative_run_id)}>
                        {people.length > 0 ? CLIENT_LINK_COPY.manage : CLIENT_LINK_COPY.review}
                      </Button>
                    ) : null}
                  </div>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      {status === "loading" ? <p className={styles.muted} aria-busy="true">Loading…</p> : null}
      {page.next_cursor ? (
        <Button size="sm" variant="ghost" disabled={status === "loading"} onClick={props.onLoadMore}>
          {CLIENT_LINK_COPY.loadMore}
        </Button>
      ) : null}
      {canReview ? (
        <div className={styles.footer}>
          <span className={styles.muted}>{selection.size} selected</span>
          <Button size="sm" disabled={selection.size === 0} onClick={props.onPreviewBackfill}>
            {CLIENT_LINK_COPY.previewBackfill}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
