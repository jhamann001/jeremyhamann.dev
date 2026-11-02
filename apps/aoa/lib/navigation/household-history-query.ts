import { parseProgressivePageParams } from "./progressive-page";
import { safeListHref } from "./list-routes";

export type HouseholdHistoryKind = "tasks" | "email" | "activity";
export const isHouseholdHistoryId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,192}$/.test(value);
export const isHouseholdTaskAssigneeFilter = (value: unknown): value is string =>
  typeof value === "string" && /^(?:unassigned|unavailable|[a-f0-9]{64})$/.test(value);

export function parseHouseholdHistoryQuery(params: URLSearchParams, kind: HouseholdHistoryKind) {
  const allowed = new Set(["household", "page", "pageSize", "snapshot", ...(kind === "tasks" ? ["tasksCompleted", "tasksAssignee"] : [])]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("invalid_household_history_query");
  const householdId = params.get("household");
  if (!isHouseholdHistoryId(householdId)) throw new Error("invalid_household_history_id");
  const completed = params.get("tasksCompleted");
  if (completed !== null && completed !== "1") throw new Error("invalid_household_tasks_filter");
  const assigneeFilter = params.get("tasksAssignee");
  if (assigneeFilter !== null && !isHouseholdTaskAssigneeFilter(assigneeFilter)) throw new Error("invalid_household_tasks_filter");
  const paging = parseProgressivePageParams(params);
  if (paging.pageSize < 100 || (paging.page > 1 && !paging.snapshot)) throw new Error("invalid_household_history_page");
  return { householdId, includeCompleted: completed === "1", assigneeFilter: assigneeFilter ?? undefined, ...paging };
}

/** Only URL/filter metadata, never records, is retained for the nested lists. */
export function householdHistoryLocation(pathname: string, search: string, kind: HouseholdHistoryKind) {
  const params = new URLSearchParams(search);
  const base = new URLSearchParams();
  for (const key of ["accountStatus", "accountType", "showEmptyAccounts", "tasksCompleted", "tasksAssignee", "list", "page"]) {
    const value = params.get(key);
    if (value !== null) base.set(key, value);
  }
  const historyHref = safeListHref(`${pathname}${base.size ? `?${base}` : ""}`) ?? pathname;
  if (base.get("list") !== kind) base.delete("page");
  base.set("list", kind);
  const href = safeListHref(`${pathname}?${base}`) ?? pathname;
  return { historyHref, href };
}
