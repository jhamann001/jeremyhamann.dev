import type { ReconciliationHistoryPage } from "@/lib/data/reconciliation-history";
import type { ReconciliationHistoryRow } from "@/lib/data/trade-reconciliation";
import { RECONCILIATION_HISTORY_PAGE_SIZE, type ReconciliationHistoryView } from "@/lib/operations/reconciliation-history-query";
import { isTradeReconciliationRunId } from "@/lib/operations/trade-reconciliation-selection";

export class ReconciliationHistoryError extends Error {
  constructor(public readonly kind: "changed" | "unauthorized" | "unavailable") { super(kind); }
}

export function historyRowId(row: ReconciliationHistoryRow, view: ReconciliationHistoryView): string {
  return view === "daily" ? row.runId! : row.period.replaceAll(" ", "-");
}

export function appendReconciliationHistory(current: ReconciliationHistoryRow[], next: ReconciliationHistoryRow[], view: ReconciliationHistoryView): ReconciliationHistoryRow[] {
  const ids = new Set<string>();
  for (const row of [...current, ...next]) {
    const period = view === "daily" ? /^\d{4}-\d{2}-\d{2}$/ : view === "monthly" ? /^\d{4}-\d{2}$/ : /^\d{4} Q[1-4]$/;
    if (!row || !period.test(row.period) ||
      (view === "daily" && (!row.runId || !isTradeReconciliationRunId(row.runId))) ||
      ![row.matched, row.explained, row.unresolved].every((v) => Number.isSafeInteger(v) && v >= 0) ||
      typeof row.rate !== "string" || !(["N/A", "Unavailable"].includes(row.rate) ||
        (/^\d+\.\d{2}%$/.test(row.rate) && Number.parseFloat(row.rate) <= 100))) throw new ReconciliationHistoryError("changed");
    const id = historyRowId(row, view);
    if (ids.has(id)) throw new ReconciliationHistoryError("changed");
    ids.add(id);
  }
  return [...current, ...next];
}

export async function fetchReconciliationHistory(view: ReconciliationHistoryView, page: number, snapshot: string | null, signal: AbortSignal, scope: string, fetcher: typeof fetch = fetch): Promise<ReconciliationHistoryPage> {
  const params = new URLSearchParams({ view, page: String(page) });
  if (snapshot) params.set("snapshot", snapshot);
  const response = await fetcher(`/api/operations/trade-reconciliation/history?${params}`, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
  signal.throwIfAborted();
  if ([401, 403].includes(response.status)) throw new ReconciliationHistoryError("unauthorized");
  const actualScope = response.headers.get("X-AOA-Navigation-Scope");
  if ((response.ok || actualScope !== null) && (actualScope !== scope || (actualScope !== "" && !/^[a-f0-9]{64}$/.test(actualScope ?? "")))) throw new ReconciliationHistoryError("unauthorized");
  if ([409, 416].includes(response.status)) throw new ReconciliationHistoryError("changed");
  if (!response.ok) throw new ReconciliationHistoryError("unavailable");
  let result;
  try { result = await response.json(); } catch { throw new ReconciliationHistoryError("unavailable"); }
  signal.throwIfAborted();
  if (!result || result.page !== page || result.view !== view || result.pageSize !== RECONCILIATION_HISTORY_PAGE_SIZE ||
    !Number.isSafeInteger(result.total) || result.total < 0 || result.pageCount !== Math.max(1, Math.ceil(result.total / RECONCILIATION_HISTORY_PAGE_SIZE)) || page > result.pageCount ||
    !Array.isArray(result.rows) || result.rows.length !== Math.max(0, Math.min(RECONCILIATION_HISTORY_PAGE_SIZE, result.total - (page - 1) * RECONCILIATION_HISTORY_PAGE_SIZE)) ||
    typeof result.snapshot !== "string" || !/^[a-f0-9]{32}$/.test(result.snapshot) || (snapshot !== null && snapshot !== result.snapshot)) throw new ReconciliationHistoryError("changed");
  appendReconciliationHistory([], result.rows, view);
  return result as ReconciliationHistoryPage;
}
