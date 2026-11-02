import type { ClientDirectoryFilters } from "@/components/client-portrait/directory-results";
import { parseProgressivePageParams } from "./progressive-page";
import { safeListHref } from "./list-routes";

export function clientDirectorySearchParams(filters: ClientDirectoryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.stage !== "client") params.set("stage", filters.stage);
  if (filters.sortKey !== "name") params.set("sort", filters.sortKey);
  if (filters.sortDir !== "asc") params.set("dir", filters.sortDir);
  return params;
}

export function parseClientDirectoryQuery(params: URLSearchParams, api = false) {
  const allowed = new Set(["q", "stage", "sort", "dir", "page", ...(api ? ["pageSize", "snapshot"] : [])]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("invalid_client_query");
  const filterParams = new URLSearchParams(params);
  filterParams.delete("pageSize"); filterParams.delete("snapshot");
  if (!safeListHref(`/client-portrait?${filterParams}`)) throw new Error("invalid_client_query");
  const filters: ClientDirectoryFilters = {
    query: (params.get("q") ?? "").trim(),
    stage: (params.get("stage") ?? "client") as ClientDirectoryFilters["stage"],
    sortKey: (params.get("sort") ?? "name") as ClientDirectoryFilters["sortKey"],
    sortDir: (params.get("dir") ?? "asc") as ClientDirectoryFilters["sortDir"],
  };
  const paging = parseProgressivePageParams(params);
  if (paging.pageSize < 100 || (api && paging.page > 1 && !paging.snapshot)) throw new Error("invalid_client_page");
  return { filters, ...paging };
}
