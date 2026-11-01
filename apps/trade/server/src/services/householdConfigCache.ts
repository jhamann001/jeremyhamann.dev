import { loadMeridianActiveAccounts, toHouseholdConfig } from './meridianActiveAccounts.js';
import type { HouseholdConfig } from './householdConfig.js';
import logger from '../lib/logger.js';

/**
 * 30-minute cache over `loadMeridianActiveAccounts() → toHouseholdConfig`,
 * mirroring the `getCachedClients()` pattern in `warehouse.ts:480-506`.
 *
 * Why a separate cache from `getCachedClients()`:
 *   - Source: Meridian GCS export, not Warehouse
 *   - Cadence: the runtime route caller (`POST /api/households/resolve` —
 *     advisor-facing, request hot path) reads on a different schedule than
 *     the nightly drift runner, which calls `loadMeridianActiveAccounts()`
 *     directly without a cache. Two callers, separate state, no race.
 *
 * On loader failure: if a prior good config exists, log + return stale +
 * extend expiry by `STALE_GRACE_MS` so the next request retries promptly.
 * If no prior config exists, the failure rethrows to the caller — the route
 * catches `ActiveAccountsLoadError` and degrades to silent-fallback (503).
 *
 * See `docs/plans/2026-q2-trade-request-householding.md` §6 Step 1.
 */

const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_GRACE_MS = 5 * 60 * 1000;

let cached: HouseholdConfig | null = null;
let cacheExpiry = 0;
let inflightRefresh: Promise<HouseholdConfig> | null = null;

export async function loadHouseholdConfigCached(): Promise<HouseholdConfig> {
  if (cached && Date.now() < cacheExpiry) return cached;
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = loadMeridianActiveAccounts()
    .then(toHouseholdConfig)
    .then((cfg) => {
      cached = cfg;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
      return cfg;
    })
    .catch((err) => {
      logger.error({ err }, 'householdConfig refresh failed');
      if (cached) {
        cacheExpiry = Date.now() + STALE_GRACE_MS;
        return cached;
      }
      throw err;
    })
    .finally(() => {
      inflightRefresh = null;
    });

  return inflightRefresh;
}

/**
 * Test-only: wipes the module-level cache so each test starts cleanly.
 * Mirrors `_setStorageFactoryForTests` in `meridianActiveAccounts.ts`.
 */
export function _resetHouseholdConfigCacheForTests(): void {
  cached = null;
  cacheExpiry = 0;
  inflightRefresh = null;
}
