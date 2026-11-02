import { auditDateRange, validAuditDate } from "./audit-date-range";

/** Explicit same-app navigation metadata vocabulary. Never an authorization gate. */
const ORIGIN = "https://navigation.invalid";
const MAX_HREF = 8_192;
const CONTROL = /[\u0000-\u001f\u007f]/;
const COMMON = { q: 256, page: 7, sort: 64, dir: 8 };
const ROUTES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "/households": { ...COMMON, stage: 32, advisor: 254, status: 100 },
  "/client-portrait": { ...COMMON, stage: 32 },
  "/crm": { q: 256, page: 7, type: 32, state: 32, exceptions: 16, duplicates: 32 },
  "/audit-log": { page: 7, view: 16, action: 128, actor: 254, table: 128, op: 16, from: 10, to: 10 },
  "/reporting": {
    page: 7, pageSize: 3, dataset: 64, sort: 64, direction: 8, columnsSubmitted: 1, columns: 2048,
    search: 256, advisor: 254, clientStage: 64, accountState: 32, aumAge: 32, minAum: 32, maxAum: 32,
    stage: 64, dealState: 32, owner: 254, closeWindow: 32, minValue: 32, maxValue: 32, taskState: 32,
    interactionAge: 32, minDays: 32, fundingType: 64, fundingState: 32, stalledState: 32,
    checklistState: 32, updatedWindow: 32,
  },
  "/deals": { ...COMMON, stage: 64, owner: 254, archived: 8, status: 64, type: 64 },
  "/asset-transfer": {
    page: 7, q: 256, owner: 32, household: 128, completed: 1, decisionSort: 4, transferSort: 4, fundedSort: 4,
    view: 16, taskStatus: 16, layout: 8, team: 32, stage: 16, followUp: 8, outcome: 16, mailedFrom: 10, mailedThrough: 10, mailingStatus: 16, carrier: 8,
  },
  "/tasks": { q: 256, household: 128, taskStatus: 16, layout: 8, team: 32, stage: 16, followUp: 8 },
  "/reporting/transfer-activity": { q: 256 },
  "/reporting/mailing": { q: 256, mailedFrom: 10, mailedThrough: 10, mailingStatus: 16, carrier: 8 },
};
const DETAIL = /^\/(?:households|client-portrait|crm(?:\/duplicates)?|deals|asset-transfer)\/[A-Za-z0-9_-]{1,128}$/;
const HOUSEHOLD_DETAIL = /^\/households\/[A-Za-z0-9_-]{1,128}$/;
const HOUSEHOLD_LISTS = { list: 8, tasksCompleted: 1, tasksAssignee: 64, accountStatus: 8, accountType: 100, showEmptyAccounts: 1, page: 7 };

export function safeListHref(value: unknown): string | null {
  const operations = safeOperationsListHref(value);
  if (operations) return operations;
  if (typeof value !== "string" || value.length > MAX_HREF || CONTROL.test(value) ||
    value.includes("#") || value.includes("\\") || !value.startsWith("/") || value.startsWith("//")) return null;
  const url = new URL(value, ORIGIN);
  const nested = HOUSEHOLD_DETAIL.test(url.pathname);
  const limits = ROUTES[url.pathname] ?? (nested ? HOUSEHOLD_LISTS : undefined);
  if (url.origin !== ORIGIN || !limits || url.hash || url.pathname !== value.split("?")[0]) return null;
  const seen = new Set<string>();
  for (const [key, parameter] of url.searchParams) {
    const limit = Object.hasOwn(limits, key) ? limits[key] : 0;
    if (!limit || seen.has(key) || parameter.length > limit || CONTROL.test(parameter)) return null;
    seen.add(key);
    if (key === "page" && (!/^[1-9]\d{0,6}$/.test(parameter) || Number(parameter) > 1_000_000)) return null;
    if (key === "pageSize" && (!/^[1-9]\d{0,2}$/.test(parameter) || Number(parameter) > 200)) return null;
    if ((key === "dir" || key === "direction") && !["asc", "desc"].includes(parameter)) return null;
    if (nested) {
      if (key === "list" && !["tasks", "email", "activity"].includes(parameter)) return null;
      if (key === "tasksCompleted" && parameter !== "1") return null;
      if (key === "tasksAssignee" && !/^(?:unassigned|unavailable|[a-f0-9]{64})$/.test(parameter)) return null;
      if (key === "showEmptyAccounts" && parameter !== "1") return null;
      if (key === "accountStatus" && !["open", "closed", "all"].includes(parameter)) return null;
    }
    if (url.pathname === "/households") {
      if (key === "stage" && !["all", "client", "lost_client"].includes(parameter)) return null;
      if (key === "sort" && !["name", "stage", "aum"].includes(parameter)) return null;
    }
    if (url.pathname === "/client-portrait") {
      if (key === "stage" && !["all", "client", "prospect", "lost_client", "lost_prospect"].includes(parameter)) return null;
      if (key === "sort" && !["name", "household"].includes(parameter)) return null;
    }
    if (url.pathname === "/audit-log" && (key === "from" || key === "to")) {
      if (url.searchParams.get("view") !== "changes" || !validAuditDate(parameter)) return null;
    }
  }
  if (url.pathname === "/audit-log") {
    try { auditDateRange(url.searchParams.get("from"), url.searchParams.get("to")); }
    catch { return null; }
  }
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const canonical = query ? `${url.pathname}?${query}` : url.pathname;
  return canonical.length <= MAX_HREF ? canonical : null;
}

export function safeDetailHref(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && !CONTROL.test(value) && DETAIL.test(value)
    ? value : safeOperationsDetailHref(value);
}

export function listPageHref(href: string, page: number): string {
  const safe = safeListHref(href);
  if (!safe || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Error("invalid_list_page");
  const url = new URL(safe, ORIGIN);
  if (page === 1) url.searchParams.delete("page"); else url.searchParams.set("page", String(page));
  return safeListHref(`${url.pathname}?${url.searchParams}`)!;
}

/** Compatibility export for the existing Operations consumers. */
export const safeListDetailHref = safeDetailHref;

const FEE_PATH = "/operations/fee-requests";
const RECON_PATH = "/operations/trade-reconciliation";
const FEE_QUERY_LIMITS: Readonly<Record<string, number>> = {
  tab: 16, type: 32, status: 16, from: 10, to: 10, q: 256, sort: 16, dir: 4, page: 7,
};
const RECON_QUERY_LIMITS: Readonly<Record<string, number>> = {
  tab: 8, history: 9, run: 128, view: 10, q: 256, breaks: 10, page: 7,
};

/** Extend the store only to named Operations routes, never arbitrary app URLs. */
function safeOperationsListHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_HREF ||
    CONTROL.test(value) || value.includes("#") || value.includes("\\")) return null;
  const path = value.split("?")[0];
  if (path !== FEE_PATH && path !== RECON_PATH) return null;
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN || url.pathname !== path || url.hash) return null;
  const limits = path === FEE_PATH ? FEE_QUERY_LIMITS : RECON_QUERY_LIMITS;
  const seen = new Set<string>();
  for (const [key, parameter] of url.searchParams) {
    const limit = Object.hasOwn(limits, key) ? limits[key] : 0;
    if (!limit || seen.has(key) || parameter.length > limit || CONTROL.test(parameter)) return null;
    seen.add(key);
    if (key === "page" && (!/^[1-9]\d{0,6}$/.test(parameter) || Number(parameter) > 1_000_000)) return null;
    if (path === FEE_PATH) {
      if (key === "tab" && !["credits", "exceptions"].includes(parameter)) return null;
      if (key === "type" && !["SERVICE_GUARANTEE", "BILLING_EXCEPTION", "LARGE_HOUSEHOLD_EXCEPTION"].includes(parameter)) return null;
      if (key === "status" && !["PENDING", "APPROVED", "REJECTED", "CANCELLED", "CREDITED"].includes(parameter)) return null;
      if (key === "sort" && !["submitted", "amount", "waiver"].includes(parameter)) return null;
      if (key === "dir" && !["asc", "desc"].includes(parameter)) return null;
      if ((key === "from" || key === "to") && (!/^\d{4}-\d{2}-\d{2}$/.test(parameter) ||
        !Number.isFinite(Date.parse(`${parameter}T00:00:00Z`)) ||
        new Date(`${parameter}T00:00:00Z`).toISOString().slice(0, 10) !== parameter)) return null;
    } else {
      if (key === "tab" && !["current", "history"].includes(parameter)) return null;
      if (key === "history" && !["daily", "monthly", "quarterly"].includes(parameter)) return null;
      if (key === "run" && !/^[A-Za-z0-9_-]{1,128}$/.test(parameter)) return null;
      if (key === "view" && !["summary", "breaks", "detail", "aggregated"].includes(parameter)) return null;
      if (key === "breaks" && !["unresolved", "explained", "all"].includes(parameter)) return null;
    }
  }
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const canonical = query ? `${path}?${query}` : path;
  return canonical.length <= MAX_HREF ? canonical : null;
}

/** A query-selected Operations record is a distinct detail identity. */
function safeOperationsDetailHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || CONTROL.test(value) || value.includes("\\")) return null;
  const fee = /^\/operations\/fee-requests\?request=([A-Za-z0-9_-]{16,64})$/.exec(value);
  if (fee) return value;
  const recon = /^\/operations\/trade-reconciliation\?run=([A-Za-z0-9_-]{1,128})$/.exec(value);
  return recon ? value : null;
}

/** Canonicalize only the current browser location; persisted detail IDs stay strict. */
export function currentListDetailHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_HREF || !value.startsWith("/") ||
    value.startsWith("//") || value.includes("\\") || CONTROL.test(value)) return null;
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN) return null;
  // Existing detail tabs and account filters never change a path-selected record identity.
  const detail = safeDetailHref(url.pathname);
  if (detail) return detail;
  if (value.startsWith(`${FEE_PATH}?`)) {
    if (url.pathname !== FEE_PATH) return null;
    const ids = url.searchParams.getAll("request");
    const messages = url.searchParams.getAll("message");
    if (ids.length !== 1 || !/^[A-Za-z0-9_-]{16,64}$/.test(ids[0]) || messages.length > 1 ||
      [...url.searchParams.keys()].some((key) => key !== "request" && key !== "message") ||
      (messages.length === 1 && !["submitted", "workflow-updated", "workflow-conflict", "workflow-invalid", "workflow-failed", "submission-failed"].includes(messages[0])) ||
      (url.hash && url.hash !== `#request-${ids[0]}`)) return null;
    // Success/error banners and the matching anchor are transient, not another
    // detail identity or part of persisted navigation metadata.
    return `${FEE_PATH}?request=${ids[0]}`;
  }
  if (url.pathname === RECON_PATH && safeOperationsListHref(value) && url.searchParams.has("run")) {
    return `${RECON_PATH}?run=${url.searchParams.get("run")}`;
  }
  return null;
}
