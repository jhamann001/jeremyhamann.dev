// PURE authz predicate for sensitive client-profile fields. NO Prisma /
// server-only import, so it is unit-testable in the node vitest env and safely
// imported by BOTH the data seam (lib/data/clients.ts) AND the Client Portrait
// page — the canReviewAssetMapLinks / canSeeUnlinkedAcats idiom.
//
// `cedar_ridge_user_id` is the internal Apex/DriveWealth bridge id (format
// `user-<uuid>`) and a cross-system JOIN KEY (mirror.account_holder, AUM, the
// asset-map person links, and Warehouse). It is NOT field-encrypted — encrypting a
// join key would break those joins and it is already plaintext across those
// systems (Cloud SQL encrypts it at rest). The protection here is VISIBILITY: only
// ADMIN / OPERATIONS see it on the client profile; advisors / client-service /
// VIEWER never receive it. The gate lives at the DATA seam (the value is omitted
// from getClientWithHousehold's result for other roles, so it never enters the
// RSC payload); this predicate is the single source of truth for that decision.

/** Roles that may see a client's `cedar_ridge_user_id` on the profile. */
export const CEDAR_RIDGE_USER_ID_VIEW_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

/** True when the caller's role may see a client's cedar_ridge_user_id. Fails closed
 *  on null/unknown (→ not permitted). */
export function canViewCedarRidgeUserId(role: string | null | undefined): boolean {
  return role != null && CEDAR_RIDGE_USER_ID_VIEW_ROLES.has(role);
}
