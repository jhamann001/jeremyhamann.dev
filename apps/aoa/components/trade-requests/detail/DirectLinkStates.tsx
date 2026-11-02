"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, Card } from "@/components/ui";
import { REQUEST_DETAIL_COPY } from "@/lib/trade-requests/detail-view";
import { TRADE_REQUESTS_ROUTES } from "@/lib/trade-requests/routes";
import styles from "./RequestDetail.module.css";

function BackToQueue({ variant }: { variant: "primary" | "ghost" }) {
  return (
    <Link href={TRADE_REQUESTS_ROUTES.tradingQueue} prefetch={false}>
      <Button variant={variant} tabIndex={-1}>{REQUEST_DETAIL_COPY.backToQueue}</Button>
    </Link>
  );
}

export function RequestNotFound() {
  return (
    <Card data-testid="trade-request-not-found">
      <div className={styles.state}>
        <p className={styles.stateText}>{REQUEST_DETAIL_COPY.notFound}</p>
        <BackToQueue variant="primary" />
      </div>
    </Card>
  );
}

/** Retry loads the request again; the message is the service's text when it gave one. */
export function RequestLoadFailed({ message }: { message: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Card data-testid="trade-request-load-failed">
      <div className={styles.state}>
        <p className={styles.stateError} role="alert">{message || REQUEST_DETAIL_COPY.loadFailed}</p>
        <div className={styles.stateActions}>
          <Button variant="primary" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{REQUEST_DETAIL_COPY.retry}</Button>
          <BackToQueue variant="ghost" />
        </div>
      </div>
    </Card>
  );
}
