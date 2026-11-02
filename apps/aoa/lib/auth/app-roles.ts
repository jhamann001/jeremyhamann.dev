// Exhaustive application-scope role catalog. Dependency-free at runtime so the
// security boundary can be unit-tested without constructing Prisma/Auth.js.
import type { Role } from "@prisma/client";

// Adding a Prisma Role makes this Record fail typecheck until its application
// scope posture is explicit. This prevents a valid DB role from silently
// falling through to VIEWER because a second allowlist drifted.
const APP_ROLE_COVERAGE = {
  ADMIN: true,
  OPERATIONS: true,
  ADVISOR: true,
  CLIENT_SERVICE: true,
  VIEWER: true,
} satisfies Record<Role, true>;

export const APP_ROLES = new Set<Role>(Object.keys(APP_ROLE_COVERAGE) as Role[]);

/** Normalize untrusted session role text at the single RLS scope boundary. */
export function normalizeAppRole(role: string | null | undefined): Role {
  // Deployment compatibility only: the retired role is converted to its
  // replacement until every pre-migration session has naturally expired.
  if (role === "HEAD_OF_ADVISORY") return "OPERATIONS";
  return APP_ROLES.has(role as Role) ? (role as Role) : "VIEWER";
}
