const OPERATIONS_TOOL_ROLES = new Set(["ADMIN", "OPERATIONS", "OPS"]);

/**
 * Firm-wide operations tooling has no advisor-book scope. Keep the normalized
 * allowlist in one server-safe helper so navigation and direct routes share the
 * same fail-closed rule.
 */
export function canAccessOperationsTools(role: string | null | undefined): boolean {
  return OPERATIONS_TOOL_ROLES.has(role?.trim().toUpperCase() ?? "");
}
