export const FEE_REQUEST_PAGE_SIZE = 100;
export const FEE_REQUEST_MAX_PAGE_SIZE = 200;
export const FEE_REQUEST_STATUSES = ["PENDING", "APPROVED", "CREDITED", "REJECTED", "CANCELLED"] as const;
export const FEE_REQUEST_EXCEPTION_TYPES = ["SERVICE_GUARANTEE", "BILLING_EXCEPTION", "LARGE_HOUSEHOLD_EXCEPTION"] as const;
export type FeeRequestFilters = {
  tab: "credits" | "exceptions";
  type: "" | typeof FEE_REQUEST_EXCEPTION_TYPES[number];
  status: "" | typeof FEE_REQUEST_STATUSES[number];
  query: string;
  from: string;
  to: string;
  sort: "submitted" | "amount" | "waiver";
  dir: "asc" | "desc";
};
export const DEFAULT_FEE_REQUEST_FILTERS: FeeRequestFilters = {
  tab: "credits", type: "", status: "", query: "", from: "", to: "", sort: "submitted", dir: "desc",
};
export type FeeRequestQuery = {
  filters: FeeRequestFilters;
  page: number;
  pageSize: number;
  snapshot: string | null;
  queryKey: string;
};

function invalid(): never { throw new Error("invalid_fee_request_query"); }
function date(value: string): string {
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9999-12-31") invalid();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) invalid();
  return Number(value);
}
export function feeRequestSearchParams(filters: FeeRequestFilters, pageSize = FEE_REQUEST_PAGE_SIZE): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.tab !== "credits") params.set("tab", filters.tab);
  if (filters.type) params.set("type", filters.type);
  if (filters.status) params.set("status", filters.status);
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort !== "submitted") params.set("sort", filters.sort);
  if (filters.dir !== "desc") params.set("dir", filters.dir);
  if (pageSize !== FEE_REQUEST_PAGE_SIZE) params.set("pageSize", String(pageSize));
  return params;
}
export function feeRequestListHref(filters: FeeRequestFilters, page = 1): string {
  const params = feeRequestSearchParams(filters);
  if (page > 1) params.set("page", String(page));
  return `/operations/fee-requests${params.size ? `?${params}` : ""}`;
}
export function feeRequestPageUrl(filters: FeeRequestFilters, page: number, snapshot: string | null, pageSize: number): string {
  const params = feeRequestSearchParams(filters, pageSize);
  params.set("page", String(page));
  if (snapshot) params.set("snapshot", snapshot);
  return `/api/operations/fee-requests?${params}`;
}
export function parseFeeRequestQuery(params: URLSearchParams, requireSnapshot = true): FeeRequestQuery {
  const allowed = new Set(["tab", "type", "status", "q", "from", "to", "sort", "dir", "page", "pageSize", "snapshot"]);
  for (const [key, value] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  }
  const tab = params.get("tab") ?? "credits";
  const type = params.get("type") ?? "";
  const status = params.get("status") ?? "";
  const sort = params.get("sort") ?? "submitted";
  const dir = params.get("dir") ?? "desc";
  if (tab !== "credits" && tab !== "exceptions") invalid();
  if (type && !(FEE_REQUEST_EXCEPTION_TYPES as readonly string[]).includes(type)) invalid();
  if (tab === "credits" && type) invalid();
  if (status && !(FEE_REQUEST_STATUSES as readonly string[]).includes(status)) invalid();
  if (!["submitted", "amount", "waiver"].includes(sort) || (tab === "credits" && sort === "waiver") || (tab === "exceptions" && sort === "amount")) invalid();
  if (dir !== "asc" && dir !== "desc") invalid();
  const query = params.get("q") ?? "";
  if (query.length > 256) invalid();
  const from = date(params.get("from") ?? "");
  const to = date(params.get("to") ?? "");
  if (from && to && from > to) invalid();
  const filters: FeeRequestFilters = { tab, type: type as FeeRequestFilters["type"], status: status as FeeRequestFilters["status"], query: query.trim(), from, to, sort: sort as FeeRequestFilters["sort"], dir };
  const page = integer(params.get("page"), 1, 1_000_000);
  const pageSize = integer(params.get("pageSize"), FEE_REQUEST_PAGE_SIZE, FEE_REQUEST_MAX_PAGE_SIZE);
  if (pageSize < FEE_REQUEST_PAGE_SIZE) invalid();
  const snapshot = params.get("snapshot");
  if (snapshot !== null && !/^[a-f0-9]{32}$/.test(snapshot)) invalid();
  if (requireSnapshot && page > 1 && snapshot === null) invalid();
  return { filters, page, pageSize, snapshot, queryKey: feeRequestSearchParams(filters, pageSize).toString() };
}
