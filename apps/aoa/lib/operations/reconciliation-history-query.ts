import { isTradeReconciliationRunId } from "./trade-reconciliation-selection";

export const RECONCILIATION_HISTORY_PAGE_SIZE = 100;
export type ReconciliationHistoryView = "daily" | "monthly" | "quarterly";
export type ReconciliationNavigation = {
  tab: "current" | "history";
  history: ReconciliationHistoryView;
  run?: string;
};

export function reconciliationNavigation(params: URLSearchParams): ReconciliationNavigation {
  const run = params.get("run");
  return {
    tab: params.get("tab") === "history" ? "history" : "current",
    history: params.get("history") === "monthly" ? "monthly" : params.get("history") === "quarterly" ? "quarterly" : "daily",
    ...(run && isTradeReconciliationRunId(run) ? { run } : {}),
  };
}

export function reconciliationHref(state: ReconciliationNavigation): string {
  const params = new URLSearchParams();
  if (state.tab === "history") params.set("tab", "history");
  if (state.history !== "daily") params.set("history", state.history);
  if (state.run) params.set("run", state.run);
  return `/operations/trade-reconciliation${params.size ? `?${params}` : ""}`;
}

export function parseReconciliationHistoryQuery(params: URLSearchParams) {
  for (const key of params.keys()) {
    if (!["view", "page", "snapshot"].includes(key) || params.getAll(key).length !== 1) throw new Error("invalid_history_query");
  }
  const view = params.get("view") ?? "daily";
  if (!["daily", "monthly", "quarterly"].includes(view)) throw new Error("invalid_history_query");
  const rawPage = params.get("page") ?? "1";
  if (!/^[1-9]\d{0,6}$/.test(rawPage) || Number(rawPage) > 1_000_000) throw new Error("invalid_history_query");
  const page = Number(rawPage);
  const snapshot = params.get("snapshot");
  if ((snapshot !== null && !/^[a-f0-9]{32}$/.test(snapshot)) || (page > 1 && snapshot === null)) throw new Error("invalid_history_query");
  return { view: view as ReconciliationHistoryView, page, snapshot };
}
