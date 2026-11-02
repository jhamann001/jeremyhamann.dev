/** Roles allowed to receive a canonical CRM ID in an application response. */
export const CRM_ID_VIEW_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

/** Fail closed for missing, retired, and unknown roles. */
export function canViewCrmId(role: string | null | undefined): boolean {
  return CRM_ID_VIEW_ROLES.has(role ?? "");
}
