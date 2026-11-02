/** URL-only CRM navigation metadata; this module never imports server data. */
export type CrmNavigationFilters = {
  query: string;
  type: string;
  state: string;
  exceptionsOnly: boolean;
  duplicateView: string;
};

const TYPES = ["HOUSEHOLD", "CONTACT", "DEAL", "TRANSFER", "TASK", "EMAIL", "ACTIVITY", "APPOINTMENT"];
const DUPLICATE_TYPES = ["HOUSEHOLD", "CONTACT", "ACCOUNT"];
const VIEWS = ["potential", "snoozed", "confirmed", "not_duplicate", "all"];
const STATES = ["ACTIVE", "MERGED", "ARCHIVED"];

export function crmNavigationParams(filters: CrmNavigationFilters): URLSearchParams {
  const params = new URLSearchParams();
  // Duplicate review has its own filters. Identity-only controls must not imply
  // candidate filtering that the candidate query does not implement.
  if (!filters.duplicateView && filters.query) params.set("q", filters.query);
  if (filters.type) params.set("type", filters.type);
  if (!filters.duplicateView && filters.state) params.set("state", filters.state);
  if (!filters.duplicateView && filters.exceptionsOnly) params.set("exceptions", "open");
  if (filters.duplicateView) params.set("duplicates", filters.duplicateView);
  return params;
}

export function normalizeCrmNavigationFilters(params: URLSearchParams): CrmNavigationFilters {
  const duplicateView = VIEWS.includes(params.get("duplicates") ?? "") ? params.get("duplicates")! : "";
  const types = duplicateView ? DUPLICATE_TYPES : TYPES;
  return {
    query: duplicateView ? "" : (params.get("q") ?? "").trim().slice(0, 200),
    type: types.includes(params.get("type") ?? "") ? params.get("type")! : "",
    state: !duplicateView && STATES.includes(params.get("state") ?? "") ? params.get("state")! : "",
    exceptionsOnly: !duplicateView && params.get("exceptions") === "open",
    duplicateView,
  };
}

export function crmNavigationPage(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : 1;
}

export function parseCrmNavigationRequest(params: URLSearchParams, duplicates: boolean) {
  const allowed = new Set(duplicates
    ? ["duplicates", "type", "page", "pageSize", "snapshot"]
    : ["q", "type", "state", "exceptions", "page", "pageSize", "snapshot"]);
  const invalid = (): never => { throw new Error("invalid_crm_navigation_query"); };
  for (const [key, value] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1
      || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  }
  if (params.has("page") && !/^[1-9]\d{0,6}$/.test(params.get("page")!)) invalid();
  if (Number(params.get("page")) > 1_000_000) invalid();
  const page = crmNavigationPage(params.get("page"));
  const sizeValue = params.get("pageSize") ?? "100";
  if (!/^\d{3}$/.test(sizeValue)) invalid();
  const pageSize = Number(sizeValue);
  if (pageSize < 100 || pageSize > (duplicates ? 100 : 200)) invalid();
  const snapshot = params.get("snapshot");
  if ((snapshot !== null && !/^[a-f0-9]{32}$/.test(snapshot)) || (page > 1 && snapshot === null)) invalid();
  if (duplicates && !VIEWS.includes(params.get("duplicates") ?? "potential")) invalid();
  if (params.has("type") && !(duplicates ? DUPLICATE_TYPES : TYPES).includes(params.get("type")!)) invalid();
  if (params.has("state") && !STATES.includes(params.get("state")!)) invalid();
  if (params.has("exceptions") && params.get("exceptions") !== "open") invalid();
  const normalized = new URLSearchParams(params);
  if (duplicates && !normalized.has("duplicates")) normalized.set("duplicates", "potential");
  return { filters: normalizeCrmNavigationFilters(normalized), page, pageSize, snapshot };
}
