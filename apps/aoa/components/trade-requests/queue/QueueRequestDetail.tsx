"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { RequestChecklistScope } from "@/components/trade-requests/checklist/RequestChecklistScope";
import { RequestLoadFailed, RequestNotFound } from "@/components/trade-requests/detail/DirectLinkStates";
import { RequestDetailDialog, type RequestDetailDialogProps } from "@/components/trade-requests/detail/RequestDetailDialog";
import { RequestDetailRoute } from "@/components/trade-requests/detail/RequestDetailRoute";
import { isTradeRequest } from "@/lib/trade-requests/detail-view";
import type { TradeRequest, TradeRequestAccount, TradeRequestExporter } from "@/lib/trade-requests/request-types";
import { TRADE_REQUESTS_ROUTES, queueRequestRoute, requestIdFromPath, tradeRequestDetailRoute } from "@/lib/trade-requests/routes";
import { useTradeRequestQueueEntry, useTradeRequestsQueue } from "./QueueProvider";

/** What a direct link to a request loaded on the server, shown over the queue. */
export type QueueDirectDetail =
  | { id: string; kind: "found"; request: TradeRequest; accounts: TradeRequestAccount[] }
  | { id: string; kind: "not_found" }
  | { id: string; kind: "failed"; message: string };

/**
 * The request dialog's footer `actions` slot, used on both paths. It renders
 * inside the request's RequestChecklistScope, so it may call
 * useRequestChecklistSummary() as well as useRequestDetailFrame().
 */
export type QueueDetailSlots = Pick<RequestDetailDialogProps, "actions">;

const sameId = (raw: string, id: string) => {
  try {
    return decodeURIComponent(raw) === id;
  } catch {
    return raw === id;
  }
};

/**
 * The open request lives in the address. A row opens queueRequestRoute(id)
 * with a history entry the App Router follows without a server round trip; the
 * queue renders from the queue's layout, so it (its list, search, sort and
 * refresh timer) and the dialog stay mounted even when the router later
 * re-renders that address from the server (it does after a navigation
 * interrupts a server action such as a checklist save), and that render loads
 * nothing. Back closes the request; closing one opened that way goes back, and
 * closing any other goes to the queue address.
 */
export function useQueueRequestHistory() {
  const router = useRouter();
  const openId = requestIdFromPath(usePathname());
  const openedHere = useRef(false);
  const open = useCallback((id: string) => {
    const target = queueRequestRoute(id);
    if (window.location.pathname === target) return;
    openedHere.current = true;
    window.history.pushState(null, "", target);
  }, []);
  const close = useCallback(() => {
    if (openedHere.current) {
      openedHere.current = false;
      window.history.back();
    } else {
      router.push(TRADE_REQUESTS_ROUTES.tradingQueue, { scroll: false });
    }
  }, [router]);
  return { openId, open, close };
}

type Props = {
  openId: string | null;
  close: () => void;
  /** The viewer's AOA role, for the checklist's edit, read-only and lock rules. */
  role: string;
  exporter: TradeRequestExporter;
  direct?: QueueDirectDetail;
  slots?: QueueDetailSlots;
};

/**
 * The request over the queue: the loaded list entry when the queue has it (no
 * separate load), else what the direct link loaded. Once open, a request stays
 * pinned when a refresh drops it from the list, so the dialog (its tab, footer
 * error and slot state) is never remounted by the timer; a newer entry for it
 * still replaces what is shown. A request in neither (an address reached by
 * Forward after the list moved on) is loaded as a direct link.
 */
export function QueueRequestDetail({ openId, close, role, exporter, direct, slots }: Props) {
  const router = useRouter();
  const queue = useTradeRequestsQueue();
  const entry = useTradeRequestQueueEntry(openId);
  const listed = entry && isTradeRequest(entry) ? entry : null;
  const [pinned, setPinned] = useState<TradeRequest | null>(null);
  if (listed && listed !== pinned) setPinned(listed);
  const shown = listed ?? (pinned && pinned.id === openId ? pinned : null);
  const fromLink = direct && openId !== null && sameId(direct.id, openId) ? direct : null;
  const missing = openId !== null && !shown && !fromLink && !queue.loading;

  useEffect(() => {
    if (missing) router.replace(tradeRequestDetailRoute(openId), { scroll: false });
  }, [missing, openId, router]);

  if (openId === null) return null;
  if (fromLink?.kind === "found") {
    return (
      <RequestChecklistScope key={fromLink.request.id} request={fromLink.request} role={role}>
        {(checklist) => (
          <RequestDetailRoute request={fromLink.request} accounts={fromLink.accounts} exporter={exporter} checklist={checklist} actions={slots?.actions} />
        )}
      </RequestChecklistScope>
    );
  }
  if (shown) {
    return (
      <RequestChecklistScope key={shown.id} request={shown} role={role}>
        {(checklist) => (
          <RequestDetailDialog request={shown} exporter={exporter} onClose={close} onRefresh={queue.retry} checklist={checklist} actions={slots?.actions} />
        )}
      </RequestChecklistScope>
    );
  }
  if (fromLink?.kind === "not_found") return <RequestNotFound />;
  if (fromLink?.kind === "failed") return <RequestLoadFailed message={fromLink.message} />;
  return null;
}
