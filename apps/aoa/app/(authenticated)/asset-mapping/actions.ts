"use server";

import { auth } from "@/auth";
import { withUserScope } from "@/lib/rls";
import { assetMappingClientLinkingEnabled, assetMappingDestinationsEnabled, assetMappingDocumentsEnabled, assetMappingEditsEnabled, assetMappingOnDemandImportEnabled, assetMappingReadEnabled } from "@/lib/flags";
import { runAssetMapImport } from "@/lib/data/asset-map-import";
import {
  writeAudit,
  type AuditEntry,
  ASSET_MAP_CLIENT_LINK_APPLY,
  ASSET_MAP_CLIENT_LINK_LOOKUP_RETRY,
  ASSET_MAP_CLIENT_LINK_PREVIEW,
  ASSET_MAP_CLIENT_LINK_REVERT_PREVIEW,
  ASSET_MAP_EDIT_ACCOUNT_DELETE,
  ASSET_MAP_EDIT_ACCOUNT_RESTORE,
  ASSET_MAP_EDIT_ACCOUNT_TYPE,
  ASSET_MAP_EDIT_POSITION_DELETE,
  ASSET_MAP_EDIT_POSITION_RESTORE,
  ASSET_MAP_EDIT_POSITION_STATUS,
  ASSET_MAP_EDIT_POSITION_TRANSFERRING,
  ASSET_MAP_DESTINATION_ADD,
  ASSET_MAP_DESTINATION_DELETE,
  ASSET_MAP_DESTINATION_NEEDS_OPEN,
  ASSET_MAP_DESTINATION_TYPE,
  ASSET_MAP_SOURCE_REASSIGN,
} from "@/lib/audit";
import { canReviewAssetMapLinks, canViewAssetMapping } from "@/lib/data/asset-map-review-authz";
import { ASSET_MAP_WORKSPACE_SCOPE } from "@/lib/data/asset-map-workspace-scope";
import {
  assetMapBaseUrl,
  clientLinkIdempotencyKey,
  fetchAssetMapHouseholdLiveExtras,
  fetchAssetMapScheduleStatus,
  readAssetMapBulkOffset,
  readAssetMapHousehold,
  readAssetMapHouseholdList,
  sendAssetMapClientLink,
  sendAssetMapEdit,
  statusOverrideNote,
  type AssetMapEditRequest,
  type AssetMapHouseholdLiveExtras,
  type AssetMapHouseholdView,
  type AssetMapPositionStatus,
  type AssetMapRunSummary,
  type AssetMapScheduleStatus,
  type AssetMapTransferringValue,
  type ClientLinkFailure,
  type ClientLinkRequest,
} from "@/lib/data/asset-map";
import {
  configFromBody,
  isClientLinkBatchResult,
  isClientLinkConfigBody,
  isClientLinkPage,
  isClientLinkPreview,
  isClientLinkResolution,
  isClientLinkSearchResult,
  isRunClientLink,
  redactRunClientLinkForViewer,
  validateLinkDraft,
  type ClientLinkBatchResult,
  type ClientLinkConfig,
  type ClientLinkDraft,
  type ClientLinkPage,
  type ClientLinkPreview,
  type ClientLinkResolution,
  type ClientLinkReviewState,
  type ClientLinkSearchResult,
  type RunClientLink,
} from "@/lib/data/asset-map-client-link-contract";
import {
  buildDestinationsView,
  fetchAssetMapDestinations,
  readAssetMapDestinationContext,
  readAssetMapSourceFolderId,
  sendAssetMapDestinationWrite,
  type AssetMapDestinationWrite,
  type AssetMapDestinationsView,
} from "@/lib/data/asset-map-destinations";
import { isDestinationType } from "@/components/asset-mapping/workspace/destinations/destination-model";
import { writeThroughAssetMapEdit, type AssetMapConfirmedEdit } from "@/lib/data/asset-map-write-through";
import { readAssetMapDriveSaveAudit } from "@/lib/data/asset-map-documents";
import {
  isAccountTypeOption,
  isPipelineId,
  isPositionStatus,
  isTransferringValue,
  normalizeOther,
  type SavedAccountType,
} from "@/components/asset-mapping/workspace/edits/edit-model";

export type AssetMapReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "not_found" | "unavailable" };

async function gatedIdentity() {
  const session = await auth();
  if (!session?.user) return null;
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!assetMappingReadEnabled() || !canViewAssetMapping(role)) return null;
  return { role, email: session.user.email ?? null };
}

export async function loadAssetMapHouseholdList(): Promise<AssetMapReadResult<AssetMapRunSummary[]>> {
  const identity = await gatedIdentity();
  if (!identity) return { ok: false, reason: "not_found" };
  try {
    return { ok: true, data: await withUserScope(identity, (tx) => readAssetMapHouseholdList(tx), ASSET_MAP_WORKSPACE_SCOPE) };
  } catch {
    console.error("[asset-mapping] list_unavailable");
    return { ok: false, reason: "unavailable" };
  }
}

export async function loadAssetMapHousehold(id: string): Promise<AssetMapReadResult<AssetMapHouseholdView | null>> {
  const identity = await gatedIdentity();
  if (!identity || typeof id !== "string" || id === "") return { ok: false, reason: "not_found" };
  try {
    return { ok: true, data: await withUserScope(identity, (tx) => readAssetMapHousehold(tx, id), ASSET_MAP_WORKSPACE_SCOPE) };
  } catch {
    console.error("[asset-mapping] household_unavailable");
    return { ok: false, reason: "unavailable" };
  }
}

/** Runs the shared import for a finished scan or a confirmed save (ticket); returns once it committed or failed. */
export async function runAssetMapOnDemandImport(): Promise<{ ok: boolean }> {
  if (!assetMappingOnDemandImportEnabled()) return { ok: false };
  const session = await auth();
  if (!session?.user) return { ok: false };
  if (!canReviewAssetMapLinks((session.user as { role?: string }).role ?? "VIEWER")) return { ok: false };
  try {
    return { ok: (await runAssetMapImport({ dryRun: false })).status === 200 };
  } catch {
    console.error("[asset-mapping] on_demand_import_failed");
    return { ok: false };
  }
}

export async function loadAssetMapSchedule(): Promise<AssetMapReadResult<AssetMapScheduleStatus>> {
  const identity = await gatedIdentity();
  if (!identity) return { ok: false, reason: "not_found" };
  const base = assetMapBaseUrl();
  if (!base) return { ok: false, reason: "unavailable" };
  const status = await fetchAssetMapScheduleStatus(base);
  return status ? { ok: true, data: status } : { ok: false, reason: "unavailable" };
}

export async function loadAssetMapHouseholdLiveExtras(id: string): Promise<AssetMapReadResult<AssetMapHouseholdLiveExtras>> {
  const identity = await gatedIdentity();
  if (!identity || typeof id !== "string" || id === "") return { ok: false, reason: "not_found" };
  const base = assetMapBaseUrl();
  if (!base) return { ok: false, reason: "unavailable" };
  try {
    const offset = await withUserScope(identity, (tx) => readAssetMapBulkOffset(tx, id), ASSET_MAP_WORKSPACE_SCOPE);
    if (offset == null) return { ok: false, reason: "not_found" };
    const extras = await fetchAssetMapHouseholdLiveExtras(base, id, offset);
    return extras ? { ok: true, data: extras } : { ok: false, reason: "unavailable" };
  } catch {
    console.error("[asset-mapping] live_extras_unavailable");
    return { ok: false, reason: "unavailable" };
  }
}

export type AssetMapEditResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "rejected" | "unavailable" };

type EditPlan<T> = {
  request: AssetMapEditRequest;
  audit: AuditEntry;
  parse: (body: Record<string, unknown>) => T;
  confirmed: (data: T) => AssetMapConfirmedEdit;
};

async function editIdentity() {
  const session = await auth();
  if (!session?.user) return null;
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!assetMappingEditsEnabled() || !canReviewAssetMapLinks(role)) return null;
  return { role, email: session.user.email ?? null };
}

async function runEdit<T>(build: (identity: { role: string; email: string | null }) => EditPlan<T> | null): Promise<AssetMapEditResult<T>> {
  const identity = await editIdentity();
  if (!identity) return { ok: false, reason: "forbidden" };
  const plan = build(identity);
  if (!plan) return { ok: false, reason: "rejected" };
  const base = assetMapBaseUrl();
  if (!base) return { ok: false, reason: "unavailable" };
  const outcome = await sendAssetMapEdit(base, plan.request);
  if (!outcome.ok) return outcome;
  const data = plan.parse(outcome.body);
  await writeThroughAssetMapEdit(plan.confirmed(data));
  try {
    await withUserScope(identity, (tx) => writeAudit(tx, identity, plan.audit));
  } catch {
    console.error("[asset-mapping] edit_audit_failed");
  }
  return { ok: true, data };
}

const POSITION = "asset_map_position";
const ACCOUNT = "asset_map_account";

export async function saveAssetMapPositionStatus(positionId: string, status: string): Promise<AssetMapEditResult<{ status: AssetMapPositionStatus }>> {
  return runEdit(() => (isPipelineId(positionId) && isPositionStatus(status) ? {
    request: { kind: "positionStatus", positionId, status },
    audit: { action: ASSET_MAP_EDIT_POSITION_STATUS, entityType: POSITION, entityId: positionId, detail: { status } },
    parse: (b) => ({ status: isPositionStatus(b.new_status) ? b.new_status : status }),
    confirmed: (d) => ({ kind: "positionStatus", positionId, status: d.status, notes: statusOverrideNote(d.status) }),
  } : null));
}

export async function saveAssetMapPositionTransferring(positionId: string, value: AssetMapTransferringValue): Promise<AssetMapEditResult<{ value: AssetMapTransferringValue }>> {
  return runEdit(() => (isPipelineId(positionId) && isTransferringValue(value) ? {
    request: { kind: "positionTransferring", positionId, value },
    audit: { action: ASSET_MAP_EDIT_POSITION_TRANSFERRING, entityType: POSITION, entityId: positionId, detail: { value } },
    parse: (b) => ({ value: "transferring" in b && isTransferringValue(b.transferring) ? b.transferring : value }),
    confirmed: (d) => ({ kind: "positionTransferring", positionId, value: d.value }),
  } : null));
}

export async function saveAssetMapAccountType(accountId: string, accountType: string, accountTypeOther: string | null): Promise<AssetMapEditResult<SavedAccountType>> {
  return runEdit((identity) => {
    if (!isPipelineId(accountId) || !isAccountTypeOption(accountType)) return null;
    const other = normalizeOther(accountType, accountTypeOther);
    return {
      request: { kind: "accountType", accountId, accountType, accountTypeOther: other },
      audit: { action: ASSET_MAP_EDIT_ACCOUNT_TYPE, entityType: ACCOUNT, entityId: accountId, detail: { accountType, hasOther: other != null } },
      parse: (b) => ({
        accountType: typeof b.account_type === "string" ? b.account_type : accountType,
        accountTypeOther: typeof b.account_type_other === "string" ? b.account_type_other : other,
        ...(typeof b.is_rollover === "boolean" ? { isRollover: b.is_rollover } : {}),
        ...(typeof b.is_inherited === "boolean" ? { isInherited: b.is_inherited } : {}),
        ...("apex_restriction" in b ? { apexRestriction: typeof b.apex_restriction === "string" ? b.apex_restriction : null } : {}),
        overriddenBy: identity.email,
        overriddenAt: new Date().toISOString(),
      }),
      confirmed: (d) => ({ kind: "accountType", accountId, ...d }),
    };
  });
}

function idOnly(kind: "removePosition" | "restorePosition" | "removeAccount" | "restoreAccount", action: string, entityType: string, id: string): EditPlan<{ id: string }> | null {
  if (!isPipelineId(id)) return null;
  const target = kind === "removePosition" || kind === "restorePosition"
    ? { kind, positionId: id }
    : { kind, accountId: id };
  return {
    request: target as AssetMapEditRequest,
    audit: { action, entityType, entityId: id, detail: {} },
    parse: () => ({ id }),
    confirmed: () => target as AssetMapConfirmedEdit,
  };
}

export async function removeAssetMapPosition(positionId: string) {
  return runEdit(() => idOnly("removePosition", ASSET_MAP_EDIT_POSITION_DELETE, POSITION, positionId));
}
export async function restoreAssetMapPosition(positionId: string) {
  return runEdit(() => idOnly("restorePosition", ASSET_MAP_EDIT_POSITION_RESTORE, POSITION, positionId));
}
export async function removeAssetMapAccount(accountId: string) {
  return runEdit(() => idOnly("removeAccount", ASSET_MAP_EDIT_ACCOUNT_DELETE, ACCOUNT, accountId));
}
export async function restoreAssetMapAccount(accountId: string) {
  return runEdit(() => idOnly("restoreAccount", ASSET_MAP_EDIT_ACCOUNT_RESTORE, ACCOUNT, accountId));
}

export type ClientLinkResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | ClientLinkFailure; message: string | null };

export type ClientLinkQueueFilter = {
  q: string;
  reviewState: ClientLinkReviewState | null;
  cursor: string | null;
  limit: number;
};

/** "view" is the statement-pipeline `view_actor` set (config, queue, run); every
 *  other client-link call is "operate" (`ops_actor` / `write_actor`). */
type ClientLinkAccess = "view" | "operate";

async function clientLinkIdentity(access: ClientLinkAccess) {
  const session = await auth();
  if (!session?.user) return null;
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const permitted = access === "view" ? canViewAssetMapping(role) : canReviewAssetMapLinks(role);
  if (!assetMappingClientLinkingEnabled() || !permitted) return null;
  return { role, email: session.user.email ?? null };
}

type LinkPlan<B, R> = {
  request: ClientLinkRequest;
  guard: (body: unknown) => body is B;
  /** Turns the checked pipeline body into what the action returns. */
  parse: (body: B, identity: { role: string }) => R;
  audit?: (data: R) => AuditEntry;
};

function asIs<T>(body: T): T {
  return body;
}

async function runClientLink<B, R>(access: ClientLinkAccess, build: () => LinkPlan<B, R> | null): Promise<ClientLinkResult<R>> {
  const identity = await clientLinkIdentity(access);
  if (!identity) return { ok: false, reason: "forbidden", message: null };
  const plan = build();
  if (!plan) return { ok: false, reason: "rejected", message: null };
  const base = assetMapBaseUrl();
  if (!base) return { ok: false, reason: "unavailable", message: null };
  const outcome = await sendAssetMapClientLink(base, plan.request);
  if (!outcome.ok) return outcome;
  if (!plan.guard(outcome.body)) {
    console.error("[asset-mapping] client_link_malformed");
    return { ok: false, reason: "unavailable", message: null };
  }
  const data = plan.parse(outcome.body, identity);
  if (plan.audit) {
    try {
      await withUserScope(identity, (tx) => writeAudit(tx, identity, plan.audit!(data)));
    } catch {
      console.error("[asset-mapping] client_link_audit_failed");
    }
  }
  return { ok: true, data };
}

const REVIEW_STATES: readonly ClientLinkReviewState[] = ["unresolved", "partial", "complete", "conflict"];
const PREVIEW = "asset_map_client_link_preview";

function validQueueFilter(f: ClientLinkQueueFilter): boolean {
  return (
    f != null &&
    typeof f.q === "string" && f.q.length <= 200 &&
    (f.reviewState === null || REVIEW_STATES.includes(f.reviewState)) &&
    (f.cursor === null || (typeof f.cursor === "string" && f.cursor.length <= 512)) &&
    Number.isInteger(f.limit) && f.limit >= 1 && f.limit <= 100
  );
}

function count(list: unknown): number {
  return Array.isArray(list) ? list.length : 0;
}

export async function loadClientLinkConfig(): Promise<ClientLinkResult<ClientLinkConfig>> {
  return runClientLink("view", () => ({
    request: { kind: "config" },
    guard: isClientLinkConfigBody,
    parse: configFromBody,
  }));
}

export async function loadClientLinkQueue(filter: ClientLinkQueueFilter): Promise<ClientLinkResult<ClientLinkPage>> {
  return runClientLink("view", () => (validQueueFilter(filter)
    ? { request: { kind: "queue", ...filter }, guard: isClientLinkPage, parse: asIs<ClientLinkPage> }
    : null));
}

export async function loadRunClientLink(runId: string): Promise<ClientLinkResult<RunClientLink>> {
  return runClientLink("view", () => (isPipelineId(runId)
    ? {
        request: { kind: "run", runId },
        guard: isRunClientLink,
        parse: (run, identity) => (canReviewAssetMapLinks(identity.role) ? run : redactRunClientLinkForViewer(run)),
      }
    : null));
}

export async function searchClientDirectory(q: string): Promise<ClientLinkResult<ClientLinkSearchResult>> {
  return runClientLink("operate", () => {
    const trimmed = typeof q === "string" ? q.trim() : "";
    if (trimmed.length < 2 || trimmed.length > 200) return null;
    return { request: { kind: "search", q: trimmed }, guard: isClientLinkSearchResult, parse: asIs<ClientLinkSearchResult> };
  });
}

export async function previewClientLink(draft: ClientLinkDraft): Promise<ClientLinkResult<ClientLinkPreview>> {
  return runClientLink("operate", () => (validateLinkDraft(draft)
    ? {
        request: { kind: "preview", draft },
        guard: isClientLinkPreview,
        parse: asIs<ClientLinkPreview>,
        audit: (p) => ({
          action: ASSET_MAP_CLIENT_LINK_PREVIEW,
          entityType: PREVIEW,
          entityId: p.preview_id,
          detail: { kind: p.kind, targets: count(p.targets), exclusions: count(p.exclusions), folders: count(draft.folder_targets) },
        }),
      }
    : null));
}

export async function applyClientLink(previewId: string, payloadHash: string, acknowledged: boolean): Promise<ClientLinkResult<ClientLinkBatchResult>> {
  return runClientLink("operate", () => (isPipelineId(previewId) && typeof payloadHash === "string" && payloadHash !== "" && acknowledged === true
    ? {
        request: { kind: "apply", previewId, payloadHash, idempotencyKey: clientLinkIdempotencyKey(previewId, payloadHash) },
        guard: isClientLinkBatchResult,
        parse: asIs<ClientLinkBatchResult>,
        audit: (b) => ({
          action: ASSET_MAP_CLIENT_LINK_APPLY,
          entityType: "asset_map_client_link_batch",
          entityId: b.batch_id,
          detail: { kind: b.kind, applied: b.applied, unchanged: b.unchanged, excluded: b.excluded },
        }),
      }
    : null));
}

export async function retryClientLinkLookup(runId: string): Promise<ClientLinkResult<ClientLinkResolution>> {
  return runClientLink("operate", () => (isPipelineId(runId)
    ? {
        request: { kind: "retry", runId },
        guard: isClientLinkResolution,
        parse: asIs<ClientLinkResolution>,
        audit: (r) => ({
          action: ASSET_MAP_CLIENT_LINK_LOOKUP_RETRY,
          entityType: "asset_map_household",
          entityId: runId,
          detail: { accepted: r.accepted },
        }),
      }
    : null));
}

export async function loadClientLinkBatch(batchId: string): Promise<ClientLinkResult<ClientLinkBatchResult>> {
  return runClientLink("operate", () => (isPipelineId(batchId)
    ? { request: { kind: "batch", batchId }, guard: isClientLinkBatchResult, parse: asIs<ClientLinkBatchResult> }
    : null));
}

export async function previewClientLinkRevert(batchId: string): Promise<ClientLinkResult<ClientLinkPreview>> {
  return runClientLink("operate", () => (isPipelineId(batchId)
    ? {
        request: { kind: "revertPreview", batchId },
        guard: isClientLinkPreview,
        parse: asIs<ClientLinkPreview>,
        audit: (p) => ({
          action: ASSET_MAP_CLIENT_LINK_REVERT_PREVIEW,
          entityType: PREVIEW,
          entityId: p.preview_id,
          detail: { revertsBatchId: batchId, targets: count(p.targets) },
        }),
      }
    : null));
}

// --- ticket destinations. Read live from the pipeline (no mirror); writes go to
// the pipeline's four destination routes, then one audit row under the operator.

async function destinationIdentity() {
  const session = await auth();
  if (!session?.user) return null;
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!assetMappingDestinationsEnabled() || !canReviewAssetMapLinks(role)) return null;
  return { role, email: session.user.email ?? null };
}

export async function loadAssetMapDestinations(householdId: string): Promise<AssetMapReadResult<AssetMapDestinationsView>> {
  const identity = await destinationIdentity();
  if (!identity || typeof householdId !== "string" || householdId === "") return { ok: false, reason: "not_found" };
  const base = assetMapBaseUrl();
  if (!base) return { ok: false, reason: "unavailable" };
  try {
    const context = await withUserScope(identity, (tx) => readAssetMapDestinationContext(tx, householdId));
    if (context == null) return { ok: false, reason: "not_found" };
    const raw = await fetchAssetMapDestinations(base, context.sourceFolderId);
    return raw ? { ok: true, data: buildDestinationsView(raw, context) } : { ok: false, reason: "unavailable" };
  } catch {
    console.error("[asset-mapping] destinations_unavailable");
    return { ok: false, reason: "unavailable" };
  }
}

type DestinationPlan<T> = {
  request: AssetMapDestinationWrite | { householdId: string; withFolder: (sourceFolderId: string) => AssetMapDestinationWrite };
  audit: (data: T) => AuditEntry;
  parse: (body: Record<string, unknown>) => T;
};

async function runDestinationWrite<T>(build: () => DestinationPlan<T> | null): Promise<AssetMapEditResult<T>> {
  const identity = await destinationIdentity();
  if (!identity) return { ok: false, reason: "forbidden" };
  const plan = build();
  if (!plan) return { ok: false, reason: "rejected" };
  const base = assetMapBaseUrl();
  if (!base) return { ok: false, reason: "unavailable" };
  let request: AssetMapDestinationWrite;
  if ("withFolder" in plan.request) {
    const { householdId, withFolder } = plan.request;
    let folder: string | null;
    try {
      folder = await withUserScope(identity, (tx) => readAssetMapSourceFolderId(tx, householdId));
    } catch {
      console.error("[asset-mapping] destination_folder_unavailable");
      return { ok: false, reason: "unavailable" };
    }
    if (folder == null) return { ok: false, reason: "rejected" };
    request = withFolder(folder);
  } else {
    request = plan.request;
  }
  const outcome = await sendAssetMapDestinationWrite(base, request);
  if (!outcome.ok) return outcome;
  const data = plan.parse(outcome.body);
  try {
    await withUserScope(identity, (tx) => writeAudit(tx, identity, plan.audit(data)));
  } catch {
    console.error("[asset-mapping] destination_audit_failed");
  }
  return { ok: true, data };
}

const DESTINATION = "asset_map_destination";
const SOURCE_LINK = "asset_map_source_link";

/** Trimmed owner; empty → null; a non-string → undefined (invalid). */
function ownerInput(owner: unknown): string | null | undefined {
  if (owner == null) return null;
  if (typeof owner !== "string") return undefined;
  const trimmed = owner.trim();
  return trimmed === "" ? null : trimmed;
}

export async function addAssetMapDestination(
  householdId: string,
  owner: string | null,
  targetAccountType: string,
): Promise<AssetMapEditResult<{ id: string | null; owner: string | null; targetAccountType: string }>> {
  return runDestinationWrite(() => {
    const o = ownerInput(owner);
    if (!isPipelineId(householdId) || o === undefined || !isDestinationType(targetAccountType)) return null;
    return {
      request: { householdId, withFolder: (sourceFolderId) => ({ kind: "add", sourceFolderId, owner: o, targetAccountType }) },
      audit: (d) => ({ action: ASSET_MAP_DESTINATION_ADD, entityType: DESTINATION, entityId: d.id, detail: { targetAccountType } }),
      parse: (b) => ({ id: isPipelineId(b.id) ? b.id : null, owner: o, targetAccountType }),
    };
  });
}

export async function setAssetMapDestinationNeedsOpen(targetId: string, needsToBeOpened: boolean): Promise<AssetMapEditResult<{ needsToBeOpened: boolean }>> {
  return runDestinationWrite(() => (isPipelineId(targetId) && typeof needsToBeOpened === "boolean" ? {
    request: { kind: "needsOpen", targetId, needsToBeOpened },
    audit: () => ({ action: ASSET_MAP_DESTINATION_NEEDS_OPEN, entityType: DESTINATION, entityId: targetId, detail: { needsToBeOpened } }),
    parse: () => ({ needsToBeOpened }),
  } : null));
}

export async function setAssetMapDestinationType(targetId: string, targetAccountType: string): Promise<AssetMapEditResult<{ targetAccountType: string }>> {
  return runDestinationWrite(() => (isPipelineId(targetId) && isDestinationType(targetAccountType) ? {
    request: { kind: "type", targetId, targetAccountType },
    audit: () => ({ action: ASSET_MAP_DESTINATION_TYPE, entityType: DESTINATION, entityId: targetId, detail: { targetAccountType } }),
    parse: () => ({ targetAccountType }),
  } : null));
}

export async function removeAssetMapDestination(targetId: string): Promise<AssetMapEditResult<{ id: string }>> {
  return runDestinationWrite(() => (isPipelineId(targetId) ? {
    request: { kind: "remove", targetId },
    audit: () => ({ action: ASSET_MAP_DESTINATION_DELETE, entityType: DESTINATION, entityId: targetId, detail: {} }),
    parse: () => ({ id: targetId }),
  } : null));
}

export type AssetMapSourceTarget = { targetAccountId: string } | { newOwner: string | null };

export async function reassignAssetMapSource(
  householdId: string,
  linkId: string,
  target: AssetMapSourceTarget,
): Promise<AssetMapEditResult<{ linkId: string; targetAccountId: string | null }>> {
  return runDestinationWrite(() => {
    if (!isPipelineId(linkId) || typeof target !== "object" || target === null) return null;
    const audit = (newDestination: boolean) => (d: { targetAccountId: string | null }): AuditEntry => ({
      action: ASSET_MAP_SOURCE_REASSIGN, entityType: SOURCE_LINK, entityId: linkId, detail: { targetAccountId: d.targetAccountId, newDestination },
    });
    if ("targetAccountId" in target) {
      const targetAccountId = target.targetAccountId;
      if (!isPipelineId(targetAccountId)) return null;
      return {
        request: { kind: "reassign", linkId, targetAccountId },
        audit: audit(false),
        parse: (b) => ({ linkId, targetAccountId: isPipelineId(b.target_account_id) ? b.target_account_id : targetAccountId }),
      };
    }
    const newOwner = ownerInput(target.newOwner);
    if (!isPipelineId(householdId) || newOwner === undefined) return null;
    return {
      request: { householdId, withFolder: (sourceFolderId) => ({ kind: "reassignNew", linkId, sourceFolderId, newOwner }) },
      audit: audit(true),
      parse: (b) => ({ linkId, targetAccountId: isPipelineId(b.target_account_id) ? b.target_account_id : null }),
    };
  });
}

/** The latest AoA Drive-save audit row for one household. The
 *  audit table's read policy is Admin and Operations only, enforced here. */
export async function loadAssetMapDriveSaveReviewer(householdId: string): Promise<{ reviewedAt: string; reviewer: string } | null> {
  const session = await auth();
  if (!session?.user || !assetMappingDocumentsEnabled()) return null;
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!canReviewAssetMapLinks(role) || !isPipelineId(householdId)) return null;
  const identity = { role, email: session.user.email ?? null };
  try {
    return await withUserScope(identity, (tx) => readAssetMapDriveSaveAudit(tx, householdId));
  } catch {
    console.error("[asset-mapping] documents_reviewer_unavailable");
    return null;
  }
}
