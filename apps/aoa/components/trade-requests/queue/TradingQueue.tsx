"use client";

import { useMemo, type ReactNode } from "react";
import { IconSearch } from "@/components/icons";
import { Button, Card, CardBody, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { TradeRequestStatusPill } from "@/components/trade-requests/status-pill";
import { TradeRequestsNotSetUp } from "@/components/trade-requests/WorkspaceNotices";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import {
  QUEUE_COPY, QUEUE_SEARCH_MAX, emptyQueueMessage, householdLabel, queueColumns, sortQueueEntries, submitterLabel,
  type QueueSort, type QueueSortKey, type TradeRequestListEntry,
} from "@/lib/trade-requests/queue-model";
import type { TradeRequestExporter } from "@/lib/trade-requests/request-types";
import { useTradeRequestsQueue } from "./QueueProvider";
import { QueueRequestDetail, useQueueRequestHistory, type QueueDetailSlots, type QueueDirectDetail } from "./QueueRequestDetail";
import { TradeRequestsSessionEnded } from "./SessionEndedNotice";
import styles from "./TradingQueue.module.css";

function ariaSort(sort: QueueSort, key: QueueSortKey) {
  if (sort.key !== key) return "none" as const;
  return sort.dir === "asc" ? "ascending" as const : "descending" as const;
}

function SortArrow({ sort, column }: { sort: QueueSort; column: QueueSortKey }) {
  if (sort.key !== column) return <span aria-hidden="true" className={styles.arrowIdle}>↕</span>;
  return <span aria-hidden="true" className={styles.arrow}>{sort.dir === "asc" ? "↑" : "↓"}</span>;
}

function QueueRow({ entry, reviewer, onOpen }: { entry: TradeRequestListEntry; reviewer: boolean; onOpen: (id: string) => void }) {
  return (
    <TR
      className={styles.row}
      tabIndex={0}
      aria-label={QUEUE_COPY.viewRequest(entry.id)}
      data-request-id={entry.id}
      onClick={() => onOpen(entry.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(entry.id);
        }
      }}
    >
      <TD className={styles.requestId}>{entry.id}</TD>
      <TD className={styles.household}>{householdLabel(entry)}</TD>
      <TD>{entry.tradeType}</TD>
      <TD>{entry.date ? new Date(entry.date).toLocaleDateString() : ""}</TD>
      {reviewer ? (
        <>
          <TD>{entry.advisor}</TD>
          <TD>{submitterLabel(entry)}</TD>
        </>
      ) : null}
      <TD><TradeRequestStatusPill status={entry.status} /></TD>
    </TR>
  );
}

type TradingQueueProps = {
  reviewer: boolean;
  /** The viewer's AOA role (ADMIN, OPERATIONS or ADVISOR), for the request's checklist. */
  role: string;
  /** The signed-in person, printed as the exporter on a request's PDF. */
  exporter: TradeRequestExporter;
  /** Page-header slot for queue-level controls such as export. */
  actions?: ReactNode;
  /** The request a direct link loaded, shown over the queue. */
  direct?: QueueDirectDetail;
  /** The request dialog's actions slot, used however the request was opened; the checklist tab is built in. */
  detail?: QueueDetailSlots;
};

/** The Trading Queue, with any open request (its address) shown as a dialog over it. */
export function TradingQueue({ reviewer, role, exporter, actions, direct, detail }: TradingQueueProps) {
  const history = useQueueRequestHistory();
  const queue = useTradeRequestsQueue();
  const columns = queueColumns(reviewer);
  const sorted = useMemo(() => sortQueueEntries(queue.entries, queue.sort), [queue.entries, queue.sort]);

  if (queue.signedOut) return <TradeRequestsSessionEnded />;
  if (queue.notSetUp) return <TradeRequestsNotSetUp />;

  const listed = queue.entries.length > 0;
  let body: ReactNode;
  if (queue.loading && !listed) {
    body = (
      <Card aria-busy="true">
        <CardBody className={styles.state}><p role="status" aria-live="polite">{QUEUE_COPY.loading}</p></CardBody>
      </Card>
    );
  } else if (queue.error && !listed) {
    body = (
      <Card data-testid="trade-requests-queue-failed">
        <CardBody className={styles.state}>
          <p role="alert" className={styles.failure}>{queue.error}</p>
          <Button onClick={queue.retry}>{QUEUE_COPY.retry}</Button>
        </CardBody>
      </Card>
    );
  } else {
    body = (
      <>
        {queue.error ? (
          <div role="alert" className={styles.banner}>
            <span>{QUEUE_COPY.refreshFailed}</span>
            <button type="button" className={styles.bannerRetry} onClick={queue.retry}>{QUEUE_COPY.retry}</button>
          </div>
        ) : null}
        <Card className={styles.tableCard}>
          <div className={styles.scroller}>
            <Table className={styles.table}>
              <caption className={styles.caption}>{QUEUE_COPY.caption}</caption>
              <THead>
                <tr>
                  {columns.map((column) => (
                    <TH key={column.key} scope="col" className={styles.sortable} aria-sort={ariaSort(queue.sort, column.key)}>
                      <button type="button" className={styles.sortButton} onClick={() => queue.sortBy(column.key)}>
                        {column.label}
                        <SortArrow sort={queue.sort} column={column.key} />
                      </button>
                    </TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {sorted.map((entry) => <QueueRow key={entry.id} entry={entry} reviewer={reviewer} onOpen={history.open} />)}
                {sorted.length === 0 ? (
                  <tr>
                    <TD colSpan={columns.length} className={styles.empty}>{emptyQueueMessage(queue.searchInput)}</TD>
                  </tr>
                ) : null}
              </TBody>
            </Table>
          </div>
        </Card>
        {queue.hasMore ? (
          <div className={styles.more} aria-live="polite" aria-busy={queue.loadingMore}>
            <Button variant="ghost" onClick={queue.loadMore} disabled={queue.loadingMore}>
              {queue.loadingMore ? QUEUE_COPY.loadingMore : QUEUE_COPY.loadMore}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={styles.queue} aria-busy={queue.loading}>
      <QueueRequestDetail openId={history.openId} close={history.close} role={role} exporter={exporter} direct={direct} slots={detail} />
      <PageHeader eyebrow={TRADE_REQUESTS_COPY.eyebrow} title={QUEUE_COPY.queueTitle} actions={actions} />
      <label className={styles.search}>
        <IconSearch aria-hidden="true" className={styles.searchIcon} />
        <input
          type="search"
          value={queue.searchInput}
          onChange={(event) => queue.setSearchInput(event.target.value)}
          placeholder={QUEUE_COPY.searchPlaceholder}
          aria-label={QUEUE_COPY.searchLabel}
          maxLength={QUEUE_SEARCH_MAX}
        />
      </label>
      {body}
    </div>
  );
}
