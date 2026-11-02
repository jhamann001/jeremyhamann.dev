"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadTransferFeeRequests } from "@/app/(authenticated)/acat-tracking/fee-requests-actions";
import { formatDrawerDate } from "@/lib/data/acat-drawer-contract";
import {
  FEE_REQUEST_KIND_LABELS,
  FEE_REQUESTS_COPY,
  feeRequestsTruncatedNote,
  TRANSFER_FEE_REQUESTS_LIMIT,
  type TransferFeeRequestsRead,
} from "@/lib/data/acat-fee-requests-view";
import { reimbursementRequestHref, reimbursementStatusChip } from "@/lib/data/acat-reimbursement-view";
import { LoaderCircle } from "./transfer-fee-icons";
import styles from "./TransferFeeSection.module.css";

type State =
  | { kind: "loading" }
  | { kind: "ready"; read: TransferFeeRequestsRead }
  | { kind: "failed" }
  | { kind: "hidden" };

const TONE_CLASS = {
  warning: styles.toneWarning, info: styles.toneInfo, success: styles.toneSuccess, danger: styles.toneDanger, neutral: styles.toneNeutral,
} as const;

// Lists the Operations Tools requests already on file for the open transfer's client and
// Apex account. It reads once when it mounts (the fee section is keyed by record, so once per drawer
// open), again only on Retry or when `reloadKey` changes, and never from the tracker.
export function TransferFeeRequestsList({ recordId, cedarRidgeUserId, maskedAccount, feeRequestsHref, reloadKey, feeCreditRequestId }: {
  recordId: string;
  cedarRidgeUserId: string | null;
  maskedAccount: string | null;
  feeRequestsHref: string | null;
  reloadKey: number;
  /** Only this exact stored request id identifies a request as linked to this transfer. */
  feeCreditRequestId?: string | null;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const request = useRef(0);

  const read = useCallback(async () => {
    const current = ++request.current;
    setState((previous) => (previous.kind === "ready" ? previous : { kind: "loading" }));
    try {
      const result = await loadTransferFeeRequests(recordId, { cedarRidgeUserId, maskedAccount });
      if (request.current !== current) return;
      if (result.ok) setState({ kind: "ready", read: result.read });
      else if (result.code === "off" || result.code === "forbidden") setState({ kind: "hidden" });
      else setState({ kind: "failed" });
    } catch {
      if (request.current === current) setState({ kind: "failed" });
    }
  }, [recordId, cedarRidgeUserId, maskedAccount]);

  useEffect(() => {
    void read();
    return () => { request.current += 1; };
  }, [read, reloadKey]);

  if (state.kind === "hidden") return null;

  return (
    <div className={`${styles.card} ${styles.cardBody}`} data-testid="fee-requests-on-file">
      <h3 className={styles.requestsTitle}>{FEE_REQUESTS_COPY.title}</h3>
      {state.kind === "loading" && (
        <div role="status" className={styles.checking}>
          <LoaderCircle size={14} className={styles.spin} />
          <span>{FEE_REQUESTS_COPY.loading}</span>
        </div>
      )}
      {state.kind === "failed" && (
        <div role="alert" className={styles.logFailure}>
          <span>{FEE_REQUESTS_COPY.failed}</span>
          <button type="button" className={styles.retry} aria-label="Retry requests on file" onClick={() => void read()}>{FEE_REQUESTS_COPY.retry}</button>
        </div>
      )}
      {state.kind === "ready" && state.read.identity === "unresolved" && (
        <p role="status" className={styles.requestsText}>
          {state.read.reason === "client" ? FEE_REQUESTS_COPY.unresolvedClient : FEE_REQUESTS_COPY.unresolvedAccount}
        </p>
      )}
      {state.kind === "ready" && state.read.identity === "resolved" && (
        <>
          <p className={styles.requestsText}>{state.read.clientName} · {state.read.accountLabel}</p>
          {state.read.requests.length === 0 ? (
            <p role="status" className={styles.requestsText}>{FEE_REQUESTS_COPY.none}</p>
          ) : (
            <ul className={styles.divide} aria-label={FEE_REQUESTS_COPY.title}>
              {state.read.requests.map((item) => {
                const chip = reimbursementStatusChip(item.status);
                const credited = item.creditedAt ? formatDrawerDate(item.creditedAt) : "";
                return (
                  <li key={item.id} className={styles.logRow} data-testid="fee-request-on-file">
                    <div className={styles.logLeft}>
                      <span className={`${styles.statusChip} ${TONE_CLASS[chip.tone]}`}>{chip.label}</span>
                      <span className={styles.logAmount}>{item.feeAmount ? `$${item.feeAmount}` : "—"}</span>
                      <span className={styles.logType}>{[FEE_REQUEST_KIND_LABELS[item.kind], ...item.feeTypes].join(" · ")}</span>
                      <span className={styles.logDate}>Request ID {item.id}</span>
                      {feeCreditRequestId && item.id === feeCreditRequestId && (
                        <span className={`${styles.statusChip} ${styles.toneInfo}`}>Linked to this transfer</span>
                      )}
                      <span className={styles.logDate}>{FEE_REQUESTS_COPY.submitted} {formatDrawerDate(item.submittedAt)}</span>
                      {credited !== "" && <span className={styles.logDate}>{FEE_REQUESTS_COPY.credited} {credited}</span>}
                    </div>
                    {feeRequestsHref && (
                      <Link href={reimbursementRequestHref(feeRequestsHref, item.id)} className={styles.pendingLink}>{FEE_REQUESTS_COPY.open}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {state.read.truncated && <p className={styles.requestsText}>{feeRequestsTruncatedNote(TRANSFER_FEE_REQUESTS_LIMIT)}</p>}
        </>
      )}
    </div>
  );
}
