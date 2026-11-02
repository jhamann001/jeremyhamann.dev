"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, TabPane, Tabs } from "@/components/ui";
import { REQUEST_DETAIL_COPY, resolveSelectedAccounts, type RequestDetailTab } from "@/lib/trade-requests/detail-view";
import type { TradeRequest, TradeRequestAccount, TradeRequestExporter } from "@/lib/trade-requests/request-types";
import { AuditTrail } from "./AuditTrail";
import { RequestDetails } from "./RequestDetails";
import { downloadRequestPdf } from "./download-pdf";
import { DemoRecordLink } from "@/components/demo/DemoRecordLink";
import { otherDemoLinks, tradeRequestOnlyHere } from "@/lib/demo/links";
import styles from "./RequestDetail.module.css";

export type RequestDetailFrame = {
  request: TradeRequest;
  /** Shows (or clears, with null) the footer's error line. */
  setError: (message: string | null) => void;
  selectTab: (tab: RequestDetailTab) => void;
  /** Leaves the request, as the Close controls do (e.g. after a successful status change). */
  close: () => void;
  /** Reloads the request from its source (the caller's onRefresh; nothing when none was given). */
  refresh: () => void;
};

const FrameContext = createContext<RequestDetailFrame | null>(null);

/**
 * For content placed in the checklist tab or the actions region, through either
 * RequestDetailDialog or RequestDetailRoute.
 */
export function useRequestDetailFrame(): RequestDetailFrame {
  const frame = useContext(FrameContext);
  if (!frame) throw new Error("useRequestDetailFrame must be used inside RequestDetailDialog");
  return frame;
}

export type RequestDetailDialogProps = {
  request: TradeRequest;
  /** Selected accounts placed from the client list (resolveSelectedAccounts); otherwise the request's stored account details. */
  accounts?: TradeRequestAccount[];
  /** The signed-in person, printed on the PDF as the exporter. */
  exporter: TradeRequestExporter;
  onClose: () => void;
  /** Reloads the request; exposed to slot content as the frame's refresh(). */
  onRefresh?: () => void;
  /** Pre-approval Checklist tab: its label (with the unchecked count) and content. */
  checklist?: { label: string; content: ReactNode };
  /** Footer controls on the right: status actions, Edit & Resubmit, Clone. */
  actions?: ReactNode;
};

/**
 * The request shown as a modal over the Trading Queue. Opened from the queue it
 * shows the loaded entry with no separate load; a direct link passes the
 * request it loaded. Renders after mount so dates use the browser's locale.
 *
 * Slot contract: `checklist` fills the third tab and `actions` the footer's
 * right side; both render inside the frame, so they may call
 * useRequestDetailFrame() for the request, the footer error line, tab
 * selection, close() and refresh(). The frame owns the tabs, banner, PDF and
 * Close; slot content never renders its own copies of them.
 */
export function RequestDetailDialog({ request, accounts: placed, exporter, onClose, onRefresh, checklist, actions }: RequestDetailDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<RequestDetailTab>("details");
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const accounts = useMemo(() => placed ?? resolveSelectedAccounts(request, null), [request, placed]);
  const frame = useMemo<RequestDetailFrame>(
    () => ({ request, setError, selectTab: setTab, close: onClose, refresh: () => onRefresh?.() }),
    [request, onClose, onRefresh],
  );

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const dialog = ref.current;
    if (mounted && dialog && !dialog.open) dialog.showModal();
  }, [mounted]);

  async function handleDownloadPdf() {
    if (downloading) return;
    setError(null);
    setDownloading(true);
    try {
      const failure = await downloadRequestPdf(request, accounts, exporter);
      if (failure) setError(failure);
    } finally {
      setDownloading(false);
    }
  }

  if (!mounted) return null;

  return (
    <FrameContext.Provider value={frame}>
      <dialog
        ref={ref}
        className={styles.dialog}
        aria-labelledby={titleId}
        data-testid="trade-request-detail"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        onClick={(event) => {
          if (event.target === ref.current) onClose();
        }}
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {request.clientName} <span className={styles.titleId}>({request.id})</span>
            </h2>
            <div className={styles.headerActions}>
              {tradeRequestOnlyHere(request.id) ? null : <DemoRecordLink href={otherDemoLinks.tradeRequest(request.id)} demo="Trade Request" />}
              <Button variant="ghost" size="sm" title={REQUEST_DETAIL_COPY.downloadPdfTitle} onClick={handleDownloadPdf} aria-busy={downloading || undefined}>
                {REQUEST_DETAIL_COPY.downloadPdf}
              </Button>
              <button type="button" className={styles.close} onClick={onClose} aria-label={REQUEST_DETAIL_COPY.close}>×</button>
            </div>
          </header>

          <div className={styles.body}>
            {request.status === "Rejected" && (
              <div className={styles.banner} role="alert">
                <p className={styles.bannerTitle}>{REQUEST_DETAIL_COPY.rejectedTitle}</p>
                <p className={styles.bannerBody}>{REQUEST_DETAIL_COPY.rejectedBody}</p>
              </div>
            )}
            <Tabs
              tabs={[
                { id: "details", label: REQUEST_DETAIL_COPY.tabDetails },
                { id: "audit", label: REQUEST_DETAIL_COPY.tabAudit },
                { id: "checklist", label: checklist?.label ?? REQUEST_DETAIL_COPY.tabChecklist },
              ]}
              activeId={tab}
              onActiveChange={(id) => setTab(id as RequestDetailTab)}
            >
              <TabPane tabId="details"><RequestDetails request={request} accounts={accounts} /></TabPane>
              <TabPane tabId="audit"><AuditTrail entries={request.auditLog} /></TabPane>
              <TabPane tabId="checklist">{checklist?.content ?? null}</TabPane>
            </Tabs>
          </div>

          <footer className={styles.footer}>
            {error && <div className={styles.error} role="alert">{error}</div>}
            <div className={styles.footerRow}>
              <Button variant="ghost" onClick={onClose}>{REQUEST_DETAIL_COPY.close}</Button>
              <div className={styles.actions} data-slot="request-actions">{actions}</div>
            </div>
          </footer>
        </div>
      </dialog>
    </FrameContext.Provider>
  );
}
