import type {
  CrmReportDataset,
  CrmReportDatasetId,
  CrmReportDirection,
  CrmReportQuery,
  CrmReportPageMeta,
  CrmReportPageRow,
} from "@/lib/crm/reporting-contracts";
import { parseProgressivePageParams, type ProgressivePage } from "@/lib/navigation/progressive-page";

export type ReportingSearchParams = Record<string, string | string[] | undefined>;

export const CRM_REPORT_DATASETS: readonly CrmReportDatasetId[] = [
  "household_aum",
  "deal_pipeline",
  "client_engagement",
  "transfers_funding",
];

const DEFAULT_SORT: Record<CrmReportDatasetId, string> = {
  household_aum: "aum",
  deal_pipeline: "stage",
  client_engagement: "lastInteraction",
  transfers_funding: "stage",
};

const DEFAULT_DIRECTION: Record<CrmReportDatasetId, CrmReportDirection> = {
  household_aum: "desc",
  deal_pipeline: "asc",
  client_engagement: "asc",
  transfers_funding: "asc",
};

const ALLOWED_SORTS: Record<CrmReportDatasetId, ReadonlySet<string>> = {
  household_aum: new Set(["household", "advisor", "clientStage", "aum", "accounts", "members", "aumAsOf"]),
  deal_pipeline: new Set(["stage", "owner", "deals", "pipelineValue", "averageAgeDays", "overdue", "earliestOverdueClose", "nextExpectedClose"]),
  client_engagement: new Set(["household", "advisor", "openTasks", "lastCall", "lastEmail", "lastInteraction", "daysSinceInteraction"]),
  transfers_funding: new Set(["stage", "owner", "fundingType", "transfers", "transferValue", "averageDaysInStage", "stalled", "openChecklistItems"]),
};

const FILTER_KEYS: Record<CrmReportDatasetId, readonly string[]> = {
  household_aum: ["search", "advisor", "clientStage", "accountState", "aumAge", "minAum", "maxAum"],
  deal_pipeline: ["search", "stage", "dealState", "owner", "closeWindow", "minValue", "maxValue"],
  client_engagement: ["search", "advisor", "taskState", "interactionAge", "minDays"],
  transfers_funding: ["search", "stage", "owner", "fundingType", "fundingState", "stalledState", "checklistState", "updatedWindow", "minValue", "maxValue"],
};

const FILTER_OPTIONS: Partial<Record<string, ReadonlySet<string>>> = {
  accountState: new Set(["with", "without"]),
  aumAge: new Set(["current", "older30", "older60", "older90", "missing"]),
  "deal_pipeline:stage": new Set(["POTENTIAL", "COMMITTED", "FUNDING", "WON", "LOST"]),
  "transfers_funding:stage": new Set(["DECISION", "IN_TRANSFER", "FUNDED"]),
  closeWindow: new Set(["overdue", "upcoming", "missing", "next30", "next60", "next90"]),
  dealState: new Set(["open", "closed"]),
  taskState: new Set(["open", "clear"]),
  interactionAge: new Set(["never", "within30", "31to60", "61to89", "older90"]),
  fundingType: new Set(["ACAT_FULL", "ACAT_PARTIAL", "CHECK", "WIRE", "ACH", "MANUAL", "DRS"]),
  fundingState: new Set(["missing", "present"]),
  stalledState: new Set(["stalled", "moving"]),
  checklistState: new Set(["open", "clear"]),
  updatedWindow: new Set(["30", "60", "90"]),
};

const NUMBER_FILTERS = new Set(["minAum", "maxAum", "minValue", "maxValue", "minDays"]);

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? "";

function sanitizeFilter(dataset: CrmReportDatasetId, key: string, value: string): string {
  if (NUMBER_FILTERS.has(key)) {
    if (!value) return "";
    // Accept either plain digits (1500) or correctly grouped thousands (33,333),
    // with an optional decimal fraction. Reject exponent notation, malformed
    // grouping, signs, and trailing decimal points before touching SQL.
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return "";
    const parsed = Number(value.replaceAll(",", ""));
    return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "";
  }
  const allowed = FILTER_OPTIONS[`${dataset}:${key}`] ?? FILTER_OPTIONS[key];
  if (allowed) return allowed.has(value) ? value : "";
  return value.slice(0, 100);
}

export function parseCrmReportQuery(sp: ReportingSearchParams): CrmReportQuery {
  const requestedDataset = one(sp.dataset) as CrmReportDatasetId;
  const dataset = CRM_REPORT_DATASETS.includes(requestedDataset)
    ? requestedDataset
    : "household_aum";
  const previousDataset = one(sp.currentDataset) as CrmReportDatasetId;
  const switchedDataset = CRM_REPORT_DATASETS.includes(previousDataset)
    && previousDataset !== dataset;
  const rawPage = Number.parseInt(switchedDataset ? "" : one(sp.page), 10);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0
    ? Math.min(rawPage, 100_000)
    : 1;
  const rawPageSize = Number.parseInt(one(sp.pageSize), 10);
  const pageSize = ([25, 50, 100] as const).find((size) => size === rawPageSize) ?? 100;
  const requestedSort = switchedDataset ? "" : one(sp.sort);
  const sort = ALLOWED_SORTS[dataset].has(requestedSort)
    ? requestedSort
    : DEFAULT_SORT[dataset];
  const requestedDirection = switchedDataset ? "" : one(sp.direction);
  const direction: CrmReportDirection = requestedDirection === "asc" || requestedDirection === "desc"
    ? requestedDirection
    : DEFAULT_DIRECTION[dataset];
  const columnsExplicit = !switchedDataset && (
    one(sp.columnsSubmitted) === "1" || sp.columns !== undefined
  );
  const rawColumns = switchedDataset ? [] : Array.isArray(sp.columns)
    ? sp.columns
    : one(sp.columns).split(",");
  const columns = rawColumns
    .map((value) => value.trim())
    .filter((value) => ALLOWED_SORTS[dataset].has(value));
  const filters = Object.fromEntries(
    FILTER_KEYS[dataset]
      .map((key) => [key, switchedDataset ? "" : sanitizeFilter(dataset, key, one(sp[key]))] as const)
      .filter(([, value]) => value !== ""),
  );

  const rangePairs: Array<[string, string]> = dataset === "household_aum"
    ? [["minAum", "maxAum"]]
    : dataset === "deal_pipeline" || dataset === "transfers_funding"
      ? [["minValue", "maxValue"]]
      : [];
  const rangeError = rangePairs.find(([minKey, maxKey]) => {
    const min = filters[minKey] ? Number(filters[minKey]) : null;
    const max = filters[maxKey] ? Number(filters[maxKey]) : null;
    return min != null && max != null && min > max;
  }) ? "Minimum cannot be greater than maximum." : undefined;

  return { dataset, page, pageSize, sort, direction, columns, columnsExplicit, filters,
    ...(rangeError ? { rangeError } : {}) };
}

export type CrmReportPreset = { id: string; label: string; filters: Record<string, string> };

export type CrmPinnedReportView = {
  id: string;
  label: string;
  description: string;
  dataset: CrmReportDatasetId;
  filters: Record<string, string>;
};

export const CRM_PINNED_REPORT_VIEWS: readonly CrmPinnedReportView[] = [
  {
    id: "aum-needs-review",
    label: "AUM needs review",
    description: "Households with AUM older than 30 days",
    dataset: "household_aum",
    filters: { aumAge: "older30" },
  },
  {
    id: "open-pipeline",
    label: "Open pipeline",
    description: "Deals that have not reached won or lost",
    dataset: "deal_pipeline",
    filters: { dealState: "open" },
  },
  {
    id: "stale-engagement",
    label: "Stale engagement",
    description: "Households without an interaction in 90+ days",
    dataset: "client_engagement",
    filters: { interactionAge: "older90" },
  },
  {
    id: "stalled-transfers",
    label: "Stalled transfers",
    description: "Transfers that have remained in stage for 14+ days",
    dataset: "transfers_funding",
    filters: { stalledState: "stalled" },
  },
];

export const CRM_REPORT_PRESETS: Record<CrmReportDatasetId, readonly CrmReportPreset[]> = {
  household_aum: [
    { id: "stale-aum", label: "AUM older than 30 days", filters: { aumAge: "older30" } },
    { id: "missing-aum", label: "Missing AUM", filters: { aumAge: "missing" } },
    { id: "no-accounts", label: "No Apex accounts", filters: { accountState: "without" } },
  ],
  deal_pipeline: [
    { id: "overdue-deals", label: "Overdue opportunities", filters: { closeWindow: "overdue" } },
    { id: "open-pipeline", label: "Open pipeline", filters: { dealState: "open" } },
    { id: "missing-close", label: "Missing expected close", filters: { closeWindow: "missing" } },
  ],
  client_engagement: [
    { id: "never-contacted", label: "Never contacted", filters: { interactionAge: "never" } },
    { id: "stale-engagement", label: "90+ days since interaction", filters: { interactionAge: "older90" } },
    { id: "open-follow-up", label: "Open follow-up", filters: { taskState: "open" } },
  ],
  transfers_funding: [
    { id: "stalled-transfers", label: "Stalled transfers", filters: { stalledState: "stalled" } },
    { id: "open-checklist", label: "Open checklist", filters: { checklistState: "open" } },
    { id: "in-flight", label: "In-flight transfers", filters: { stage: "IN_TRANSFER" } },
    { id: "missing-funding", label: "Missing funding type", filters: { fundingState: "missing" } },
  ],
};

export function crmReportHref(
  query: CrmReportQuery,
  changes: Partial<Omit<CrmReportQuery, "filters">> & { filters?: Record<string, string> } = {},
): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams();
  if (next.dataset !== "household_aum") params.set("dataset", next.dataset);
  if (next.page > 1) params.set("page", String(next.page));
  if (next.pageSize !== 100) params.set("pageSize", String(next.pageSize));
  if (next.sort !== DEFAULT_SORT[next.dataset]) params.set("sort", next.sort);
  if (next.direction !== DEFAULT_DIRECTION[next.dataset]) params.set("direction", next.direction);
  if (next.columnsExplicit) {
    params.set("columnsSubmitted", "1");
    if (next.columns.length > 0) params.set("columns", next.columns.join(","));
  }
  for (const [key, value] of Object.entries(next.filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/reporting?${qs}` : "/reporting";
}

export function crmPinnedReportHref(view: CrmPinnedReportView): string {
  return crmReportHref(parseCrmReportQuery({
    dataset: view.dataset,
    ...view.filters,
  }));
}

export function formatCrmReportSourceAsOf(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(value));
}

export const EMPTY_CRM_REPORT_META: CrmReportPageMeta = {
  metrics: [], filters: [], sourceAsOf: null, retrievedAt: "", available: false,
};

export function crmReportProgressivePage(dataset: CrmReportDataset): ProgressivePage<CrmReportPageRow, CrmReportPageMeta> {
  return {
    rows: dataset.rows.map((values, index) => ({
      id: dataset.rowIds?.[index] ?? `${dataset.id}:${dataset.page}:${index}`,
      values,
      links: dataset.rowLinks[index] ?? {},
    })),
    page: dataset.page, pageSize: dataset.pageSize, total: dataset.totalRows,
    pageCount: dataset.pageCount, snapshot: dataset.snapshot ?? "0".repeat(32),
    meta: {
      metrics: dataset.metrics, filters: dataset.filters, sourceAsOf: dataset.sourceAsOf,
      retrievedAt: dataset.retrievedAt, available: dataset.available,
    },
  };
}

/** The paging API accepts a single, bounded, canonical report query. */
export function parseCrmReportNavigationRequest(params: URLSearchParams) {
  const requestedDataset = params.get("dataset") ?? "household_aum";
  if (!CRM_REPORT_DATASETS.includes(requestedDataset as CrmReportDatasetId)) throw new Error("invalid_report_dataset");
  const dataset = requestedDataset as CrmReportDatasetId;
  const allowed = new Set(["dataset", "page", "pageSize", "sort", "direction", "columns", "columnsSubmitted", "snapshot", ...FILTER_KEYS[dataset]]);
  for (const [key, value] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1 || value.length > 200
      || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid_report_query");
  }
  const pagination = parseProgressivePageParams(params);
  if (pagination.page > 100_000 || ![25, 50, 100].includes(pagination.pageSize)
    || (pagination.page > 1 && !pagination.snapshot)) throw new Error("invalid_report_page");
  if (params.has("sort") && !ALLOWED_SORTS[dataset].has(params.get("sort")!)) throw new Error("invalid_report_sort");
  if (params.has("direction") && !["asc", "desc"].includes(params.get("direction")!)) throw new Error("invalid_report_direction");
  if (params.has("columnsSubmitted") && params.get("columnsSubmitted") !== "1") throw new Error("invalid_report_columns");
  if (params.has("columns") && params.get("columns")!.split(",").some((column) => !ALLOWED_SORTS[dataset].has(column))) throw new Error("invalid_report_columns");
  const query = parseCrmReportQuery(Object.fromEntries(params));
  return { query, snapshot: pagination.snapshot };
}
