// PURE authz predicate for the asset-mapping review queue (P2.3). NO Prisma /
// server-only import, so it is unit-testable in the node vitest env and safely
// imported by BOTH the server seam/actions AND the page — the acat-lane.ts
// canSeeUnlinkedAcats idiom.
//
// The app-layer gate is the current application-role counterpart to the link table's
// acat_asset_map_link_ops_all read policy + acat_asset_map_link_ops_update write
// policy (migrations 20260719000000 / 20260720000000): ADMIN / OPERATIONS.
// Historical SQL also names the retired HEAD_OF_ADVISORY value, but current
// identities normalize that legacy value to OPERATIONS before opening a scope.
// The review queue exposes free-text client names firm-wide
// before any book attribution exists, so it must never reach advisors /
// client-service / VIEWER (design §6). RLS is the real enforcement; this gate is
// the app-layer defense so a non-permitted role never even opens a scope.

/** Current roles that may see + act on the asset-map review queue. */
export const ASSET_MAP_REVIEW_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

/** True when the caller's role may read the queue and confirm/reject links.
 *  Fails closed on null/unknown (→ not permitted). */
export function canReviewAssetMapLinks(role: string | null | undefined): boolean {
  return role != null && ASSET_MAP_REVIEW_ROLES.has(role);
}

// The /asset-mapping workspace (ticket, owner ruling 2026-10-07): Advisor and
// Client Service open it read-only, the old statement-pipeline `advisor` scope.
// Viewer never opens it. Every write stays on ASSET_MAP_REVIEW_ROLES.

/** Current roles that may open the /asset-mapping workspace. */
export const ASSET_MAP_VIEW_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
  "ADVISOR",
  "CLIENT_SERVICE",
]);

/** True when the caller's role may open the workspace (read-only unless
 *  canReviewAssetMapLinks also holds). Fails closed on null/unknown. */
export function canViewAssetMapping(role: string | null | undefined): boolean {
  return role != null && ASSET_MAP_VIEW_ROLES.has(role);
}
