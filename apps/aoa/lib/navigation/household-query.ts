import type { HouseholdDirectoryFilters } from "@/components/households/directory-results";
import { normalizedFilterValue } from "@/components/households/filters-helpers";

export const HOUSEHOLD_DIRECTORY_PAGE_SIZE = 100;
export const HOUSEHOLD_DIRECTORY_MAX_PAGE_SIZE = 200;
export const HOUSEHOLD_DIRECTORY_MAX_PAGE = 1_000_000;

export const DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS: HouseholdDirectoryFilters = {
  query: "", stage: "client", advisor: "", status: "", sortKey: "name", sortDir: "asc",
};

const ALLOWED_PARAMETERS = new Set([
  "q", "stage", "advisor", "status", "sort", "dir", "page", "pageSize", "snapshot",
]);
const SNAPSHOT = /^[a-f0-9]{32}$/;

export type HouseholdDirectoryQuery = {
  filters: HouseholdDirectoryFilters;
  page: number;
  pageSize: number;
  snapshot: string | null;
  queryKey: string;
};

function invalidQuery(): never { throw new Error("invalid_household_query"); }

function textValue(params: URLSearchParams, key: string, maxLength: number): string {
  const value = params.get(key) ?? "";
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) invalidQuery();
  return value.trim();
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d{0,6}$/.test(value)) invalidQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) invalidQuery();
  return parsed;
}

/** Shared by the JSON API and legacy numbered SSR links, before SQL bigint casts. */
export function parseHouseholdDirectoryPageNumber(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== "string") invalidQuery();
  return positiveInteger(value, 1, HOUSEHOLD_DIRECTORY_MAX_PAGE);
}

/** One canonical URL/filter representation shared by server reads and browser paging. */
export function householdDirectorySearchParams(
  filters: HouseholdDirectoryFilters,
  pageSize = HOUSEHOLD_DIRECTORY_PAGE_SIZE,
): URLSearchParams {
  const params = new URLSearchParams();
  const query = filters.query.trim();
  const advisor = normalizedFilterValue(filters.advisor);
  const status = normalizedFilterValue(filters.status);
  if (query) params.set("q", query);
  if (filters.stage !== "client") params.set("stage", filters.stage);
  if (advisor) params.set("advisor", advisor);
  if (status) params.set("status", status);
  if (filters.sortKey !== "name") params.set("sort", filters.sortKey);
  if (filters.sortDir !== "asc") params.set("dir", filters.sortDir);
  if (pageSize !== HOUSEHOLD_DIRECTORY_PAGE_SIZE) params.set("pageSize", String(pageSize));
  return params;
}

export function householdDirectoryQueryKey(
  filters: HouseholdDirectoryFilters,
  pageSize = HOUSEHOLD_DIRECTORY_PAGE_SIZE,
): string {
  return householdDirectorySearchParams(filters, pageSize).toString();
}

export function householdDirectoryPageUrl(
  filters: HouseholdDirectoryFilters,
  page: number,
  snapshot: string | null,
  pageSize = HOUSEHOLD_DIRECTORY_PAGE_SIZE,
): string {
  const params = householdDirectorySearchParams(filters, pageSize);
  params.set("page", String(page));
  if (snapshot) params.set("snapshot", snapshot);
  return `/api/households?${params.toString()}`;
}

/** Reject ambiguity and unbounded queries before any directory/database work. */
export function parseHouseholdDirectoryQuery(params: URLSearchParams): HouseholdDirectoryQuery {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMETERS.has(key) || params.getAll(key).length !== 1) invalidQuery();
  }
  const stage = params.get("stage") ?? "client";
  const sortKey = params.get("sort") ?? "name";
  const sortDir = params.get("dir") ?? "asc";
  if (stage !== "client" && stage !== "all" && stage !== "lost_client") invalidQuery();
  if (sortKey !== "name" && sortKey !== "stage" && sortKey !== "aum") invalidQuery();
  if (sortDir !== "asc" && sortDir !== "desc") invalidQuery();
  const filters: HouseholdDirectoryFilters = {
    query: textValue(params, "q", 256), stage,
    advisor: normalizedFilterValue(textValue(params, "advisor", 254)),
    status: normalizedFilterValue(textValue(params, "status", 100)),
    sortKey, sortDir,
  };
  const page = parseHouseholdDirectoryPageNumber(params.get("page"));
  const pageSize = positiveInteger(
    params.get("pageSize"), HOUSEHOLD_DIRECTORY_PAGE_SIZE, HOUSEHOLD_DIRECTORY_MAX_PAGE_SIZE,
  );
  // The UI starts with 100–200 rows. Smaller pages are not a public API option.
  if (pageSize < HOUSEHOLD_DIRECTORY_PAGE_SIZE) invalidQuery();
  const snapshot = params.get("snapshot");
  if (snapshot !== null && !SNAPSHOT.test(snapshot)) invalidQuery();
  if (page > 1 && snapshot === null) invalidQuery();
  return { filters, page, pageSize, snapshot, queryKey: householdDirectoryQueryKey(filters, pageSize) };
}
