// The ported standalone feeds (ticket) the native client list, household
// resolution, exclusion export and Client Portrait read use. The only module in
// native/reads that imports lib/trade-requests/sources.
import { tradeRequestsLocalSourcesEnabled } from "@/lib/flags";

export {
  getCachedClients,
  getMachineAccountIdMap,
  machineAccountIdentityConfigured,
  tradeRequestWarehouseConfigured,
  type SourceClient,
} from "../../sources/warehouse";
export { ActiveAccountsLoadError, loadMeridianActiveAccounts, toHouseholdConfig } from "../../sources/meridian-active-accounts";
export type { HouseholdConfig, HouseholdEntry } from "../../sources/household-config";

/**
 * With TRADE_REQUESTS_LOCAL_SOURCES on (local runs and aoa-dev, which have no feeds) the copied records stand in for
 * an unconfigured feed, as the standalone service does without Warehouse (clients.ts:80-82, households.ts:91-104).
 * Otherwise an unconfigured feed is a configuration fault: the reads answer as an unavailable source instead of
 * serving the copied tables.
 */
export function localFeedFallbackAllowed(): boolean {
  return tradeRequestsLocalSourcesEnabled();
}

export function logFeedUnconfigured(operation: string): void {
  console.error(JSON.stringify({ event: "trade_request_native_feed_unconfigured", operation }));
}
