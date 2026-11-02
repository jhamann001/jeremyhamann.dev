import { z } from "zod";
import { resolveHouseholdsForClients } from "./household-resolution";
import { nativeRoutes, ok, queryOf, route } from "./http";
import {
  ActiveAccountsLoadError, getCachedClients, loadMeridianActiveAccounts, localFeedFallbackAllowed, logFeedUnconfigured,
  toHouseholdConfig, tradeRequestWarehouseConfigured, type HouseholdConfig,
} from "./sources";

// trade-request d41b6c9 server/src/routes/households.ts:27-131 and
// server/src/services/householdConfigCache.ts:24-55 (30-minute cache, stale on refresh failure).

const ULID_RE = /^[0-9A-Z]{26}$/;
const MAX_LIST_ENTRIES = 50;
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_GRACE_MS = 5 * 60 * 1000;

let cached: HouseholdConfig | null = null;
let cacheExpiry = 0;
let inflight: Promise<HouseholdConfig> | null = null;

export async function loadHouseholdConfigCached(): Promise<HouseholdConfig> {
  if (cached && Date.now() < cacheExpiry) return cached;
  if (inflight) return inflight;
  inflight = loadMeridianActiveAccounts()
    .then(toHouseholdConfig)
    .then((config) => {
      cached = config;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
      return config;
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: "trade_request_household_config_refresh_failed" }));
      if (cached) {
        cacheExpiry = Date.now() + STALE_GRACE_MS;
        return cached;
      }
      throw error;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Tests only. */
export function resetHouseholdConfigCache(): void {
  cached = null;
  cacheExpiry = 0;
  inflight = null;
}

function parseIdsList(raw: unknown, validator: (s: string) => boolean): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "string") {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message: "must be a comma-separated string" }]);
  }
  if (raw === "") return [];
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length > MAX_LIST_ENTRIES) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.too_big, path: [], maximum: MAX_LIST_ENTRIES, origin: "array", inclusive: true, exact: false,
      message: `list exceeds maximum of ${MAX_LIST_ENTRIES}`,
    }]);
  }
  for (const p of parts) {
    if (!validator(p)) throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message: `invalid entry: "${p}"` }]);
  }
  return parts;
}

const isNonEmptyString = (s: string): boolean => s.length > 0 && s.length <= 100;
const isUlid = (s: string): boolean => ULID_RE.test(s);

export const householdResolveHandler = nativeRoutes(route("GET", "/households/resolve", async (_params, call) => {
  const query = queryOf(call);
  const clientIds = parseIdsList(query.clientIds, isNonEmptyString);
  const accountIds = parseIdsList(query.accountIds, isUlid);
  if (!tradeRequestWarehouseConfigured()) {
    if (localFeedFallbackAllowed()) return ok({ data: { households: [], unresolvedClientIds: clientIds, unresolvedAccountIds: accountIds } });
    logFeedUnconfigured("householdResolve");
    return { status: 503, body: { error: "household_data_unavailable" } };
  }
  let householdConfig: HouseholdConfig;
  try {
    householdConfig = await loadHouseholdConfigCached();
  } catch (error) {
    if (error instanceof ActiveAccountsLoadError) return { status: 503, body: { error: "household_data_unavailable" } };
    throw error;
  }
  const clients = await getCachedClients();
  return ok({ data: resolveHouseholdsForClients({ clientIds, accountIds, clients, householdConfig }) });
}));
