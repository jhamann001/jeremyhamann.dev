import { parseProgressivePageParams } from "./progressive-page";
import { safeListHref } from "./list-routes";
export const TRANSFER_PAGE_SIZE = 150;
export const TRANSFER_SORT_KEYS = { DECISION: "decisionSort", IN_TRANSFER: "transferSort", FUNDED: "fundedSort" } as const;
export const WORKSPACE_VIEWS = ["household", "transfers", "queue", "activity", "mailing"] as const;
export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];
export const WORKSPACE_TASK_STATUSES = ["Ready", "Waiting", "Completed", "All"] as const;
export type WorkspaceTaskStatusFilter = (typeof WORKSPACE_TASK_STATUSES)[number];
export const WORKSPACE_LAYOUTS = ["deal", "flat"] as const;
export type WorkspaceLayout = (typeof WORKSPACE_LAYOUTS)[number];
export const WORKSPACE_TEAMS = ["Client Service", "Operations"] as const;
export type WorkspaceTeam = (typeof WORKSPACE_TEAMS)[number];
export const WORKSPACE_STAGE_FILTERS = ["DECISION", "IN_TRANSFER", "FUNDED"] as const;
export type WorkspaceStageFilter = (typeof WORKSPACE_STAGE_FILTERS)[number];
export const WORKSPACE_OUTCOME_FILTERS = ["active", "deferred", "stopped"] as const;
export type WorkspaceOutcomeFilter = (typeof WORKSPACE_OUTCOME_FILTERS)[number];
export const WORKSPACE_FOLLOW_UP_FILTERS = ["due", "missing"] as const;
export type WorkspaceFollowUpFilter = (typeof WORKSPACE_FOLLOW_UP_FILTERS)[number];
export const MAILING_STATUS_FILTERS = ["in-transit", "received", "not-mailed"] as const;
export type MailingStatusFilter = (typeof MAILING_STATUS_FILTERS)[number];
export const MAILING_CARRIER_FILTERS = ["FedEx", "USPS", "UPS", "DHL", "Other"] as const;
export type MailingCarrierFilter = (typeof MAILING_CARRIER_FILTERS)[number];
export type TransferBoardQuery = ReturnType<typeof parseTransferBoardQuery>;

function oneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return value !== null && (values as readonly string[]).includes(value);
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

export function parseTransferBoardQuery(params: URLSearchParams, api = false) {
  const allowed = new Set(["owner", "household", "q", "completed", "decisionSort", "transferSort", "fundedSort", "page",
    "view", "taskStatus", "layout", "team", "stage", "followUp", "outcome", "mailedFrom", "mailedThrough", "mailingStatus", "carrier", ...(api ? ["snapshot", "pageSize"] : [])]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("invalid_transfer_query");
  const publicParams = new URLSearchParams(params);
  publicParams.delete("snapshot"); publicParams.delete("pageSize");
  if (!safeListHref(`/asset-transfer?${publicParams}`)) throw new Error("invalid_transfer_query");
  const owner = params.get("owner") ?? "";
  if (owner && !["OPERATIONS", "CLIENT_SERVICE"].includes(owner)) throw new Error("invalid_transfer_owner");
  if (params.has("completed") && params.get("completed") !== "1") throw new Error("invalid_transfer_completed");
  for (const key of Object.values(TRANSFER_SORT_KEYS)) if (params.has(key) && !["asc", "desc"].includes(params.get(key)!)) throw new Error("invalid_transfer_sort");
  for (const [key, values] of [["view", WORKSPACE_VIEWS], ["taskStatus", WORKSPACE_TASK_STATUSES], ["layout", WORKSPACE_LAYOUTS],
    ["team", WORKSPACE_TEAMS], ["stage", WORKSPACE_STAGE_FILTERS], ["followUp", WORKSPACE_FOLLOW_UP_FILTERS], ["outcome", WORKSPACE_OUTCOME_FILTERS],
    ["mailingStatus", MAILING_STATUS_FILTERS], ["carrier", MAILING_CARRIER_FILTERS]] as const) {
    if (params.has(key) && !oneOf<string>(values, params.get(key))) throw new Error("invalid_transfer_query");
  }
  for (const key of ["mailedFrom", "mailedThrough"]) if (params.has(key) && !isIsoDay(params.get(key)!)) throw new Error("invalid_transfer_query");
  const paging = parseProgressivePageParams(params, TRANSFER_PAGE_SIZE);
  if (paging.pageSize !== TRANSFER_PAGE_SIZE || (api && paging.page > 1 && !paging.snapshot)) throw new Error("invalid_transfer_page");
  const household = params.get("household") ?? "";
  const query = (params.get("q") ?? "").trim();
  const view = params.get("view");
  const taskStatus = params.get("taskStatus");
  const layout = params.get("layout");
  const team = params.get("team");
  const stage = params.get("stage");
  const followUp = params.get("followUp");
  const outcome = params.get("outcome");
  const mailingStatus = params.get("mailingStatus");
  const carrier = params.get("carrier");
  return { ...paging, owner, household, query, completed: params.get("completed") === "1",
    sorts: { DECISION: params.get("decisionSort") ?? "", IN_TRANSFER: params.get("transferSort") ?? "", FUNDED: params.get("fundedSort") ?? "" },
    workspace: {
      view: oneOf(WORKSPACE_VIEWS, view) ? view : null,
      taskStatus: oneOf(WORKSPACE_TASK_STATUSES, taskStatus) ? taskStatus : null,
      layout: oneOf(WORKSPACE_LAYOUTS, layout) ? layout : null,
      team: oneOf(WORKSPACE_TEAMS, team) ? team : null,
      stage: oneOf(WORKSPACE_STAGE_FILTERS, stage) ? stage : null,
      followUp: oneOf(WORKSPACE_FOLLOW_UP_FILTERS, followUp) ? followUp : null,
    },
    outcome: oneOf(WORKSPACE_OUTCOME_FILTERS, outcome) ? outcome : null,
    mailed: {
      from: params.get("mailedFrom") ?? "",
      through: params.get("mailedThrough") ?? "",
      status: oneOf(MAILING_STATUS_FILTERS, mailingStatus) ? mailingStatus : null,
      carrier: oneOf(MAILING_CARRIER_FILTERS, carrier) ? carrier : null,
    },
    href: safeListHref(`/asset-transfer?${publicParams}`)! };
}
