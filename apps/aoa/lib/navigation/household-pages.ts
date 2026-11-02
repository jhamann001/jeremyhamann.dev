import type { HouseholdDirectoryPage } from "@/lib/data/households";
import type { HouseholdListRow } from "@/lib/data/types";
import type { HouseholdDirectoryFilters } from "@/components/households/directory-results";
import { householdDirectoryPageUrl, householdDirectoryQueryKey, parseHouseholdDirectoryQuery } from "./household-query";

export class HouseholdPageError extends Error {
  constructor(public readonly kind: "changed" | "unauthorized" | "unavailable") {
    super(kind);
  }
}

function validRow(value: unknown): value is HouseholdListRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const nullableString = (field: unknown) => field === null || typeof field === "string";
  return typeof row.sf_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.sf_id) &&
    typeof row.name === "string" && typeof row.lead_advisor_email === "string" &&
    typeof row.household_kind === "string" && nullableString(row.status) && nullableString(row.stage) &&
    nullableString(row.advisor_name) &&
    (row.aum === null || (typeof row.aum === "number" && Number.isFinite(row.aum))) &&
    Number.isSafeInteger(row.member_count) && Number(row.member_count) >= 0 &&
    (row.aum_source === null || ["apex", "custodians", "deals", "mirror"].includes(String(row.aum_source))) &&
    (row.employeeStatus === null || row.employeeStatus === "ACTIVE" || row.employeeStatus === "FORMER");
}

function validMetadata(value: Record<string, unknown>): boolean {
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const count = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0;
  const finite = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  const counts = value.counts;
  const summary = value.summaryCounts;
  if (!record(counts) || !["all", "client", "lost_client"].every((key) => count(counts[key])) ||
    !record(summary) || !["clients", "prospects", "lost"].every((key) => count(summary[key])) ||
    !Array.isArray(value.advisorOptions) || !value.advisorOptions.every((option) => record(option) && typeof option.value === "string" && typeof option.label === "string") ||
    !Array.isArray(value.statusOptions) || !value.statusOptions.every((status) => typeof status === "string") ||
    !record(value.aumSplit)) return false;
  const split = value.aumSplit;
  if (split.employeeScopeComplete !== undefined && typeof split.employeeScopeComplete !== "boolean") return false;
  const date = (item: unknown) => item === null || (typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item));
  if (split.sources !== undefined && (!Array.isArray(split.sources) || split.sources.length > 2 ||
    !split.sources.every((source) => record(source) && ["Apex", "Schwab"].includes(String(source.custodian)) &&
      date(source.oldest) && date(source.newest) && count(source.pending)) ||
    new Set(split.sources.map((source) => source.custodian)).size !== split.sources.length)) return false;
  return value.aumSplit.available === true
    ? finite(value.aumSplit.total) && finite(value.aumSplit.firm) && finite(value.aumSplit.employee)
    : value.aumSplit.available === false && value.aumSplit.total === null && value.aumSplit.firm === null
      && value.aumSplit.employee === null;
}

/** Never silently deduplicate overlapping pages: that could conceal missing rows. */
export function appendHouseholdRows(current: HouseholdListRow[], next: HouseholdListRow[]): HouseholdListRow[] {
  if (!Array.isArray(current) || !Array.isArray(next)) throw new HouseholdPageError("changed");
  const ids = new Set<string>();
  for (const row of [...current, ...next]) {
    if (!validRow(row) || ids.has(row.sf_id)) throw new HouseholdPageError("changed");
    ids.add(row.sf_id);
  }
  return [...current, ...next];
}

export async function fetchHouseholdPage(
  filters: HouseholdDirectoryFilters,
  page: number,
  snapshot: string | null,
  pageSize: number,
  signal: AbortSignal,
  expectedScope: string,
  fetcher: typeof fetch = fetch,
): Promise<HouseholdDirectoryPage> {
  const url = householdDirectoryPageUrl(filters, page, snapshot, pageSize);
  try { parseHouseholdDirectoryQuery(new URL(url, "https://paging.invalid").searchParams); }
  catch { throw new HouseholdPageError("changed"); }
  signal.throwIfAborted();
  const response = await fetcher(url, {
    signal, cache: "no-store", credentials: "same-origin", redirect: "error",
  });
  if (response.status === 401 || response.status === 403) throw new HouseholdPageError("unauthorized");
  const responseScope = response.headers.get("X-AOA-Navigation-Scope");
  // A content snapshot is not a login identity. Reject the former login before
  // reading any rows, even when a new login/role sees the identical directory.
  // Empty scope is the deliberate no-memory fallback for pre-upgrade dev JWTs.
  // Missing scope on a successful response fails closed; unmarked proxy errors
  // still use their existing generic error classification below.
  if ((response.ok || responseScope !== null) &&
    (responseScope !== expectedScope ||
      (responseScope !== "" && !/^[a-f0-9]{64}$/.test(responseScope ?? "")))) {
    throw new HouseholdPageError("unauthorized");
  }
  if (response.status === 409 || response.status === 416) throw new HouseholdPageError("changed");
  if (!response.ok) throw new HouseholdPageError("unavailable");
  let result;
  try { result = await response.json(); }
  catch { signal.throwIfAborted(); throw new HouseholdPageError("unavailable"); }
  signal.throwIfAborted();
  if (!result || !validMetadata(result) || !Array.isArray(result.rows) || result.rows.length > pageSize ||
    result.page !== page || result.pageSize !== pageSize ||
    !Number.isSafeInteger(result.total) || result.total < 0 ||
    !Number.isSafeInteger(result.pageCount) || result.pageCount !== Math.max(1, Math.ceil(result.total / pageSize)) ||
    page > result.pageCount ||
    result.rows.length !== Math.max(0, Math.min(pageSize, result.total - ((page - 1) * pageSize))) ||
    result.queryKey !== householdDirectoryQueryKey(filters, pageSize) ||
    typeof result.snapshot !== "string" || !/^[a-f0-9]{32}$/.test(result.snapshot) ||
    (snapshot !== null && result.snapshot !== snapshot)) {
    throw new HouseholdPageError("changed");
  }
  appendHouseholdRows([], result.rows);
  return result as HouseholdDirectoryPage;
}
