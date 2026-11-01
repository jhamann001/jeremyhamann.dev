/**
 * Google-account domain gate — pure and edge-safe, layer L1 (§h "Sign-in").
 *
 * TEMPORARY, and deliberately shaped so that retiring it is unsetting two secrets rather than unpicking a
 * design. Okta is the sign-in method this desk is built around, the IT request for an Okta application is
 * still outstanding, and until it lands the deployed dev service has no real sign-in method at all — only
 * the fixed dev personas, which are a development affordance and not an access control.
 * Google OIDC occupies exactly the seam Okta will occupy: the same provider list, the same
 * `groupsFromSignIn`, the same `callbacks.signIn` refusal, the same audit row. Nothing else moves.
 *
 * `process.env` is read LITERALLY here — never through `@/lib/env`. `src/auth.config.ts` is imported by the
 * edge middleware and may hold nothing from L2+ (guardrail G2), and a helper IT imports is bound by the same
 * rule, so the env module is off limits in this file exactly as it is in `dev-login.ts` and `okta-groups.ts`.
 * `parseEnv` still validates these keys at boot; the parsing here is defensive, and it is what runs in the
 * edge bundle where `parseEnv` has never run at all.
 *
 * THE ALLOWLIST FAILS CLOSED, which is the point of the whole module. The dangerous shape is a list that
 * parses to nothing and is then read as "no restriction": one typo in a Terraform variable, one trailing
 * comma in a secret, and a staff-only books-and-records desk accepts any Google account on the internet.
 * So there is no code path here that yields an empty allowlist. An unset, empty or whitespace-only
 * AUTH_GOOGLE_ALLOWED_DOMAINS means DEFAULT_GOOGLE_DOMAINS, and `isAllowedGoogleProfile` refuses outright if
 * it is ever handed an empty list anyway. The matching is EXACT against a list entry, never a suffix test:
 * `endsWith("example.com")` would admit `evil-example.com`, and a constructed regexp would
 * admit `example.com.attacker.tld` through an unescaped dot. Subdomains are not company mail here,
 * so `sub.example.com` is refused too.
 *
 * THE CHECK IS ON THE WHOLE PROFILE, not on an address, and there is deliberately no weaker entry point to
 * reach for. `isAllowedGoogleProfile` is the only exported predicate that answers "may this identity sign
 * in", so a caller cannot satisfy two of its three conditions and believe it has asked the question. The
 * third condition is the `hd` claim, and it is the one that makes this a WORKSPACE check rather than a
 * mailbox check: `email` + `email_verified` says only that somebody proved control of that inbox at some
 * point, and a PERSONAL Google account can be created against a company address, verified by mail once, and
 * then survive the deletion of the Workspace account it shadows. Such an account carries no `hd` at all, so
 * requiring `hd` is what closes the offboarded-employee and contractor classes. It is the claim of the token
 * we actually received — as verified as `email_verified` is — and not the `authorization.params.hd` REQUEST
 * hint, which Google honours on the account chooser and does not guarantee in the response (see the note
 * beside `googleProvider()` in `src/auth.config.ts`; that argument is about the request, not about this).
 */
import { isGroup, parseGroups } from "@/lib/rbac";
import type { OktaGroup } from "@/types/domain";

/** The two company domains. Used whenever AUTH_GOOGLE_ALLOWED_DOMAINS resolves to nothing — never "all". */
export const DEFAULT_GOOGLE_DOMAINS: readonly string[] = ["example.com", "example.net"];

/**
 * One DNS label: letters, digits and hyphens, with no leading or trailing hyphen. Anchored, and applied to
 * ONE label at a time, so a dot can never be matched by the character class — which is how a "looks like a
 * domain" check usually lets `example.com.attacker.tld` past a human reviewer.
 */
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Whether ONE entry is written as a bare domain: at least two labels (so at least one dot), every label
 * well formed, nothing else. A scheme (`https://…`), an `@`, whitespace, a leading or trailing dot and a
 * leading or trailing hyphen in any label all fail, because each of those makes the entry unmatchable by
 * `isAllowedGoogleEmail` — a silently unmatchable allowlist entry is an access rule that does not exist.
 */
export function isValidGoogleDomain(value: string): boolean {
  const domain = value.trim().toLowerCase();
  if (domain === "" || domain.length > 253) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => label.length <= 63 && DOMAIN_LABEL.test(label));
}

/**
 * Whether a whole AUTH_GOOGLE_ALLOWED_DOMAINS value is usable: at least one entry, every entry a domain.
 * `parseEnv` refuses a set-but-malformed value by KEY NAME at boot with this, the same way it refuses
 * AUTH_OKTA_SCOPE — an operator who wrote the variable meant it to take effect, and a value
 * that silently falls back to the default is not what they asked for. A value of `",,,"` is refused here
 * for that reason, while `allowedGoogleDomains` below still treats it as "use the default", because the two
 * answer different questions: this one is "did the operator write something meaningful", that one is "what
 * is in force right now, in a bundle where parseEnv may never have run".
 */
export function isValidGoogleDomainList(raw: string): boolean {
  const entries = splitList(raw);
  return entries.length > 0 && entries.every(isValidGoogleDomain);
}

/**
 * Whether a whole AUTH_GOOGLE_GROUPS value names known groups only. Refused at boot rather than dropped:
 * `parseGroups` drops an unknown value silently, which is right at RUNTIME — an unrecognised claim
 * must never mint a role — but as a CONFIGURATION outcome it is the worst of both worlds. `ops-team` for
 * `ops_team` would deploy cleanly, grant nothing, and present as "Google sign-in works but everyone lands
 * on /no-access", which reads like an RBAC bug rather than a typo.
 */
export function isValidGoogleGroupList(raw: string): boolean {
  const entries = splitList(raw);
  return entries.length > 0 && entries.every((entry) => isGroup(entry));
}

/** Comma-separated, trimmed, empties dropped. The one place the list format is defined. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * The domains a Google identity may come from, lower-cased and deduplicated.
 *
 * Unset, empty, whitespace-only and `",,,"` all resolve to DEFAULT_GOOGLE_DOMAINS. There is no input for
 * which this returns `[]`, and no caller may read `[]` as permissive — see the module header.
 */
export function allowedGoogleDomains(): string[] {
  const raw = process.env.AUTH_GOOGLE_ALLOWED_DOMAINS;
  if (typeof raw !== "string") return [...DEFAULT_GOOGLE_DOMAINS];
  const domains = new Set(splitList(raw).map((entry) => entry.toLowerCase()));
  return domains.size === 0 ? [...DEFAULT_GOOGLE_DOMAINS] : [...domains];
}

/**
 * The domain after the single `@` of an address, lower-cased — or `null` when the value is not one address.
 *
 * An address with no `@`, with more than one `@`, or with an empty local part yields `null` before any
 * check can be fooled by it: `a@b@example.com` has an allowed-looking tail and is not an address
 * this desk issued.
 */
function emailDomain(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local === "" || domain === "") return null;
  return domain;
}

/**
 * Whether a Google profile may sign in at all. All three conditions are refusals, not downgrades:
 *
 *  - `email_verified` must be exactly `true`. Google's own claim is a boolean; the string `"true"`, `null`
 *    and an absent claim are all "not verified", because an unverified address is a claim about an inbox
 *    nobody has proved they hold, and the domain check is a statement about that inbox.
 *  - the domain after the single `@` must EQUAL an allowlist entry, case-insensitively. No suffix test, no
 *    constructed regexp, no subdomain: see the module header for what each of those would admit.
 *  - the `hd` claim must be present and must ALSO equal an allowlist entry. That is the Workspace half —
 *    see the module header for the consumer-account class it closes.
 *
 * `hd` is matched against the LIST rather than against the address's own domain on purpose. A Workspace
 * with a secondary domain can issue `someone@example.net` an `hd` of `example.com`; both are
 * company domains, both are listed, and demanding `hd === domain` would refuse a real colleague. Requiring
 * both to be ON the list keeps the rule exact in the direction that matters — an identity Google says
 * belongs to a domain nobody listed is refused however its address reads.
 *
 * THE FAILURE MODE, stated because it is the one that locks everybody out at once: if the Workspace's `hd`
 * is a domain that is NOT in `google_auth_allowed_domains`, every sign-in is refused. That is the fail-closed
 * direction and the remedy is to add that domain to the allowlist — the build record troubleshooting
 * carries the symptom and the fix.
 */
export function isAllowedGoogleProfile(profile: unknown): boolean {
  if (typeof profile !== "object" || profile === null) return false;
  const { email, email_verified: emailVerified, hd } = profile as Record<string, unknown>;
  if (emailVerified !== true) return false;
  const domain = emailDomain(email);
  if (domain === null) return false;
  const allowed = allowedGoogleDomains();
  // Unreachable as `allowedGoogleDomains` stands, and kept anyway: it is the one line that makes "an empty
  // allowlist can never be permissive" true by construction rather than by reading the function above.
  if (allowed.length === 0) return false;
  if (!allowed.includes(domain)) return false;
  if (typeof hd !== "string") return false;
  return allowed.includes(hd.trim().toLowerCase());
}

/**
 * The domain a REFUSED Google sign-in came from, for the audit row — or `null` when there is not one to
 * name. Never the local part: the ledger is append-only with no hard delete, the refused party is
 * unauthenticated and chooses this string, and `someone@example.com` in a permanent record is a
 * person's identity written down by an attacker's request.
 *
 * Bounded the same way `recordClientApiDenied` bounds a requested ticket id: a value
 * that is not a plausible bare domain is `null`, and the caller records the literal `domain:invalid`
 * rather than letting kilobytes of attacker text into the ledger.
 */
export function refusedGoogleDomain(email: unknown): string | null {
  const domain = emailDomain(email);
  if (domain === null || domain.length > 253 || !isValidGoogleDomain(domain)) return null;
  return domain;
}

/**
 * The internal groups a Google sign-in is granted, from AUTH_GOOGLE_GROUPS.
 *
 * Unset → `[]`, and zero groups means NO ACCESS: the person authenticates and lands on
 * /no-access. That is the deliberate default for a temporary sign-in method — being able to prove you hold
 * a company mailbox is not the same as holding a role on this desk — and it must not be "fixed" by
 * inventing a default group here. Parsed through `parseGroups` so an unknown value is dropped rather than
 * carried (Decision #51's rule that groups come from the sign-in, and I12's that unknown grants nothing).
 */
export function googleGroups(): OktaGroup[] {
  const raw = process.env.AUTH_GOOGLE_GROUPS;
  if (typeof raw !== "string") return [];
  return parseGroups(splitList(raw));
}
