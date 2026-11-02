"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, CardBody, Kpi, PageHeader, SectionLabel } from "@/components/ui";
import { TradeRequestsNotSetUp } from "@/components/trade-requests/WorkspaceNotices";
import { TradeRequestsSessionEnded } from "@/components/trade-requests/queue/SessionEndedNotice";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import { fetchTradeRequestCounts } from "@/lib/trade-requests/queue-fetch";
import { COUNT_TILES, QUEUE_COPY, type TradeRequestCounts } from "@/lib/trade-requests/queue-model";
import { TRADE_REQUESTS_ROUTES } from "@/lib/trade-requests/routes";
import styles from "./TradeRequestsHome.module.css";

type CountsState = { status: "loading" } | { status: "ready"; counts: TradeRequestCounts } | { status: "failed" } | { status: "not_set_up" } | { status: "signed_out" };

export function TradeRequestsHome({ firstName, reviewer }: { firstName: string; reviewer: boolean }) {
  const [state, setState] = useState<CountsState>({ status: "loading" });

  const controller = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ status: "loading" });
    fetchTradeRequestCounts(current.signal).then((result) => {
      if (current.signal.aborted) return;
      if (result.ok) setState({ status: "ready", counts: result.data });
      else setState({ status: result.outcome === "failed" ? "failed" : result.outcome });
    }, () => undefined);
  }, []);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);

  if (state.status === "signed_out") return <TradeRequestsSessionEnded />;
  if (state.status === "not_set_up") return <TradeRequestsNotSetUp />;

  return (
    <div className={styles.home}>
      <PageHeader eyebrow={TRADE_REQUESTS_COPY.eyebrow} title={QUEUE_COPY.homeTitle(firstName)} description={QUEUE_COPY.homeDescription} />
      {state.status === "failed" ? (
        <Card className={styles.statsError} data-testid="trade-requests-stats-failed">
          <CardBody className={styles.statsErrorBody}>
            <span>{QUEUE_COPY.statsError}</span>
            <Button size="sm" onClick={load}>{QUEUE_COPY.retry}</Button>
          </CardBody>
        </Card>
      ) : (
        <div className={styles.tiles} aria-busy={state.status === "loading"}>
          {COUNT_TILES.map((tile) => (
            <Card key={tile.key} title={tile.hint} data-count={tile.key}>
              <Kpi label={tile.label} value={state.status === "ready" ? state.counts[tile.key] : "…"} />
            </Card>
          ))}
        </div>
      )}
      <SectionLabel>{QUEUE_COPY.quickActions}</SectionLabel>
      <div className={styles.actions}>
        <Link href={TRADE_REQUESTS_ROUTES.newRequest} prefetch={false} className={styles.action}>
          <Card className={styles.actionCard}>
            <CardBody>
              <strong>{QUEUE_COPY.newRequestCard}</strong>
              <span>{QUEUE_COPY.newRequestDescription}</span>
            </CardBody>
          </Card>
        </Link>
        <Link href={TRADE_REQUESTS_ROUTES.tradingQueue} prefetch={false} className={styles.action}>
          <Card className={styles.actionCard}>
            <CardBody>
              <strong>{QUEUE_COPY.queueCard}</strong>
              <span>{reviewer ? QUEUE_COPY.queueReviewerDescription : QUEUE_COPY.queueAdvisorDescription}</span>
            </CardBody>
          </Card>
        </Link>
      </div>
    </div>
  );
}
