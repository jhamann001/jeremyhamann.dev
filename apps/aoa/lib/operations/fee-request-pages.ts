import type { OperationsFeeRequestDirectory, OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";
import { feeRequestPageUrl, feeRequestSearchParams, parseFeeRequestQuery, type FeeRequestFilters, FEE_REQUEST_STATUSES, FEE_REQUEST_EXCEPTION_TYPES } from "./fee-request-query";

export class FeeRequestPageError extends Error {
  constructor(public readonly kind: "changed" | "unauthorized" | "unavailable") { super(kind); }
}
function validRow(value: unknown): value is OperationsFeeRequestListRow {
  if (!value || typeof value !== "object") return false;
  const row = value as OperationsFeeRequestListRow;
  return typeof row.id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(row.id) &&
    [...FEE_REQUEST_EXCEPTION_TYPES, "FEE_CREDIT"].includes(row.kind) &&
    (FEE_REQUEST_STATUSES as readonly string[]).includes(row.status) &&
    typeof row.clientName === "string" && typeof row.submittedAt === "string" &&
    Array.isArray(row.accounts) && Array.isArray(row.events) && Array.isArray(row.feeTypes) && Array.isArray(row.relevantTicketRefs);
}
export function appendFeeRequestRows(current: OperationsFeeRequestListRow[], next: OperationsFeeRequestListRow[]): OperationsFeeRequestListRow[] {
  if (!Array.isArray(current) || !Array.isArray(next)) throw new FeeRequestPageError("changed");
  const ids = new Set<string>();
  for (const row of [...current, ...next]) {
    if (!validRow(row) || ids.has(row.id)) throw new FeeRequestPageError("changed");
    ids.add(row.id);
  }
  return [...current, ...next];
}
export async function fetchFeeRequestPage(filters: FeeRequestFilters, page: number, snapshot: string | null, pageSize: number,
  signal: AbortSignal, expectedScope: string, fetcher: typeof fetch = fetch): Promise<OperationsFeeRequestDirectory> {
  const url = feeRequestPageUrl(filters, page, snapshot, pageSize);
  try { parseFeeRequestQuery(new URL(url, "https://paging.invalid").searchParams); }
  catch { throw new FeeRequestPageError("changed"); }
  signal.throwIfAborted();
  const response = await fetcher(url, { signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
  if (response.status === 401 || response.status === 403) throw new FeeRequestPageError("unauthorized");
  const responseScope = response.headers.get("X-AOA-Navigation-Scope");
  if ((response.ok || responseScope !== null) && (responseScope !== expectedScope ||
      (responseScope !== "" && !/^[a-f0-9]{64}$/.test(responseScope ?? "")))) throw new FeeRequestPageError("unauthorized");
  if (response.status === 409 || response.status === 416) throw new FeeRequestPageError("changed");
  if (!response.ok) throw new FeeRequestPageError("unavailable");
  let result;
  try { result = await response.json(); } catch { signal.throwIfAborted(); throw new FeeRequestPageError("unavailable"); }
  signal.throwIfAborted();
  if (!result || !Array.isArray(result.rows) || result.rows.length > pageSize || result.page !== page || result.pageSize !== pageSize ||
    !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(result.pageCount) ||
    result.pageCount !== Math.max(1, Math.ceil(result.total / pageSize)) || page > result.pageCount ||
    result.rows.length !== Math.max(0, Math.min(pageSize, result.total - ((page - 1) * pageSize))) ||
    result.queryKey !== feeRequestSearchParams(filters, pageSize).toString() || !/^[a-f0-9]{32}$/.test(result.snapshot ?? "") ||
    (snapshot !== null && result.snapshot !== snapshot) || !result.counts ||
    ["pending", "approved", "credited", "closed", "total"].some((key) => !Number.isSafeInteger(result.counts[key]) || result.counts[key] < 0) ||
    result.counts.total !== result.total || result.counts.pending + result.counts.approved + result.counts.credited + result.counts.closed !== result.total) {
    throw new FeeRequestPageError("changed");
  }
  appendFeeRequestRows([], result.rows);
  return result as OperationsFeeRequestDirectory;
}
