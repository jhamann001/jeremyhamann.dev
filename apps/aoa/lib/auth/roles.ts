// Okta group → app Role mapping.
//
// Kept in its own runtime-dependency-free module (no next-auth / next / prisma
// *runtime* imports — the Role import below is type-only and erases at compile) so
// this security-critical logic can be unit-tested in isolation without booting the
// whole auth stack. `auth.ts` re-exports it, so `@/auth` remains the public import
// path for the app runtime.
import type { Role } from "@prisma/client";

/**
 * Map Okta group names → app Role. Groups follow the firm standard `<APP>-<Role>`
 * (e.g. `AOA-Admin`, `AOA-Operations` / `AOA-Ops Read/Write`, `AOA-Client Service`).
 *
 * Matching is robust, not naive substring: each group is normalized (lowercased,
 * `<APP>-` prefix stripped, punctuation/whitespace collapsed to single-spaced
 * tokens), then matched on role **tokens** — so `AOA-Head of Advisory` never
 * mis-hits `advisor` (its tokens are head/of/advisory, no `advisor` token); it is
 * instead caught by an explicit `head of advisory` phrase match and folded into
 * `OPERATIONS` (see below). Any access-level suffix (`Read/Write`, `Read Only`) is
 * ignored: RLS scopes by function, not access level. Fails closed to `VIEWER` for
 * empty/unknown groups.
 *
 * Head of Advisory is folded into Operations at this mapping layer: a
 * `*-Head of Advisory` group resolves (via the phrase match) directly to
 * `OPERATIONS`, so HoA is not a distinct role — no user ever falls through to
 * VIEWER on account of it. Priority: most-privileged wins across groups.
 */
export function roleFromGroups(groups: string[] = []): Role {
  const norm = groups.map((raw) =>
    raw
      .toLowerCase()
      .replace(/^[a-z0-9]+-\s*/, "") // strip the "<appcode>-" / "<appcode>- " prefix
      .replace(/[^a-z0-9]+/g, " ") // punctuation → spaces (e.g. "read/write")
      .trim(),
  );
  const hasToken = (kw: string) => norm.some((n) => n.split(" ").includes(kw));
  const hasPhrase = (p: string) => norm.some((n) => n.includes(p));

  if (hasToken("admin")) return "ADMIN";
  if (hasToken("ops") || hasToken("operations") || hasPhrase("head of advisory")) return "OPERATIONS";
  if (hasPhrase("client service")) return "CLIENT_SERVICE";
  if (hasToken("advisor")) return "ADVISOR";
  return "VIEWER";
}
