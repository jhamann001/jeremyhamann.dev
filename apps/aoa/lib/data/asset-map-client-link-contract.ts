// Wire shapes of the statement-pipeline's client-link bodies (client_linking/contracts.py),
// snake_case as sent. Pure: shared by the server actions and the client UI model.
import { isPipelineId } from "@/components/asset-mapping/workspace/edits/edit-model";

export type ClientLinkReviewState = "unresolved" | "partial" | "complete" | "conflict";
export type ClientLinkLookupState = "not_attempted" | "pending" | "ready" | "unavailable" | "stale";
export type ClientLinkCoverage = "partial" | "complete";

export type ClientLinkPerson = { user_id: string; display_name: string };

export type ClientLinkCandidate = ClientLinkPerson & {
  match_kind: "exact" | "normalized" | "alias" | "partial";
  evidence: string[];
  eligible: boolean;
};

export type ClientLinkSourceScope = { source_system: "google_drive"; source_folder_id: string };

export type ClientLinkFolderTarget = { source_scope: ClientLinkSourceScope; expected_revision: number };

export type ClientLinkIdentity = {
  decision_id: string | null;
  people: ClientLinkPerson[];
  coverage: ClientLinkCoverage;
  primary_user_id: string | null;
  cedar_ridge_user_id: string | null;
  review_state: ClientLinkReviewState;
  method: "manual" | "inherited" | "backfill" | "revert" | null;
  conflict_flags: string[];
};

export type ClientLinkDirectory = {
  freshness: "fresh" | "stale" | "unknown";
  complete: boolean;
  eligibility_verified: boolean;
  fetched_at: string;
  source_as_of: string | null;
};

export type ClientLinkSuggestion = {
  kind: "exact" | "ambiguous" | "none";
  candidates: ClientLinkCandidate[];
  evidence: string[];
  conflict_flags: string[];
};

export type ClientLinkLookup = {
  state: ClientLinkLookupState;
  suggestion: ClientLinkSuggestion | null;
  directory: ClientLinkDirectory | null;
  error_code: string | null;
  message: string | null;
};

export type ClientLinkFolder = {
  source_scope: ClientLinkSourceScope;
  revision: number;
  decision: ClientLinkIdentity;
  reuse_future: boolean;
};

export type ClientLinkEvent = {
  event_id: string;
  batch_id: string | null;
  kind: string;
  actor: string;
  occurred_at: string;
  reason: string | null;
};

export type ClientLinkDraft = {
  action: "confirm" | "unlink" | "backfill";
  run_id?: string | null;
  target_scope: "this_run" | "all_existing" | "bulk";
  expected_identity_version?: number | null;
  expected_folder_revision?: number | null;
  folder_targets?: ClientLinkFolderTarget[];
  people_ids?: string[];
  coverage?: ClientLinkCoverage;
  primary_user_id?: string | null;
  reuse_future?: boolean;
  reason?: string;
};

export type ClientLinkQueueItem = {
  scope_key: string;
  source_scope: ClientLinkSourceScope | null;
  representative_run_id: string;
  client_name: string;
  run_count: number;
  unlinked_run_count: number;
  folder: ClientLinkFolder | null;
  review_state: ClientLinkReviewState;
  lookup_state: ClientLinkLookupState;
  bulk_eligible: boolean;
  exceptions: string[];
};

export type ClientLinkPage = { items: ClientLinkQueueItem[]; total: number; next_cursor: string | null };

export type RunClientLink = {
  run_id: string;
  identity: ClientLinkIdentity;
  lookup: ClientLinkLookup;
  holder_evidence: string[];
  folder: ClientLinkFolder | null;
  events: ClientLinkEvent[];
  identity_version: number;
  source_scope: ClientLinkSourceScope | null;
};

export type ClientLinkPreviewTarget = {
  run_id: string;
  client_name: string;
  run_number: number;
  is_historical: boolean;
  before: ClientLinkIdentity;
  after: ClientLinkIdentity;
};

export type ClientLinkFolderChange = {
  source_scope: ClientLinkSourceScope;
  expected_revision: number;
  before: ClientLinkFolder;
  after: ClientLinkFolder;
};

export type ClientLinkExclusion = { run_id: string | null; scope_key: string | null; reason: string };

export type ClientLinkPreview = {
  preview_id: string;
  kind: "confirm" | "unlink" | "backfill" | "revert";
  payload_hash: string;
  expires_at: string;
  acknowledgement: string;
  targets: ClientLinkPreviewTarget[];
  exclusions: ClientLinkExclusion[];
  folder_changes?: ClientLinkFolderChange[];
  directory?: ClientLinkDirectory | null;
  reverts_batch_id?: string | null;
};

export type ClientLinkBatchResult = {
  batch_id: string;
  applied: number;
  unchanged: number;
  excluded: number;
  kind: ClientLinkPreview["kind"];
  applied_at?: string;
  actor?: string;
  preview?: ClientLinkPreview;
};

export type ClientLinkSearchResult = {
  candidates: ClientLinkCandidate[];
  directory: ClientLinkDirectory | null;
  lookup_state: ClientLinkLookupState;
  message: string | null;
};

export type ClientLinkResolution = { run: RunClientLink; accepted: boolean };

export type ClientLinkConfig = { enabled: boolean; writesEnabled: boolean };

export const MAX_LINK_PEOPLE = 20;
export const MAX_BACKFILL_FOLDERS = 100;
export const MAX_LINK_REASON = 2000;
export const MIN_DIRECTORY_QUERY = 2;
export const CLIENT_LINK_STALE_CODES = ["preview_stale", "preview_expired", "idempotency_conflict"] as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function isClientLinkPage(body: unknown): body is ClientLinkPage {
  return isObj(body) && Array.isArray(body.items) && typeof body.total === "number";
}

export function isRunClientLink(body: unknown): body is RunClientLink {
  return isObj(body) && typeof body.run_id === "string" && isObj(body.identity);
}

/** The run as statement-pipeline `_advisor_run` (client_linking/router.py) shows it
 *  to a read-only role: no events, holder evidence, suggestion or directory. */
export function redactRunClientLinkForViewer(run: RunClientLink): RunClientLink {
  return {
    ...run,
    events: [],
    holder_evidence: [],
    lookup: isObj(run.lookup) ? { ...run.lookup, suggestion: null, directory: null } : run.lookup,
  };
}

export function isClientLinkPreview(body: unknown): body is ClientLinkPreview {
  return (
    isObj(body) &&
    typeof body.preview_id === "string" &&
    typeof body.payload_hash === "string" &&
    typeof body.expires_at === "string" &&
    Array.isArray(body.targets)
  );
}

export function isClientLinkBatchResult(body: unknown): body is ClientLinkBatchResult {
  return (
    isObj(body) &&
    typeof body.batch_id === "string" &&
    typeof body.applied === "number" &&
    typeof body.unchanged === "number" &&
    typeof body.excluded === "number"
  );
}

export function isClientLinkSearchResult(body: unknown): body is ClientLinkSearchResult {
  return isObj(body) && Array.isArray(body.candidates);
}

export function isClientLinkResolution(body: unknown): body is ClientLinkResolution {
  return isObj(body) && isObj(body.run) && typeof body.accepted === "boolean";
}

export function isClientLinkConfigBody(body: unknown): body is Obj {
  return isObj(body);
}

export function configFromBody(body: Obj): ClientLinkConfig {
  return {
    enabled: body.client_linking_enabled === true,
    writesEnabled: body.client_linking_writes_enabled === true,
  };
}

function validFolderTarget(v: unknown): boolean {
  if (!isObj(v) || !isObj(v.source_scope)) return false;
  const folderId = v.source_scope.source_folder_id;
  return typeof folderId === "string" && folderId !== "" && isNonNegativeInt(v.expected_revision);
}

/** The pipeline's LinkDraft rules, checked before a draft leaves AoA. */
export function validateLinkDraft(draft: unknown): draft is ClientLinkDraft {
  if (!isObj(draft)) return false;
  const { action, run_id, target_scope, expected_identity_version, folder_targets, people_ids, primary_user_id, reason, reuse_future } = draft;
  if (action !== "confirm" && action !== "unlink" && action !== "backfill") return false;
  const people = people_ids ?? [];
  if (!Array.isArray(people) || people.length > MAX_LINK_PEOPLE) return false;
  if (!people.every((p) => typeof p === "string") || new Set(people).size !== people.length) return false;
  if (primary_user_id != null && (typeof primary_user_id !== "string" || !people.includes(primary_user_id))) return false;
  if (reason != null && (typeof reason !== "string" || reason.length > MAX_LINK_REASON)) return false;
  const targets = folder_targets ?? [];
  if (!Array.isArray(targets)) return false;
  if (action === "backfill") {
    return (
      target_scope === "bulk" &&
      targets.length >= 1 &&
      targets.length <= MAX_BACKFILL_FOLDERS &&
      targets.every(validFolderTarget) &&
      people.length === 0 &&
      run_id == null &&
      primary_user_id == null
    );
  }
  if (!isPipelineId(run_id) || (target_scope !== "this_run" && target_scope !== "all_existing")) return false;
  if (!isNonNegativeInt(expected_identity_version) || targets.length > 0) return false;
  if (action === "confirm") return people.length >= 1;
  return people.length === 0 && primary_user_id == null && reuse_future !== true;
}
