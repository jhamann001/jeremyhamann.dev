import { parseProgressivePageParams } from "./progressive-page";
import { safeListHref } from "./list-routes";
import { auditDateRange } from "./audit-date-range";

export function parseAuditNavigationQuery(params: URLSearchParams, api = false) {
  // The legacy numbered API has no date-aware contract; only the current page
  // and bounded rows endpoint support dates. Never accept and ignore a filter.
  const allowed = new Set(["view", "action", "actor", "table", "op", "page", ...(api ? ["snapshot", "pageSize"] : ["from", "to"])]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("invalid_audit_query");
  const publicParams = new URLSearchParams(params);
  publicParams.delete("snapshot"); publicParams.delete("pageSize");
  if (!safeListHref(`/audit-log?${publicParams}`)) throw new Error("invalid_audit_query");
  const view = params.get("view") ?? "events";
  if (view !== "events" && view !== "changes") throw new Error("invalid_audit_view");
  if ((view === "events" && (params.has("table") || params.has("op"))) || (view === "changes" && params.has("action"))) throw new Error("mixed_audit_filters");
  if (params.has("op") && !["INSERT", "UPDATE", "DELETE"].includes(params.get("op")!)) throw new Error("invalid_audit_operation");
  const paging = parseProgressivePageParams(params);
  if (paging.pageSize < 100 || (api && paging.page > 1 && !paging.snapshot)) throw new Error("invalid_audit_page");
  publicParams.delete("page"); if (view === "events") publicParams.delete("view");
  const query = publicParams.toString();
  const dates = auditDateRange(params.get("from"), params.get("to"));
  return { ...paging, view: view as "events" | "changes", action: params.get("action") ?? "", actor: params.get("actor") ?? "",
    table: params.get("table") ?? "", op: params.get("op") ?? "", ...dates,
    href: `/audit-log${query ? `?${query}` : ""}` };
}
