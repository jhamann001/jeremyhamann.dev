import { Prisma } from "@prisma/client";
import type { UserScopeTransactionOptions } from "@/lib/rls";

// The /asset-mapping workspace's reads of the three asset-map mirror tables
// (ticket). The *_workspace_read policies (migration 20261007120000) admit
// Advisor and Client Service only while this transaction-local setting is
// 'workspace', so other readers of those tables are unchanged for those roles.
export const ASSET_MAP_WORKSPACE_SCOPE: UserScopeTransactionOptions = Object.freeze({
  initialSettingsSql: Prisma.sql`, set_config('app.asset_map_scope', 'workspace', true)`,
});
