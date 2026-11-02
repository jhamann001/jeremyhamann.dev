import { parseAuditNavigationQuery } from "./audit-query";
import { parseWindowPageParams } from "./window-page";

export function parseAuditWindowQuery(params: URLSearchParams) {
  const window = parseWindowPageParams(params);
  const filters = new URLSearchParams(params);
  for (const key of ["pageSize", "loaded", "snapshot", "restoreRows"]) filters.delete(key);
  const query = parseAuditNavigationQuery(filters);
  if (query.view !== "changes") throw new Error("invalid_audit_window_view");
  return { ...query, page: window.firstPage, pageSize: window.pageSize,
    loaded: window.loaded, snapshot: window.snapshot, ...(window.restoreRows !== undefined ? { restoreRows: window.restoreRows } : {}) };
}

export function parseAuditMetadataQuery(params: URLSearchParams) {
  if (params.has("from") || params.has("to")) throw new Error("invalid_audit_metadata_query");
  const query = parseAuditNavigationQuery(params);
  if (query.view !== "changes") throw new Error("invalid_audit_metadata_view");
  return query;
}
