"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { TRADE_REQUESTS_ROUTES } from "@/lib/trade-requests/routes";
import type { TradeRequest, TradeRequestAccount, TradeRequestExporter } from "@/lib/trade-requests/request-types";
import { RequestDetailDialog, type RequestDetailDialogProps } from "./RequestDetailDialog";

export type RequestDetailRouteProps = {
  request: TradeRequest;
  accounts: TradeRequestAccount[];
  exporter: TradeRequestExporter;
} & Pick<RequestDetailDialogProps, "checklist" | "actions">;

/**
 * A request opened from its direct link; closing returns to the Trading Queue
 * and refresh() reloads the page's server data. Takes the same `checklist` and
 * `actions` slots as RequestDetailDialog.
 */
export function RequestDetailRoute({ request, accounts, exporter, checklist, actions }: RequestDetailRouteProps) {
  const router = useRouter();
  const close = useCallback(() => router.push(TRADE_REQUESTS_ROUTES.tradingQueue, { scroll: false }), [router]);
  const refresh = useCallback(() => router.refresh(), [router]);
  return (
    <RequestDetailDialog request={request} accounts={accounts} exporter={exporter} onClose={close} onRefresh={refresh}
      checklist={checklist} actions={actions} />
  );
}
