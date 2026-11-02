import type {
  AssetMapAccountView,
  AssetMapDocResult,
  AssetMapHouseholdLiveExtras,
  AssetMapHouseholdView,
  AssetMapPositionView,
  AssetMapRunSummary,
  AssetMapScheduleStatus,
} from "@/lib/data/asset-map";
import type { StatusTone } from "@/components/ui";
import { utcDateLabel } from "@/lib/display-date";

export const COPY = {
  emptyListTitle: "No asset mapping results",
  emptyListBody: "Upload client brokerage statements to the Google Drive input folder. Results will appear here after the next scan.",
  selectTitle: "Select a household",
  selectBody: "Choose a client from the sidebar to view their asset mapping results.",
  connectionError: "Connection Error",
  tryAgain: "Try Again",
  latest: "Latest",
  copyLink: "Copy link",
  shareCopied: "Copied!",
  searchPlaceholder: "Search clients...",
  collapseList: "Collapse sidebar",
  expandList: "Show households",
  viewOperations: "Operations",
  viewClientService: "Client Service",
  collapseAccount: "Collapse account",
  expandAccount: "Expand account",
  documentsNotProcessed: "Documents Not Processed",
  rolloverFallback: "Rollover account — all assets will be liquidated and transferred as cash.",
  inheritedFallback: "Inherited account — requires manual review due to potential titling issues that prevent standard ACAT transfer.",
  ownerNotIdentified: "Owner not identified",
  processedPrefix: "Processed",
} as const;

export type RunGroups = Record<string, AssetMapRunSummary[]>;

function clientKey(run: AssetMapRunSummary): string {
  return run.clientName ?? "";
}

function processedTime(run: AssetMapRunSummary): number {
  return run.processedAt ? Date.parse(run.processedAt) : 0;
}

export function groupRunsByClient(runs: AssetMapRunSummary[]): RunGroups {
  const groups: RunGroups = {};
  for (const run of runs) {
    const key = clientKey(run);
    if (!groups[key]) groups[key] = [];
    groups[key].push(run);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => processedTime(b) - processedTime(a));
  }
  return groups;
}

export function filterClientNames(names: string[], query: string): string[] {
  if (!query.trim()) return names;
  const q = query.toLowerCase();
  return names.filter((n) => n.toLowerCase().includes(q));
}

export function runLabel(index: number, total: number): string {
  return index === 0 ? COPY.latest : `Run ${total - index}`;
}

export function showRunSwitcher(runs: AssetMapRunSummary[]): boolean {
  return runs.length > 1;
}

export const RUN_SEGMENT_LIMIT = 4;

export function runSwitcherMode(runs: AssetMapRunSummary[]): "hidden" | "segmented" | "select" {
  if (!showRunSwitcher(runs)) return "hidden";
  return runs.length <= RUN_SEGMENT_LIMIT ? "segmented" : "select";
}

export function showRunCountBadge(runs: AssetMapRunSummary[]): boolean {
  return runs.length > 1;
}

export function emptyStateTitle(loadedRunCount: number): string {
  return loadedRunCount === 0 ? COPY.emptyListTitle : COPY.selectTitle;
}

export function positionStatus(p: AssetMapPositionView): string | null {
  return p.effectiveStatus || p.transferEligible || null;
}

export function positionStatusTone(status: string | null): StatusTone {
  switch (status) {
    case "ACAT": return "ok";
    case "REVIEW": return "caution";
    case "LIQUIDATE": return "attention";
    case "UNSUPPORTED": return "blocked";
    case "ACH/WIRE":
    case "ACH":
    case "WIRE": return "info";
    default: return "neutral";
  }
}

export function docStatusTone(status: string | null): StatusTone {
  if (status === "extracted") return "ok";
  if (status === "stale") return "caution";
  if (status === "rejected") return "danger";
  return "neutral";
}

export const HOUSEHOLD_STATUS_LABEL: Record<AssetMapRunSummary["status"], string> = {
  blocked: "Unsupported positions",
  attention: "Positions to liquidate",
  caution: "Positions to review",
  ok: "Ready to transfer",
  neutral: "No routed positions",
};

export type StatusCounts = {
  total: number; acat: number; review: number; unsupported: number; liquidate: number; transfer: number;
};

export function statusCounts(household: AssetMapHouseholdView): StatusCounts {
  const c = { acat: 0, review: 0, unsupported: 0, liquidate: 0, transfer: 0 };
  for (const acc of household.accounts) {
    for (const p of acc.positions) {
      const s = positionStatus(p);
      if (s === "ACAT") c.acat++;
      else if (s === "LIQUIDATE") c.liquidate++;
      else if (s === "UNSUPPORTED") c.unsupported++;
      else if (s === "REVIEW") c.review++;
      else if (s === "ACH/WIRE") c.transfer++;
    }
  }
  return { ...c, total: c.acat + c.review + c.unsupported + c.liquidate + c.transfer };
}

export function householdTotalValue(household: AssetMapHouseholdView): number {
  return household.accounts.reduce((sum, acc) => sum + (acc.totalValue ?? 0), 0);
}

export function hasTaxLots(p: AssetMapPositionView): boolean {
  return p.lots.length > 0;
}

export type SummaryItem = {
  account: AssetMapAccountView;
  problemPositions: AssetMapPositionView[];
};

export type ClientServiceSummary = {
  ready: SummaryItem[];
  rollover: SummaryItem[];
  action: SummaryItem[];
  unsupported: SummaryItem[];
  transferReadyValue: number;
  rolloverValue: number;
  percentReady: number;
  hasExtractionQualityNotice: boolean;
};

export function clientServiceSummary(household: AssetMapHouseholdView): ClientServiceSummary {
  const ready: SummaryItem[] = [];
  const rollover: SummaryItem[] = [];
  const action: SummaryItem[] = [];
  const unsupported: SummaryItem[] = [];
  let transferReadyValue = 0;

  for (const account of household.accounts) {
    const isValidationWarning = account.validationStatus === "WARNING";
    const problemPositions = account.positions.filter((p) => positionStatus(p) !== "ACAT");
    const item = { account, problemPositions };
    if (account.apexRestriction != null) unsupported.push(item);
    else if (account.isRollover) rollover.push(item);
    else if (isValidationWarning) action.push(item);
    else if (problemPositions.length === 0) ready.push(item);
    else action.push(item);

    if (!account.isRollover && !isValidationWarning) {
      for (const p of account.positions) {
        if (positionStatus(p) === "ACAT") transferReadyValue += p.marketValue ?? 0;
      }
    }
  }

  const total = householdTotalValue(household);
  return {
    ready,
    rollover,
    action,
    unsupported,
    transferReadyValue,
    rolloverValue: rollover.reduce((sum, i) => sum + (i.account.totalValue ?? 0), 0),
    percentReady: Math.round((transferReadyValue / (total || 1)) * 100),
    hasExtractionQualityNotice: household.accounts.some((a) => a.validationStatus === "WARNING"),
  };
}

export function runHref(id: string): string {
  return `/asset-mapping?run=${encodeURIComponent(id)}`;
}

export function parseRunParam(search: string): string | null {
  const run = new URLSearchParams(search).get("run");
  return run ? run : null;
}

export function routingNotes(p: AssetMapPositionView): string | null {
  return p.effectiveNotes ?? p.transferNotes ?? null;
}

export const NOT_PROVIDED = "not provided";

export function isCashPosition(p: AssetMapPositionView): boolean {
  const sym = (p.symbol ?? "").toUpperCase().trim();
  return sym === "CASH" || /cash|sweep|free credit|credit balance/i.test(p.description ?? "");
}

export function showCostBasisColumn(acc: AssetMapAccountView): boolean {
  return acc.costBasisStatus !== "NOT_APPLICABLE";
}

export function granularityLabel(p: AssetMapPositionView): string | null {
  if (p.costBasisGranularity === "lot") return `lot · ${p.lots.length}`;
  if (p.costBasisGranularity === "position") return "position";
  return null;
}

export function transferringLabel(v: boolean | null): string {
  return v === true ? "Yes" : v === false ? "No" : "—";
}

export function positionColumnCount(acc: AssetMapAccountView, withActions: boolean): number {
  return 7 + (showCostBasisColumn(acc) ? 1 : 0) + (withActions ? 1 : 0);
}

function hasCostBasis(p: AssetMapPositionView): boolean {
  return p.costBasis != null || p.lots.some((l) => l.costBasis != null);
}

export function costBasisPillLabel(acc: AssetMapAccountView): string | null {
  if (acc.costBasisStatus === "COMPLETE") return "Cost basis: complete";
  if (acc.costBasisStatus === "NOT_APPLICABLE") return "Cost basis: n/a · tax-advantaged";
  if (acc.costBasisStatus === "PARTIAL") {
    const missing = acc.positions.filter((p) => !isCashPosition(p) && !hasCostBasis(p)).length;
    return `Cost basis: partial · ${missing} missing`;
  }
  if (acc.costBasisStatus === "MISSING") return "Cost basis: missing";
  return null;
}

export function costBasisPillTone(acc: AssetMapAccountView): StatusTone {
  if (acc.costBasisStatus === "COMPLETE") return "ok";
  if (acc.costBasisStatus === "NOT_APPLICABLE") return "neutral";
  return "caution";
}

export const COST_BASIS_BANNER_NAME_LIMIT = 12;

export type CostBasisBanner = { names: string[]; more: number; missing: number; securities: number };

export function costBasisBanner(acc: AssetMapAccountView): CostBasisBanner | null {
  if (acc.costBasisStatus !== "PARTIAL" && acc.costBasisStatus !== "MISSING") return null;
  const securities = acc.positions.filter((p) => !isCashPosition(p));
  const missing = securities.filter((p) => !hasCostBasis(p)).map((p) => p.symbol || p.description || "?");
  if (missing.length === 0) return null;
  return {
    names: missing.slice(0, COST_BASIS_BANNER_NAME_LIMIT),
    more: Math.max(0, missing.length - COST_BASIS_BANNER_NAME_LIMIT),
    missing: missing.length,
    securities: securities.length,
  };
}

export function ownerLabel(acc: AssetMapAccountView): string {
  return acc.accountHolder?.trim() ? acc.accountHolder : COPY.ownerNotIdentified;
}

export type CalendarDay = { year: number; month: number; day: number };

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthNumber(name: string): number {
  const n = name.toLowerCase();
  return MONTH_NAMES.findIndex((full) => full === n || full.slice(0, 3) === n) + 1;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function calendarDay(year: number, month: number, day: number): CalendarDay | null {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : null;
}

/** The pipeline's strict statement-date formats (YYYY-MM-DD, M/D/YYYY, M-D-YYYY,
 *  "March 5, 2020", "Mar 5, 2020"). Parsed to integers, never through Date, so the
 *  browser time zone cannot move the day. */
export function parseCalendarDay(value: string | null): CalendarDay | null {
  if (value == null) return null;
  const s = value.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/.exec(s);
  if (m) return calendarDay(Number(m[4]), Number(m[1]), Number(m[3]));
  m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(s);
  if (m) {
    const month = monthNumber(m[1]);
    return month === 0 ? null : calendarDay(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

export type LotTerm = "long" | "short";

export const LOT_TERM_LABEL: Record<LotTerm, string> = { long: "long-term", short: "short-term" };

function dayKey(year: number, month: number, day: number): number {
  return year * 10000 + month * 100 + day;
}

/** Long term means held more than one year: the statement day is after the
 *  acquisition day's first anniversary. Exactly one year is short term. */
export function lotTerm(acquisitionDate: string | null, statementDate: string | null): LotTerm | null {
  const acquired = parseCalendarDay(acquisitionDate);
  const asOf = parseCalendarDay(statementDate);
  if (acquired == null || asOf == null) return null;
  const anniversary = dayKey(acquired.year + 1, acquired.month, acquired.day);
  return dayKey(asOf.year, asOf.month, asOf.day) > anniversary ? "long" : "short";
}

export function householdProcessedLabel(runs: AssetMapRunSummary[], processedAt: string | null): string | null {
  if (runSwitcherMode(runs) !== "hidden") return null;
  const day = utcDateLabel(processedAt);
  return day ? `${COPY.processedPrefix} ${day}` : null;
}

export function scheduleLabel(s: AssetMapScheduleStatus): string {
  return s.active
    ? `Live · every ${s.scanIntervalMinutes} min`
    : `Asleep · resumes ${s.businessDays} ${s.businessHours.split(" – ")[0]}`;
}

export function documentsNotProcessed(extras: AssetMapHouseholdLiveExtras | null): AssetMapDocResult[] {
  return extras?.docResults.filter((d) => d.status === "rejected" || d.status === "stale") ?? [];
}

export function rolloverNoteFor(accountId: string, extras: AssetMapHouseholdLiveExtras | null): string {
  return extras?.rolloverNotes[accountId] ?? COPY.rolloverFallback;
}

export type WorkspaceView = "operations" | "client-service";

export type WorkspaceState = {
  listStatus: "loading" | "loaded" | "failed";
  runs: AssetMapRunSummary[];
  groups: RunGroups;
  pendingRunId: string | null;
  selectedClient: string | null;
  selectedId: string | null;
  householdStatus: "idle" | "loading" | "loaded" | "failed";
  household: AssetMapHouseholdView | null;
  liveExtras: AssetMapHouseholdLiveExtras | null;
  schedule: AssetMapScheduleStatus | null;
  railOpen: boolean;
  view: WorkspaceView;
  collapsedAccounts: string[];
  expandedLots: string[];
  search: string;
};

export type WorkspaceAction =
  | { type: "listLoaded"; runs: AssetMapRunSummary[] }
  | { type: "listFailed" }
  | { type: "selectClient"; name: string }
  | { type: "selectRun"; id: string }
  | { type: "householdLoading" }
  | { type: "householdLoaded"; household: AssetMapHouseholdView }
  | { type: "householdFailed" }
  | { type: "liveExtrasLoaded"; extras: AssetMapHouseholdLiveExtras | null }
  | { type: "scheduleLoaded"; schedule: AssetMapScheduleStatus | null }
  | { type: "retry" }
  | { type: "listReload" }
  | { type: "listRefreshed"; runs: AssetMapRunSummary[] }
  | { type: "householdRefreshed"; id: string; household: AssetMapHouseholdView; extras: AssetMapHouseholdLiveExtras | null }
  | { type: "toggleRail" }
  | { type: "setView"; view: WorkspaceView }
  | { type: "toggleAccount"; id: string }
  | { type: "toggleLots"; id: string }
  | { type: "setSearch"; query: string }
  | { type: "popState"; runId: string | null };

export function initialWorkspaceState(initialRunId: string | null): WorkspaceState {
  return {
    listStatus: "loading",
    runs: [],
    groups: {},
    pendingRunId: initialRunId,
    selectedClient: null,
    selectedId: null,
    householdStatus: "idle",
    household: null,
    liveExtras: null,
    schedule: null,
    railOpen: true,
    view: "operations",
    collapsedAccounts: [],
    expandedLots: [],
    search: "",
  };
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "listLoaded": {
      const groups = groupRunsByClient(action.runs);
      const next = { ...state, listStatus: "loaded" as const, runs: action.runs, groups, pendingRunId: null };
      const match = state.pendingRunId ? action.runs.find((r) => r.id === state.pendingRunId) : undefined;
      if (!match) return next;
      const railOpen = match.id === state.selectedId ? state.railOpen : false;
      return { ...next, selectedClient: clientKey(match), selectedId: match.id, railOpen };
    }
    case "listFailed":
      return { ...state, listStatus: "failed" };
    case "selectClient": {
      const runs = state.groups[action.name] ?? [];
      return runs.length > 0
        ? { ...state, selectedClient: action.name, selectedId: runs[0].id, railOpen: false }
        : { ...state, selectedClient: action.name };
    }
    case "selectRun":
      return { ...state, selectedId: action.id };
    case "householdLoading":
      return { ...state, householdStatus: "loading", household: null, liveExtras: null };
    case "householdLoaded":
      return { ...state, householdStatus: "loaded", household: action.household };
    case "householdFailed":
      return { ...state, householdStatus: "failed", household: null };
    case "liveExtrasLoaded":
      return { ...state, liveExtras: action.extras };
    case "scheduleLoaded":
      return { ...state, schedule: action.schedule };
    case "listReload":
      return { ...state, listStatus: "loading", pendingRunId: state.selectedId };
    case "listRefreshed":
      return state.listStatus === "loaded" ? { ...state, runs: action.runs, groups: groupRunsByClient(action.runs) } : state;
    case "householdRefreshed":
      if (state.selectedId !== action.id || state.householdStatus !== "loaded") return state;
      return { ...state, household: action.household, liveExtras: action.extras ?? state.liveExtras };
    case "retry":
      return {
        ...state,
        listStatus: "loading",
        pendingRunId: null,
        selectedClient: null,
        selectedId: null,
        householdStatus: "idle",
        household: null,
        liveExtras: null,
      };
    case "toggleRail":
      return { ...state, railOpen: !state.railOpen };
    case "setView":
      return { ...state, view: action.view };
    case "toggleAccount":
      return { ...state, collapsedAccounts: toggle(state.collapsedAccounts, action.id) };
    case "toggleLots":
      return { ...state, expandedLots: toggle(state.expandedLots, action.id) };
    case "setSearch":
      return { ...state, search: action.query };
    case "popState": {
      if (action.runId == null) {
        return { ...state, selectedClient: null, selectedId: null, householdStatus: "idle", household: null, liveExtras: null };
      }
      const match = state.runs.find((r) => r.id === action.runId);
      if (!match) return state;
      const railOpen = match.id === state.selectedId ? state.railOpen : false;
      return { ...state, selectedClient: clientKey(match), selectedId: match.id, railOpen };
    }
  }
}
