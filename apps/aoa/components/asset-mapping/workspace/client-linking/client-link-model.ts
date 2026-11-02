import {
  MAX_BACKFILL_FOLDERS,
  MAX_LINK_PEOPLE,
  MAX_LINK_REASON,
  type ClientLinkBatchResult,
  type ClientLinkConfig,
  type ClientLinkCoverage,
  type ClientLinkDraft,
  type ClientLinkFolder,
  type ClientLinkIdentity,
  type ClientLinkLookup,
  type ClientLinkLookupState,
  type ClientLinkPage,
  type ClientLinkPerson,
  type ClientLinkPreview,
  type ClientLinkPreviewTarget,
  type ClientLinkQueueItem,
  type ClientLinkReviewState,
  type RunClientLink,
} from "@/lib/data/asset-map-client-link-contract";
import type { StatusTone } from "@/components/ui";

export const CLIENT_LINK_COPY = {
  tabHouseholds: "Asset mapping",
  tabLinking: "Client linking",
  writesDisabled: "Client linking changes are currently disabled.",
  writesDisabledQueue:
    "Client linking changes are currently disabled. You can view accepted links while review is unavailable.",
  runNotLoaded: "This run is not in AoA yet. It appears after the next hourly import.",
  searchFolders: "Search source folders",
  filterGroup: "Filter folders by review state",
  statFolders: "Folders in this result",
  statReady: "Ready to backfill",
  statComplete: "Complete associations",
  statCoverage: "Historical coverage",
  loadMore: "Load more folders",
  previewBackfill: "Preview backfill",
  viewRun: "View run",
  review: "Review",
  manage: "Manage",
  tryAgain: "Try again",
  staleTitle: "This preview needs another review.",
  failedTitle: "The request could not complete.",
  staleDetail: "Refresh the current links and create a new preview. Nothing from this preview will be applied.",
  retrySameKey: "Retry uses the same request key.",
  refreshAndReview: "Refresh and review again",
  retrySameApply: "Retry same apply",
  applyReversal: "Apply reviewed reversal",
  applyChanges: "Apply reviewed changes",
  uncertainApply:
    "The previous apply may have completed. Retry this same apply to recover its original result without duplicating changes.",
  previewExpired: "This preview expired. Refresh the links and review a new preview.",
  reviewChanges: "Review exact changes",
  reviewReversal: "Review reversal",
  resultReversal: "Reviewed reversal applied",
  resultUpdated: "Client links updated",
  batchTitle: "Client link change",
  manageTitle: "Manage linked people",
  reviewTitle: "Review client match",
  previewChanges: "Preview changes",
  previewRemoval: "Preview removal",
  folderDiffers: "The saved folder association is different.",
  usePeople: "Use these people in this draft",
  findClient: "Find a Cedar Ridge client",
  searchPlaceholder: "Search name or Cedar Ridge ID",
  primary: "Primary person for this folder",
  noPrimary: "No primary person selected",
  coverageLegend: "Have all known people been reviewed?",
  coverageComplete: "All known people reviewed",
  coveragePartial: "More people still need review",
  scopeLegend: "Which existing runs should receive this link?",
  scopeThisRun: "This run only",
  scopeAllExisting: "All existing runs from this same folder",
  reuse: "Reuse this link for future runs",
  note: "Review note (optional)",
  notePlaceholder: "Record the evidence used to verify this association",
  cardTitle: "Cedar Ridge client",
  loadingRun: "Loading the run’s client link…",
  noLink: "No accepted client link",
  directoryUnavailable: "Client directory unavailable",
  directoryUnavailableBody: "The lookup could not complete. Existing links are preserved.",
  directoryPending: "Checking the client directory",
  directoryPendingBody: "Asset mapping can continue while this lookup is pending.",
  directoryStale: "Directory source is stale",
  directoryUnverified: "Directory source needs verification",
  directoryUnverifiedBody:
    "Source freshness and eligibility must be verified before accepting new links. A successful fetch alone is not enough.",
  suggestionAmbiguous: "More than one person needs review",
  suggestionSingle: "A possible Cedar Ridge client",
  holderConflict: "Holder evidence needs review",
  retryLookup: "Retry lookup",
  lookupSuperseded: "This lookup was superseded by a newer change. The latest accepted links are preserved.",
  manageLink: "Manage link",
  reviewLink: "Review & link client",
  activity: "Client link activity",
  viewChange: "View change",
  copied: "Copied",
  copy: "Copy",
  selectAll: "Select all loaded eligible folders",
  previousRun: "Previous run",
  runNumberMissing: "Run number not recorded",
  savedFolder: "Saved folder association",
  savedFolderDetail: "These settings change separately from the selected run histories.",
  noAcceptedPeople: "No accepted people",
  notRecorded: "Not recorded",
  directoryQueried: "Directory queried",
  directoryQueriedMissing: "Directory query time not recorded",
  acceptedHere: "Accepted on this run",
  methodManual: "Confirmed by Operations",
  methodInherited: "Inherited from its source folder",
  methodBackfill: "Applied through reviewed backfill",
  methodRevert: "Restored through reviewed reversal",
  methodUnknown: "How this link was made is not recorded",
  close: "Close",
} as const;

export const QUEUE_FILTERS: readonly { id: ClientLinkReviewState | null; label: string }[] = [
  { id: null, label: "All folders" },
  { id: "unresolved", label: "Unresolved" },
  { id: "partial", label: "Partial" },
  { id: "complete", label: "Complete" },
  { id: "conflict", label: "Conflicts" },
];

export const QUEUE_PAGE_SIZE = 50;

export const REVIEW_STATES: readonly ClientLinkReviewState[] = ["unresolved", "partial", "complete", "conflict"];

export function reviewStateTone(state: ClientLinkReviewState): StatusTone {
  if (state === "complete") return "ok";
  if (state === "partial") return "caution";
  if (state === "conflict") return "danger";
  return "attention";
}

/** Per-state totals, each from a one-row queue request filtered to that state. */
export type QueueFilterTotals = Partial<Record<ClientLinkReviewState, number>>;
export type QueueFilterKey = ClientLinkReviewState | "all";

export function filterKey(id: ClientLinkReviewState | null): QueueFilterKey {
  return id ?? "all";
}

export function queueFilterCounts(totals: QueueFilterTotals): Record<QueueFilterKey, number | null> {
  const known = REVIEW_STATES.map((s) => totals[s]);
  const all = known.every((n) => n != null) ? known.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;
  return {
    all,
    unresolved: totals.unresolved ?? null,
    partial: totals.partial ?? null,
    complete: totals.complete ?? null,
    conflict: totals.conflict ?? null,
  };
}

export const LINK_SUMMARY_COPY = {
  label: "Client link",
  loading: "Loading…",
  noPeople: "No linked people",
  showDetails: "Show details",
} as const;

export function linkSummaryPeople(run: RunClientLink): string {
  const people = run.identity.people;
  return people.length > 0 ? people.map((p) => p.display_name).join(" + ") : LINK_SUMMARY_COPY.noPeople;
}

export type ClientLinkCapabilities = { visible: boolean; canReview: boolean; writesDisabled: boolean };

/** `canOperate` false is the read-only role (ticket): it views, never reviews,
 *  and, as in statement-pipeline, sees the disabled notice only when writes are off. */
export function clientLinkCapabilities(canLink: boolean, config: ClientLinkConfig | null, canOperate = true): ClientLinkCapabilities {
  const visible = canLink && config?.enabled === true;
  const writesEnabled = config?.writesEnabled === true;
  return { visible, canReview: visible && writesEnabled && canOperate, writesDisabled: visible && !writesEnabled };
}

export type QueueStats = {
  folders: number;
  readyToBackfill: number;
  complete: number;
  coverage: { linked: number; runs: number };
};

export function canBulk(item: ClientLinkQueueItem): boolean {
  return (
    item.bulk_eligible &&
    item.source_scope != null &&
    item.folder?.decision.review_state === "complete" &&
    item.folder.decision.conflict_flags.length === 0
  );
}

export function queueStats(page: ClientLinkPage): QueueStats {
  const runs = page.items.reduce((n, i) => n + i.run_count, 0);
  const unlinked = page.items.reduce((n, i) => n + i.unlinked_run_count, 0);
  return {
    folders: page.total,
    readyToBackfill: page.items.filter(canBulk).reduce((n, i) => n + i.unlinked_run_count, 0),
    complete: page.items.filter((i) => i.review_state === "complete").length,
    coverage: { linked: runs - unlinked, runs },
  };
}

export type FolderSelection = ReadonlyMap<string, ClientLinkQueueItem>;

export function toggleFolder(selection: FolderSelection, item: ClientLinkQueueItem): FolderSelection {
  const next = new Map(selection);
  if (next.has(item.scope_key)) next.delete(item.scope_key);
  else if (canBulk(item) && next.size < MAX_BACKFILL_FOLDERS) next.set(item.scope_key, item);
  return next;
}

export type SelectAllView = { checked: boolean; disabled: boolean };

/** Checked once the selection holds every loaded eligible folder, or 100 of them. */
export function selectAllView(items: readonly ClientLinkQueueItem[], selection: FolderSelection): SelectAllView {
  const eligible = items.filter(canBulk);
  const selected = eligible.filter((i) => selection.has(i.scope_key)).length;
  return {
    checked: eligible.length > 0 && selected >= Math.min(eligible.length, MAX_BACKFILL_FOLDERS),
    disabled: eligible.length === 0,
  };
}

/** The folders select-all passes to toggleFolder: the selected ones when checked, else unselected ones up to the cap. */
export function selectAllToggles(items: readonly ClientLinkQueueItem[], selection: FolderSelection): ClientLinkQueueItem[] {
  const eligible = items.filter(canBulk);
  if (selectAllView(items, selection).checked) return eligible.filter((i) => selection.has(i.scope_key));
  return eligible.filter((i) => !selection.has(i.scope_key)).slice(0, Math.max(0, MAX_BACKFILL_FOLDERS - selection.size));
}

export function buildBackfillDraft(selection: FolderSelection): ClientLinkDraft {
  return {
    action: "backfill",
    target_scope: "bulk",
    folder_targets: [...selection.values()].flatMap((i) =>
      i.source_scope ? [{ source_scope: i.source_scope, expected_revision: i.folder?.revision ?? 0 }] : [],
    ),
    reason: "Reviewed historical backfill",
  };
}

export type LinkDraftState = {
  people: ClientLinkPerson[];
  primary: string | null;
  coverage: ClientLinkCoverage | null;
  scope: "this_run" | "all_existing";
  reuse: boolean;
  note: string;
};

export type DraftAction =
  | { type: "togglePerson"; person: ClientLinkPerson }
  | { type: "setPrimary"; userId: string | null }
  | { type: "setCoverage"; coverage: ClientLinkCoverage }
  | { type: "setScope"; scope: LinkDraftState["scope"] }
  | { type: "setReuse"; reuse: boolean }
  | { type: "setNote"; note: string }
  | { type: "usePeople"; folder: ClientLinkIdentity }
  | { type: "reset"; run: RunClientLink };

export function initialDraft(run: RunClientLink): LinkDraftState {
  return {
    people: run.identity.people,
    primary: run.identity.primary_user_id,
    coverage: run.identity.decision_id ? run.identity.coverage : null,
    scope: "this_run",
    reuse: run.source_scope ? (run.folder?.reuse_future ?? true) : false,
    note: "",
  };
}

export function draftReducer(draft: LinkDraftState, action: DraftAction): LinkDraftState {
  switch (action.type) {
    case "togglePerson": {
      const id = action.person.user_id;
      if (draft.people.some((p) => p.user_id === id)) {
        return { ...draft, people: draft.people.filter((p) => p.user_id !== id), primary: draft.primary === id ? null : draft.primary };
      }
      if (draft.people.length >= MAX_LINK_PEOPLE) return draft;
      return { ...draft, people: [...draft.people, { user_id: id, display_name: action.person.display_name }] };
    }
    case "setPrimary":
      return { ...draft, primary: action.userId && draft.people.some((p) => p.user_id === action.userId) ? action.userId : null };
    case "setCoverage":
      return { ...draft, coverage: action.coverage };
    case "setScope":
      return { ...draft, scope: action.scope };
    case "setReuse":
      return { ...draft, reuse: action.reuse };
    case "setNote":
      return { ...draft, note: action.note.slice(0, MAX_LINK_REASON) };
    case "usePeople":
      return {
        ...draft,
        people: action.folder.people.slice(0, MAX_LINK_PEOPLE),
        coverage: action.folder.coverage,
        primary: action.folder.primary_user_id,
      };
    case "reset":
      return initialDraft(action.run);
  }
}

function sameIdentity(a: ClientLinkIdentity, b: ClientLinkIdentity): boolean {
  const ids = (x: ClientLinkIdentity) => x.people.map((p) => p.user_id).sort().join("\n");
  return ids(a) === ids(b) && a.primary_user_id === b.primary_user_id && a.coverage === b.coverage;
}

export function folderDiffers(run: RunClientLink): boolean {
  return run.folder != null && run.folder.decision.people.length > 0 && !sameIdentity(run.identity, run.folder.decision);
}

export function isUnlinking(run: RunClientLink, draft: LinkDraftState): boolean {
  return run.identity.people.length > 0 && draft.people.length === 0;
}

export function buildLinkDraft(run: RunClientLink, draft: LinkDraftState): ClientLinkDraft {
  const unlinking = draft.people.length === 0;
  return {
    action: unlinking ? "unlink" : "confirm",
    run_id: run.run_id,
    target_scope: draft.scope,
    expected_identity_version: run.identity_version,
    expected_folder_revision: run.source_scope ? (run.folder?.revision ?? 0) : null,
    folder_targets: [],
    people_ids: unlinking ? [] : draft.people.map((p) => p.user_id),
    coverage: draft.coverage ?? "partial",
    primary_user_id: unlinking ? null : draft.primary,
    reuse_future: !unlinking && run.source_scope != null && draft.reuse,
    reason: draft.note.trim(),
  };
}

export type FailureView = { title: string; message: string | null; stale: boolean; retry: boolean };

export function failureView(result: { reason: string; message: string | null }): FailureView {
  if (result.reason === "stale") {
    return { title: CLIENT_LINK_COPY.staleTitle, message: result.message, stale: true, retry: false };
  }
  const message = result.reason === "writes_disabled" ? CLIENT_LINK_COPY.writesDisabled : result.message;
  return { title: CLIENT_LINK_COPY.failedTitle, message, stale: false, retry: result.reason === "unavailable" };
}

export function isPreviewExpired(preview: ClientLinkPreview, now: number): boolean {
  return Date.parse(preview.expires_at) <= now;
}

export type LookupNotice = { title: string; body: string };

export function lookupNotice(lookup: ClientLinkLookup | null): LookupNotice | null {
  if (!lookup) return null;
  if (lookup.state === "unavailable") {
    return { title: CLIENT_LINK_COPY.directoryUnavailable, body: lookup.message || CLIENT_LINK_COPY.directoryUnavailableBody };
  }
  if (lookup.state === "pending") {
    return { title: CLIENT_LINK_COPY.directoryPending, body: CLIENT_LINK_COPY.directoryPendingBody };
  }
  const d = lookup.directory;
  const verified = d != null && d.complete && d.eligibility_verified && d.freshness === "fresh";
  if (lookup.state === "stale" || (d != null && !verified)) {
    return {
      title: d?.freshness === "stale" ? CLIENT_LINK_COPY.directoryStale : CLIENT_LINK_COPY.directoryUnverified,
      body: lookup.message || CLIENT_LINK_COPY.directoryUnverifiedBody,
    };
  }
  return null;
}

const RETRYABLE_LOOKUPS: readonly ClientLinkLookupState[] = ["unavailable", "stale", "not_attempted", "pending"];

export function canRetryLookup(state: ClientLinkLookupState): boolean {
  return RETRYABLE_LOOKUPS.includes(state);
}

export type SuggestionView = { title: string; people: ClientLinkPerson[]; evidence: string[] };

export function suggestionView(lookup: ClientLinkLookup | null): SuggestionView | null {
  const s = lookup?.suggestion;
  if (!s || s.candidates.length === 0) return null;
  return {
    title: s.kind === "ambiguous" ? CLIENT_LINK_COPY.suggestionAmbiguous : CLIENT_LINK_COPY.suggestionSingle,
    people: s.candidates.map((c) => ({ user_id: c.user_id, display_name: c.display_name })),
    evidence: [...new Set([...s.evidence, ...s.candidates.flatMap((c) => c.evidence)])].slice(0, 4),
  };
}

/** null when the run has no holder-evidence conflict. */
export function holderConflicts(run: RunClientLink): string[] | null {
  const flags = run.identity.conflict_flags;
  return run.identity.review_state === "conflict" || flags.length > 0 ? flags : null;
}

const LINK_METHOD_COPY: Record<NonNullable<ClientLinkIdentity["method"]>, string> = {
  manual: CLIENT_LINK_COPY.methodManual,
  inherited: CLIENT_LINK_COPY.methodInherited,
  backfill: CLIENT_LINK_COPY.methodBackfill,
  revert: CLIENT_LINK_COPY.methodRevert,
};

export type LinkMethodView = { label: string; acceptedHere: boolean };

/** null when the run has no linked people. An inherited or unrecorded link is not accepted on this run. */
export function linkMethodView(identity: ClientLinkIdentity): LinkMethodView | null {
  if ((identity.people ?? []).length === 0) return null;
  const label = identity.method ? LINK_METHOD_COPY[identity.method] : undefined;
  if (typeof label !== "string") return { label: CLIENT_LINK_COPY.methodUnknown, acceptedHere: false };
  return { label, acceptedHere: identity.method !== "inherited" };
}

export function previewRunLabel(target: Pick<ClientLinkPreviewTarget, "run_number" | "is_historical">): string {
  if (target.is_historical === true) return CLIENT_LINK_COPY.previousRun;
  const n = target.run_number;
  return Number.isInteger(n) && n > 0 ? `Run ${n}` : CLIENT_LINK_COPY.runNumberMissing;
}

/** The after identity's review state, or null when the pipeline did not send a known one. */
export function afterStateBadge(target: Pick<ClientLinkPreviewTarget, "after">): ClientLinkReviewState | null {
  const state: unknown = target.after?.review_state;
  return REVIEW_STATES.find((s) => s === state) ?? null;
}

export function directoryQueriedLine(preview: Pick<ClientLinkPreview, "directory">): string {
  const at = preview.directory?.fetched_at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at))
    ? `${CLIENT_LINK_COPY.directoryQueried} ${clientLinkDate(at)}`
    : CLIENT_LINK_COPY.directoryQueriedMissing;
}

export type FolderSideView = { people: string; reuse: string };
export type FolderChangeView = { key: string; folderId: string; before: FolderSideView; after: FolderSideView };

function folderSide(link: ClientLinkFolder | null | undefined): FolderSideView {
  const raw = link?.decision?.people;
  const names = (Array.isArray(raw) ? raw : []).map((p) => p?.display_name || p?.user_id).filter(Boolean);
  const reuse = link?.reuse_future;
  return {
    people: names.length > 0 ? names.join(" + ") : CLIENT_LINK_COPY.noAcceptedPeople,
    reuse: reuse === true ? "On" : reuse === false ? "Off" : CLIENT_LINK_COPY.notRecorded,
  };
}

/** The saved folder association before and after, from the preview's folder_changes. Missing fields read as not recorded. */
export function folderChangeViews(preview: Pick<ClientLinkPreview, "folder_changes">): FolderChangeView[] {
  const changes = Array.isArray(preview.folder_changes) ? preview.folder_changes : [];
  return changes.flatMap((change, i) => {
    if (change == null || typeof change !== "object") return [];
    const folderId = change.source_scope?.source_folder_id || CLIENT_LINK_COPY.notRecorded;
    return [{ key: `${i}:${folderId}`, folderId, before: folderSide(change.before), after: folderSide(change.after) }];
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function clientLinkDate(value: string | undefined): string {
  return value
    ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Not recorded";
}

export function batchLine(result: Pick<ClientLinkBatchResult, "applied" | "unchanged" | "excluded">): string {
  return `${plural(result.applied, "run")} updated · ${result.unchanged} unchanged · ${result.excluded} excluded.`;
}

export function openRunTarget(runs: readonly { id: string }[], runId: string): "select" | "not_loaded" {
  return runs.some((r) => r.id === runId) ? "select" : "not_loaded";
}

export type QueueStatus = "idle" | "loading" | "loaded" | "failed";

/** A fresh value per queue request; a response whose request no longer matches is dropped. */
export type QueueRequest = symbol;

export type ClientLinkState = {
  config: ClientLinkConfig | null;
  queueStatus: QueueStatus;
  page: ClientLinkPage;
  queueFailure: FailureView | null;
  queueRequest: QueueRequest | null;
  run: RunClientLink | null;
  runFailure: FailureView | null;
  preview: ClientLinkPreview | null;
  applying: boolean;
  uncertain: boolean;
  failure: FailureView | null;
  result: ClientLinkBatchResult | null;
  batch: ClientLinkBatchResult | null;
  reloadRun: boolean;
  reloadQueue: boolean;
};

export type ClientLinkAction =
  | { type: "configLoaded"; config: ClientLinkConfig | null }
  | { type: "queueLoading"; request: QueueRequest }
  | { type: "queueLoaded"; request: QueueRequest; page: ClientLinkPage; append: boolean }
  | { type: "queueFailed"; request: QueueRequest; failure: FailureView }
  | { type: "runLoading" }
  | { type: "runLoaded"; run: RunClientLink }
  | { type: "runFailed"; failure: FailureView }
  | { type: "previewReady"; preview: ClientLinkPreview }
  | { type: "batchLoaded"; batch: ClientLinkBatchResult }
  | { type: "failed"; failure: FailureView }
  | { type: "applyStarted" }
  | { type: "applyRejected"; failure: FailureView }
  | { type: "applyUncertain" }
  | { type: "applyConfirmed"; result: ClientLinkBatchResult }
  | { type: "reloadsHandled" }
  | { type: "writesDisabled" }
  | { type: "disabled" }
  | { type: "dismiss" };

const EMPTY_PAGE: ClientLinkPage = { items: [], total: 0, next_cursor: null };

export function initialClientLinkState(): ClientLinkState {
  return {
    config: null,
    queueStatus: "idle",
    page: EMPTY_PAGE,
    queueFailure: null,
    queueRequest: null,
    run: null,
    runFailure: null,
    preview: null,
    applying: false,
    uncertain: false,
    failure: null,
    result: null,
    batch: null,
    reloadRun: false,
    reloadQueue: false,
  };
}

export function clientLinkReducer(state: ClientLinkState, action: ClientLinkAction): ClientLinkState {
  switch (action.type) {
    case "configLoaded":
      return { ...state, config: action.config };
    case "queueLoading":
      return { ...state, queueStatus: "loading", queueFailure: null, queueRequest: action.request };
    case "queueLoaded": {
      if (action.request !== state.queueRequest) return state;
      if (!action.append) return { ...state, queueStatus: "loaded", page: action.page, queueFailure: null };
      const seen = new Set(state.page.items.map((i) => i.scope_key));
      return {
        ...state,
        queueStatus: "loaded",
        queueFailure: null,
        page: { ...action.page, items: [...state.page.items, ...action.page.items.filter((i) => !seen.has(i.scope_key))] },
      };
    }
    case "queueFailed":
      if (action.request !== state.queueRequest) return state;
      return { ...state, queueStatus: "failed", queueFailure: action.failure };
    case "runLoading":
      return { ...state, run: null, runFailure: null };
    case "runLoaded":
      return { ...state, run: action.run, runFailure: null };
    case "runFailed":
      return { ...state, runFailure: action.failure };
    case "previewReady":
      return { ...state, preview: action.preview, uncertain: false, failure: null, batch: null, result: null };
    case "batchLoaded":
      return { ...state, batch: action.batch, failure: null };
    case "failed":
      return { ...state, failure: action.failure };
    case "applyStarted":
      return { ...state, applying: true, failure: null };
    case "applyRejected":
      return { ...state, applying: false, failure: action.failure };
    case "applyUncertain":
      return { ...state, applying: false, uncertain: true };
    case "applyConfirmed":
      return {
        ...state,
        applying: false,
        uncertain: false,
        failure: null,
        preview: null,
        batch: null,
        result: action.result,
        reloadRun: true,
        reloadQueue: true,
      };
    case "reloadsHandled":
      return { ...state, reloadRun: false, reloadQueue: false };
    case "writesDisabled":
      return state.config ? { ...state, config: { ...state.config, writesEnabled: false } } : state;
    case "disabled":
      return state.config ? { ...state, config: { ...state.config, enabled: false } } : state;
    case "dismiss":
      return { ...state, preview: null, batch: null, failure: null, uncertain: false };
  }
}
