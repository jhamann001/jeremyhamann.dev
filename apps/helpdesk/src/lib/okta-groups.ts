/**
 * Okta group-claim configuration and the advisor platform group-name mapping — pure and edge-safe, layer L1
 *.
 *
 * Imports only `@/types/domain` and `@/lib/rbac`; `process.env` is read LITERALLY (no env module) so the same
 * predicate runs in the edge middleware, the node auth module and the sign-in RSC.
 *
 * Why this exists: the help desk signs in through the SAME Okta application as OPS_PORTAL's dev instance. That
 * application requests the custom scope `ops_portal_groups` and Okta releases the group list on the ID token as the
 * claim `OpsPortalGroups` (the tenant could not name it `groups`), and the groups it releases follow OPS_PORTAL's
 * `<APP>-<Role>` naming standard (`OPSPORTAL-Operations`, `OPSPORTAL-Client Service`, …) rather than the help desk's four
 * internal values. Scope and claim name are therefore configurable, and the raw claim is MAPPED onto the frozen
 * `OktaGroup` enum before RBAC ever sees it. Authorization itself is unchanged: `src/lib/rbac.ts` still receives
 * only the four known values, and anything the map does not recognise is dropped (fail closed).
 *
 * The map does NOT rely on the Okta claim filter being narrow: only names whose `<code>-` prefix is
 * in OKTA_APP_CODES are eligible (`IT-Admin`, `Slack-Admin`, `WMHD-Ops` grant nothing), `admin` must be the WHOLE
 * role name (`OPSPORTAL-Client Service Admin` is client service, not admin), an access-level suffix `Read Only` /
 * `Viewer` grants nothing (§b scopes by access level, unlike the advisor platform), and a scalar claim value is never mapped (a
 * claim mis-pointed at `email` or `name` yields no groups instead of minting roles from mailboxes).
 */
import type { OktaGroup } from "@/types/domain";
import { OKTA_GROUPS } from "@/types/domain";
import { isGroup } from "@/lib/rbac";

/** Scope requested when AUTH_OKTA_SCOPE is unset: Okta's built-in `groups` scope on the Org authorization server. */
export const DEFAULT_OKTA_SCOPE = "openid profile email groups";

/** ID-token claim read when AUTH_OKTA_GROUPS_CLAIM is unset. */
export const DEFAULT_OKTA_GROUPS_CLAIM = "groups";

/** A claim name is an identifier: letter or underscore, then up to 63 letters, digits or underscores. */
const CLAIM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Leading `<appcode>-` (already lower-cased), e.g. `ops-portal-`, capturing the code; a group named `compliance_officers`
 * has none. Only ONE prefix is ever considered.
 */
const APP_PREFIX = /^([a-z0-9]+)-\s*/;

/**
 * App codes (lower-cased) whose `<code>-<Role>` groups may map onto internal groups. The shared
 * Okta application releases OPS_PORTAL's groups, so `opsPortal` is the only code; a group from any other application
 * (`IT-Admin`, `Slack-Admin`, `WMHD-Ops`) grants nothing here regardless of what the claim filter releases.
 */
export const OKTA_APP_CODES: readonly string[] = ["opsportal"];

/**
 * Access-level markers that grant nothing. §b scopes by access level, so `OPSPORTAL-Ops Read Only` must
 * NOT become `ops_team` (WRITE on OPERATIONS, any→any moves); the advisor platform ignores the suffix only because its RLS scopes
 * by function. Tested against the normalised ROLE part; `\b` is safe because the input is `[a-z0-9 ]*`.
 */
const READ_ONLY_ROLE = /\bread ?only\b|\bviewer\b|\breadonly\b/;

/**
 * Well-known scalar OIDC / Okta ID-token claims that can never be a group list. `isValidOktaGroupsClaim` refuses
 * them by name (case-insensitively) so a mis-pointed AUTH_OKTA_GROUPS_CLAIM fails at boot instead of turning a
 * mailbox or display name into a candidate group. Mirrored by `var.okta_groups_claim`'s validation.
 */
export const SCALAR_OIDC_CLAIMS: readonly string[] = [
  "sub", "iss", "aud", "exp", "iat", "nbf", "jti", "nonce", "at_hash", "c_hash", "auth_time", "acr", "amr", "azp",
  "idp", "ver", "email", "email_verified", "name", "given_name", "family_name", "middle_name", "nickname",
  "preferred_username", "profile", "picture", "website", "gender", "birthdate", "zoneinfo", "locale", "updated_at",
  "phone_number", "phone_number_verified", "address", "login",
];

/** A valid scope string is non-empty and contains the literal token `openid` (OIDC requires it). */
export function isValidOktaScope(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.split(/\s+/).includes("openid");
}

/** A valid claim name matches CLAIM_NAME after trimming and is not a well-known scalar claim. */
export function isValidOktaGroupsClaim(value: string): boolean {
  const trimmed = value.trim();
  return CLAIM_NAME.test(trimmed) && !SCALAR_OIDC_CLAIMS.includes(trimmed.toLowerCase());
}

/**
 * The OIDC scope the Okta provider requests: AUTH_OKTA_SCOPE (trimmed) when it is a valid scope string, else
 * DEFAULT_OKTA_SCOPE. `parseEnv` refuses an invalid value by key name at boot, so the fallback is defensive here.
 */
export function oktaScope(): string {
  const raw = process.env.AUTH_OKTA_SCOPE;
  if (typeof raw !== "string" || !isValidOktaScope(raw)) return DEFAULT_OKTA_SCOPE;
  return raw.trim();
}

/**
 * The ID-token claim that carries the group list: AUTH_OKTA_GROUPS_CLAIM (trimmed) when it is a valid claim
 * name, else DEFAULT_OKTA_GROUPS_CLAIM. Same boot-time refusal as above.
 */
export function oktaGroupsClaim(): string {
  const raw = process.env.AUTH_OKTA_GROUPS_CLAIM;
  if (typeof raw !== "string" || !isValidOktaGroupsClaim(raw)) return DEFAULT_OKTA_GROUPS_CLAIM;
  return raw.trim();
}

/**
 * Reads the raw group list from an OIDC profile: `profile[claim]`, falling back to `profile.groups` when the
 * configured claim is absent or null (OPS_PORTAL reads `p.OpsPortalGroups ?? p.groups`; the fallback order is the same, the
 * claim name configurable). Anything that is not an object yields `undefined`. Own properties only.
 */
export function extractRawGroups(profile: unknown, claim: string): unknown {
  if (profile === null || typeof profile !== "object") return undefined;
  const p = profile as Record<string, unknown>;
  const own = (k: string): unknown => (Object.prototype.hasOwnProperty.call(p, k) ? p[k] : undefined);
  return own(claim) ?? own(DEFAULT_OKTA_GROUPS_CLAIM);
}

/** Lower-cases, turns every run of non-alphanumerics into a single space and trims. */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Splits a raw group name into its lower-cased `<code>` and the normalised role part, or returns `null` when the
 * name carries no `<code>-` prefix at all. `"OPSPORTAL-Ops Read/Write"` → `{ code: "opsportal", role: "ops read write" }`;
 * `"compliance_officers"` → `null`. Only ONE prefix is split: `"opsportal-opsportal-admin"` → `{ code: "opsportal", role: "opsportal admin" }`.
 */
export function splitOktaGroupName(name: string): { code: string; role: string } | null {
  const lower = name.toLowerCase();
  const m = APP_PREFIX.exec(lower);
  if (!m) return null;
  return { code: m[1], role: normalizeText(lower.slice(m[0].length)) };
}

/**
 * Lower-cases, strips one leading `<appcode>-` prefix, turns every run of non-alphanumerics into a single space
 * and trims — OPS_PORTAL's normalisation. `"OPSPORTAL-Ops Read/Write"` → `"ops read write"`; `"OPSPORTAL-Advisory Ops Lead"` →
 * `"advisory ops lead"`; `"compliance_officers"` → `"compliance officers"` (no prefix to strip). Text-only: whether
 * the prefix is an ALLOWED code is `opsPortalRoleName`'s job.
 */
export function normalizeOktaGroupName(name: string): string {
  return splitOktaGroupName(name)?.role ?? normalizeText(name);
}

/**
 * The normalised role part of an eligible `<code>-<Role>` name — one whose code is in OKTA_APP_CODES — or `null`
 * for everything else (no prefix, or a prefix from another application). Decision #59: this is what makes the map
 * independent of the Okta claim filter's breadth.
 */
export function opsPortalRoleName(name: string): string | null {
  const split = splitOktaGroupName(name);
  if (split === null || !OKTA_APP_CODES.includes(split.code)) return null;
  return split.role;
}

/** One mapping rule: a pattern over the NORMALISED name and the internal groups it grants. */
export type OktaGroupRule = Readonly<{
  /** Human label for docs, tests and the /no-access explanation; not used for matching. */
  name: string;
  /** Tested against `normalizeOktaGroupName(raw)`; `\b` boundaries are safe because the input is `[a-z0-9 ]*`. */
  test: RegExp;
  groups: readonly OktaGroup[];
}>;

/**
 * The advisor platform group-name → help-desk group rules (#59). Every rule whose pattern matches the ROLE part of
 * an eligible `<code>-<Role>` name contributes its groups (union, like the RBAC model); a name matching no rule is
 * dropped. Token semantics follow OPS_PORTAL's own mapper, tightened where §b's access-level model differs from OPS_PORTAL's:
 *   admin (the WHOLE role name)          → ALL FOUR (an advisor platform admin is a full operator plus compliance — isDualRole flags it);
 *                                          `client service admin` is client service, `advisor admin assistant` is advisors
 *   ops | operations                     → ops_team
 *   "client service(s)"                  → client_services   (no `cs` shorthand: a two-letter token is too loose)
 *   advisor | advisors                   → advisors          (NOT "advisory")
 *   compliance                           → compliance_officers (no such advisor platform group exists yet — create `OPSPORTAL-Compliance`)
 * A role part carrying `read only` / `viewer` grants nothing before any rule runs (READ_ONLY_ROLE). Exact internal
 * values (`ops_team`, …) never reach these rules: `mapOktaGroupNames` keeps them as-is first.
 */
export const OPS_PORTAL_GROUP_MAP: readonly OktaGroupRule[] = [
  { name: "admin", test: /^admin$/, groups: ["ops_team", "advisors", "client_services", "compliance_officers"] },
  { name: "operations", test: /\b(?:ops|operations)\b/, groups: ["ops_team"] },
  { name: "client service", test: /\bclient services?\b/, groups: ["client_services"] },
  { name: "advisor", test: /\badvisors?\b/, groups: ["advisors"] },
  { name: "compliance", test: /\bcompliance\b/, groups: ["compliance_officers"] },
];

/** True when a normalised role part carries an access-level marker that must grant nothing. */
export function isReadOnlyRoleName(role: string): boolean {
  return READ_ONLY_ROLE.test(role);
}

/**
 * Groups granted by ONE raw group name: the exact internal value, or the union of every matching advisor platform rule over
 * the role part of an eligible `<code>-<Role>` name. Unprefixed names, foreign app codes, empty role parts and
 * read-only markers all yield `[]`.
 */
function groupsForName(name: string): readonly OktaGroup[] {
  if (isGroup(name)) return [name];
  const role = opsPortalRoleName(name);
  if (role === null || role === "" || isReadOnlyRoleName(role)) return [];
  const out: OktaGroup[] = [];
  for (const rule of OPS_PORTAL_GROUP_MAP) {
    if (rule.test.test(role)) out.push(...rule.groups);
  }
  return out;
}

/**
 * Maps a raw Okta groups claim (string[] | string | anything else) onto the internal groups: array elements that
 * are exact internal values pass through (parseGroups semantics), OPS-PORTAL-style names are normalised and matched by
 * OPS_PORTAL_GROUP_MAP, everything else is dropped silently. A BARE STRING is kept only when it is itself an exact
 * internal value and is never run through the advisor platform map: a claim mis-pointed at a scalar such as
 * `email` or `name` must yield no groups, not roles minted from a mailbox. Deduplicated, ordered per OKTA_GROUPS.
 * Never throws — any unexpected failure yields `[]` (no access), never a partial or stale list.
 */
export function mapOktaGroupNames(raw: unknown): OktaGroup[] {
  try {
    const candidates: unknown[] = Array.isArray(raw) ? raw : isGroup(raw) ? [raw] : [];
    const present = new Set<OktaGroup>();
    for (const c of candidates) {
      if (typeof c !== "string") continue;
      for (const g of groupsForName(c)) present.add(g);
    }
    return OKTA_GROUPS.filter((g) => present.has(g));
  } catch {
    return [];
  }
}
