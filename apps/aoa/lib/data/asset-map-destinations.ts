import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import type { Prisma } from "@prisma/client";

// Live destinations on the statement-pipeline (the system of record). Destinations are
// NOT mirrored: they are read through the service-account-only read route and
// written through the four destination routes. Logs carry static markers only —
// never the url, token, body, folder id, owner, or an account number.
const LOG_TAG = "asset-map";
const DESTINATION_TIMEOUT_MS = 15_000;
const auth = new ServiceAuth();

type RawObj = Record<string, unknown>;
const isObj = (v: unknown): v is RawObj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export type AssetMapDestinationSource = {
  linkId: string;
  custodian: string | null;
  accountNumberMasked: string | null; // the pipeline's mask, as household detail shows it
  accountId: string | null; // the live mirror account with the same custodian and mask
};
export type AssetMapDestination = {
  id: string;
  owner: string | null;
  targetAccountType: string | null;
  existingApexNumber: string | null;
  needsToBeOpened: boolean;
  existingCount: number;
  suggestedApexNumber: string | null;
  sources: AssetMapDestinationSource[];
};
export type AssetMapDestinationsView = {
  destinations: AssetMapDestination[];
  accountNumbers: Record<string, string | null>; // mirror account id → pipeline mask
  overriddenPositionIds: string[];
};
export type AssetMapDestinationContext = {
  sourceFolderId: string;
  accounts: { id: string; custodian: string | null; accountNumberMasked: string | null }[];
  overriddenPositionIds: string[];
};
type RawDestination = Omit<AssetMapDestination, "sources"> & {
  sources: Omit<AssetMapDestinationSource, "accountId">[];
};

/** Exact port of statement-pipeline db.py `_mask_account_number`. */
export function maskLikePipeline(n: string | null): string | null {
  if (!n) return n;
  let count = 0;
  let start = n.length;
  for (let i = n.length - 1; i >= 0; i--) {
    if (n[i] !== "-") count++;
    if (count === 4) {
      start = i;
      break;
    }
  }
  if (start === 0) return n;
  return "\u2022".repeat(start) + n.slice(start);
}

export async function readAssetMapSourceFolderId(tx: Prisma.TransactionClient, householdId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ source_folder_id: string | null }[]>`
    SELECT source_folder_id FROM mirror.acat_asset_map_household WHERE id = ${householdId}`;
  const folder = rows[0]?.source_folder_id;
  return typeof folder === "string" && folder !== "" ? folder : null;
}

export async function readAssetMapDestinationContext(
  tx: Prisma.TransactionClient,
  householdId: string,
): Promise<AssetMapDestinationContext | null> {
  const sourceFolderId = await readAssetMapSourceFolderId(tx, householdId);
  if (sourceFolderId == null) return null;
  const accounts = await tx.$queryRaw<{ id: string; custodian: string | null; account_number: string | null }[]>`
    SELECT id, custodian, account_number
    FROM mirror.acat_asset_map_account
    WHERE household_id = ${householdId} AND is_deleted IS NOT TRUE`;
  const ids = accounts.map((a) => a.id);
  const overridden = ids.length === 0
    ? []
    : await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM mirror.acat_asset_map_position
        WHERE account_id = ANY(${ids}) AND is_deleted IS NOT TRUE
          AND override_status IS NOT NULL AND override_status <> ''`;
  return {
    sourceFolderId,
    accounts: accounts.map((a) => ({ id: a.id, custodian: a.custodian, accountNumberMasked: maskLikePipeline(a.account_number) })),
    overriddenPositionIds: overridden.map((p) => p.id),
  };
}

function parseDestination(raw: unknown): RawDestination | null {
  if (!isObj(raw) || typeof raw.id !== "string") return null;
  const suggestion = isObj(raw.suggestion) ? raw.suggestion : {};
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  return {
    id: raw.id,
    owner: str(raw.owner),
    targetAccountType: str(raw.target_account_type),
    existingApexNumber: str(raw.existing_apex_number),
    needsToBeOpened: raw.needs_to_be_opened === true,
    existingCount: typeof suggestion.existing_count === "number" ? suggestion.existing_count : 0,
    suggestedApexNumber: str(suggestion.suggested_apex_number),
    sources: sources
      .filter((s): s is RawObj => isObj(s) && typeof s.link_id === "string")
      .map((s) => ({ linkId: s.link_id as string, custodian: str(s.custodian), accountNumberMasked: str(s.account_number) })),
  };
}

/** GET the new read route. 200 with a well-formed list → the list; anything else → null. */
export async function fetchAssetMapDestinations(baseUrl: string, sourceFolderId: string): Promise<RawDestination[] | null> {
  let res;
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    res = await client.request({
      url: `${baseUrl}/api/v1/clients/${encodeURIComponent(sourceFolderId)}/destinations`,
      method: "GET",
      timeout: DESTINATION_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch {
    console.error(`[${LOG_TAG}] destinations_transport_failed`);
    return null;
  }
  if (res.status !== 200) {
    console.error(`[${LOG_TAG}] destinations_status=${res.status}`);
    return null;
  }
  const list = isObj(res.data) && Array.isArray(res.data.destinations) ? res.data.destinations.map(parseDestination) : null;
  if (list == null || list.some((d) => d == null)) {
    console.error(`[${LOG_TAG}] destinations_malformed`);
    return null;
  }
  return list as RawDestination[];
}

export function buildDestinationsView(raw: RawDestination[], context: AssetMapDestinationContext): AssetMapDestinationsView {
  const byKey = new Map<string, string>();
  for (const a of context.accounts) {
    const key = `${a.custodian ?? ""}|${a.accountNumberMasked ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, a.id);
  }
  return {
    destinations: raw.map((d) => ({
      ...d,
      sources: d.sources.map((s) => ({ ...s, accountId: byKey.get(`${s.custodian ?? ""}|${s.accountNumberMasked ?? ""}`) ?? null })),
    })),
    accountNumbers: Object.fromEntries(context.accounts.map((a) => [a.id, a.accountNumberMasked])),
    overriddenPositionIds: context.overriddenPositionIds,
  };
}

export type AssetMapDestinationWrite =
  | { kind: "add"; sourceFolderId: string; owner: string | null; targetAccountType: string }
  | { kind: "needsOpen"; targetId: string; needsToBeOpened: boolean }
  | { kind: "type"; targetId: string; targetAccountType: string }
  | { kind: "remove"; targetId: string }
  | { kind: "reassign"; linkId: string; targetAccountId: string }
  | { kind: "reassignNew"; linkId: string; sourceFolderId: string; newOwner: string | null };

export type AssetMapDestinationOutcome =
  | { ok: true; body: RawObj }
  | { ok: false; reason: "rejected" | "unavailable" };

const NEW_ACCOUNT_TYPE = "Individual";

function writeRoute(req: AssetMapDestinationWrite): { method: "POST" | "PATCH" | "DELETE"; path: string; data?: RawObj } {
  switch (req.kind) {
    case "add":
      return { method: "POST", path: `/api/clients/${encodeURIComponent(req.sourceFolderId)}/destinations`, data: { owner: req.owner, target_account_type: req.targetAccountType } };
    case "needsOpen":
      return { method: "PATCH", path: `/api/destinations/${encodeURIComponent(req.targetId)}`, data: { needs_to_be_opened: req.needsToBeOpened } };
    case "type":
      return { method: "PATCH", path: `/api/destinations/${encodeURIComponent(req.targetId)}`, data: { target_account_type: req.targetAccountType } };
    case "remove":
      return { method: "DELETE", path: `/api/destinations/${encodeURIComponent(req.targetId)}` };
    case "reassign":
      return { method: "POST", path: "/api/source-accounts/reassign", data: { link_id: req.linkId, target_account_id: req.targetAccountId } };
    case "reassignNew":
      return {
        method: "POST",
        path: "/api/source-accounts/reassign",
        data: { link_id: req.linkId, source_folder_id: req.sourceFolderId, new_owner: req.newOwner, new_target_account_type: NEW_ACCOUNT_TYPE },
      };
  }
}

/** 2xx → the response body; 5xx, timeout, or transport failure → unavailable;
 *  any other status → rejected. */
export async function sendAssetMapDestinationWrite(baseUrl: string, req: AssetMapDestinationWrite): Promise<AssetMapDestinationOutcome> {
  const { method, path, data } = writeRoute(req);
  let res;
  try {
    const client = await auth.getIdTokenClient(baseUrl);
    res = await client.request({ url: `${baseUrl}${path}`, method, data, timeout: DESTINATION_TIMEOUT_MS, validateStatus: () => true });
  } catch {
    console.error(`[${LOG_TAG}] destination_write_transport_failed`);
    return { ok: false, reason: "unavailable" };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, body: isObj(res.data) ? res.data : {} };
  }
  console.error(`[${LOG_TAG}] destination_write_status=${res.status}`);
  return { ok: false, reason: res.status >= 500 ? "unavailable" : "rejected" };
}
