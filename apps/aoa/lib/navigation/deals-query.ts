import { DEAL_STAGES } from "@/lib/data/deal-types";
import type { StageFilter } from "@/components/deals/deal-filter";
import { SORTABLE_COLUMNS, type SortKey } from "@/components/deals/deal-sort";
import { parseProgressivePageParams } from "./progressive-page";
import { safeListHref } from "./list-routes";

export type DealDirectoryFilters = {
  query: string;
  stage: StageFilter;
  sortKey: SortKey | null;
  sortDir: "asc" | "desc";
  archived: boolean;
};

export function dealsSearchParams(filters: DealDirectoryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.stage !== "all" && !filters.archived) params.set("stage", filters.stage);
  if (filters.sortKey) {
    params.set("sort", filters.sortKey);
    if (filters.sortDir !== "asc") params.set("dir", filters.sortDir);
  }
  if (filters.archived) params.set("archived", "1");
  return params;
}

export function dealsHref(filters: DealDirectoryFilters, page = 1): string {
  const params = dealsSearchParams(filters);
  if (page > 1) params.set("page", String(page));
  return safeListHref(`/deals?${params}`) ?? "/deals";
}

/** Modal keys never enter list metadata or paging requests. */
export function parseDealsQuery(params: URLSearchParams, api = false) {
  const allowed = new Set(["q", "stage", "sort", "dir", "archived", "page",
    ...(api ? ["pageSize", "snapshot", "format"] : ["deal", "new"])]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("invalid_deals_query");
  const query = (params.get("q") ?? "").trim();
  const stage = params.get("stage") ?? "all";
  const sortKey = params.get("sort");
  const sortDir = params.get("dir") ?? "asc";
  const archived = params.get("archived") === "1";
  if (!["all", "no_statements", ...DEAL_STAGES].includes(stage) ||
    (sortKey !== null && !(SORTABLE_COLUMNS as readonly string[]).includes(sortKey)) ||
    !["asc", "desc"].includes(sortDir) || (!sortKey && params.has("dir")) ||
    (params.has("archived") && !archived) || (archived && stage !== "all") ||
    (params.has("deal") && !/^[A-Za-z0-9_-]{1,128}$/.test(params.get("deal")!)) ||
    (params.has("new") && params.get("new") !== "1") ||
    (params.has("deal") && params.has("new"))) throw new Error("invalid_deals_query");
  const filters: DealDirectoryFilters = { query, stage: stage as StageFilter,
    sortKey: sortKey as SortKey | null, sortDir: sortDir as "asc" | "desc", archived };
  const filterParams = dealsSearchParams(filters);
  if (!safeListHref(`/deals?${filterParams}`)) throw new Error("invalid_deals_query");
  const paging = parseProgressivePageParams(params);
  const exportCsv = params.get("format") === "csv";
  if (paging.pageSize < 100 || (api && paging.page > 1 && !paging.snapshot) ||
    (params.has("format") && !exportCsv) ||
    (exportCsv && (archived || params.has("page") || params.has("pageSize") || params.has("snapshot")))) throw new Error("invalid_deals_page");
  return { filters, ...paging, exportCsv, href: dealsHref(filters, paging.page),
    modalDealId: params.get("deal"), wantsNew: params.get("new") === "1" };
}
