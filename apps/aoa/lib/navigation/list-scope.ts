import "server-only";

import { createHash } from "node:crypto";
import { normalizeAppRole } from "@/lib/auth/app-roles";

type NavigationUser = {
  id?: string | null;
  email?: string | null;
  role?: string | null;
};

type NavigationLogin = {
  strategy: "database" | "jwt";
  /** Server-only adapter credential or encrypted-JWT nonce. Never serialize. */
  key: unknown;
};

/**
 * Server-derived partition key for navigation metadata only, NOT an access
 * token. Every restored page still authorizes independently under current RLS.
 *
 * Mirror RLS uses the exact email, so do not normalize it into a wider scope.
 * Session expiry is sliding and intentionally excluded. The login key is the
 * server-only database session token or an independent random nonce retained in
 * the encrypted dev JWT. Only this one-way, domain-separated fingerprint leaves
 * the server, never either input. A new login cannot reuse the previous login's
 * tab metadata, including when the same user signs in again.
 */
export function listNavigationScope(
  user: NavigationUser | null | undefined,
  login: NavigationLogin | null | undefined,
): string | null {
  const id = typeof user?.id === "string" && user.id.trim() ? user.id : null;
  const email = typeof user?.email === "string" && user.email.trim() ? user.email : null;
  if (
    (!id && !email) ||
    !login ||
    (login.strategy !== "database" && login.strategy !== "jwt") ||
    typeof login.key !== "string" ||
    !login.key.trim() ||
    login.key.length > 4096
  ) return null;
  const role = normalizeAppRole(user?.role);
  return createHash("sha256")
    .update(JSON.stringify([
      "aoa.navigation-metadata.v2", login.strategy, login.key, id, email, role,
    ]))
    .digest("hex");
}
