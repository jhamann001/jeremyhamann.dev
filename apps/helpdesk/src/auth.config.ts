/**
 * Edge-safe Auth.js configuration.
 *
 * Imported by the edge middleware, so this module may import ONLY `next-auth`, the OIDC providers,
 * the domain types and the L1 helpers (rbac, dev-login, okta-groups, google-domain). Never the database client,
 * the env module or Prisma runtime values (guardrail G2). The Prisma adapter, the dev-persona provider and the
 * audit events are added in `src/auth.ts` (node).
 */
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Okta from "next-auth/providers/okta";
import { DEV_PROVIDER_ID } from "@/lib/dev-login";
import { allowedGoogleDomains, googleGroups } from "@/lib/google-domain";
import { extractRawGroups, mapOktaGroupNames, oktaGroupsClaim, oktaScope } from "@/lib/okta-groups";
import { isPathAllowed, parseGroups } from "@/lib/rbac";
import { isIdleExpired, touchActivity } from "@/lib/session-policy";
import type { OktaGroup } from "@/types/domain";

/**
 * Absolute session lifetime measured from `groupsSyncedAt`; `updateAge` re-issues never extend it.
 *
 * Wave B adds an IDLE bound on top of it, from `src/lib/session-policy.ts`. The two
 * answer different questions: the 8 hours bound how long a demoted user keeps stale groups, 30 minutes
 * of inactivity bound how long an unattended machine stays signed into a books-and-records system.
 * Both are arithmetic over numbers already in the JWT, so both stay edge-safe.
 */
export const SESSION_ABSOLUTE_MAX_MS = 8 * 3600 * 1000;

/**
 * Okta is registered only when all three OIDC settings are present. Auth.js asserts every registered
 * provider's endpoints on EVERY call (including the dev-persona flow), so an Okta provider with an empty
 * issuer would make sign-in fail everywhere. In production `parseEnv` requires the three values, so the
 * provider is always present there; locally without an Okta tenant only the dev personas can sign in.
 * Literal `process.env` reads keep this module edge-safe (no env module import). Decision #44.
 */
export function isOktaConfigured(): boolean {
  return Boolean(process.env.AUTH_OKTA_ISSUER && process.env.AUTH_OKTA_ID && process.env.AUTH_OKTA_SECRET);
}

/**
 * The temporary Google provider is registered only when BOTH OAuth credentials are present AND the resolved
 * domain allowlist is non-empty. The allowlist half is belt and braces: `allowedGoogleDomains()` cannot
 * return an empty list by construction, and this predicate refuses to register the provider at all if it
 * ever does — so "no allowlist" can never degrade into "any Google account", it degrades into "no Google
 * sign-in". Same Auth.js constraint as Okta above: a registered provider with empty endpoints is asserted on
 * EVERY call, so an unconfigured provider must not be in the list at all.
 */
export function isGoogleConfigured(): boolean {
  return (
    Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) && allowedGoogleDomains().length > 0
  );
}

/**
 * Groups for a sign-in, from the only legitimate sources: the persona's own list for the dev
 * provider, the configured AUTH_GOOGLE_GROUPS list for the temporary Google provider, otherwise the
 * configured Okta ID-token claim (AUTH_OKTA_GROUPS_CLAIM, default `groups`) mapped onto the internal groups
 * — never the adapter's stored `User.groups` snapshot. An absent claim or an unset
 * AUTH_GOOGLE_GROUPS yields `[]`: zero groups means no access, so a user Okta removed from every group
 * cannot keep stale access when the claim disappears, and §b.8's 8 h bound holds. Shared by `callbacks.jwt`
 * here and `events.signIn` in `src/auth.ts` so the two can never disagree.
 *
 * Google carries no group claim of its own — a Workspace ID token says which mailbox you hold, not which
 * role this desk gives you — so the grant is configuration, and an unset variable grants nothing rather than
 * something. That is why a correctly configured Google sign-in can still legitimately land on /no-access.
 */
export function groupsFromSignIn(
  provider: string | undefined,
  user: { groups?: unknown } | undefined,
  profile: unknown,
): OktaGroup[] {
  if (provider === DEV_PROVIDER_ID) return parseGroups(user?.groups);
  if (provider === "google") return googleGroups();
  return mapOktaGroupNames(extractRawGroups(profile, oktaGroupsClaim()));
}

function oktaProvider() {
  return Okta({
    clientId: process.env.AUTH_OKTA_ID,
    clientSecret: process.env.AUTH_OKTA_SECRET,
    issuer: process.env.AUTH_OKTA_ISSUER,
    // AUTH_OKTA_SCOPE or "openid profile email groups"; OPS_PORTAL's shared app needs "openid email profile ops_portal_groups" (#58).
    authorization: { params: { scope: oktaScope() } },
    // STANDARD FIELDS ONLY: the adapter spreads this object into user.create (decision 6).
    profile(p) {
      return {
        id: p.sub,
        name: p.name ?? p.preferred_username ?? null,
        email: p.email,
        image: null,
      };
    },
  });
}

/**
 * The temporary Google provider. `profile()` returns STANDARD FIELDS ONLY for the same reason the Okta one
 * does (decision 6): the adapter spreads this object straight into `user.create`, so anything extra is a
 * column that does not exist. `image` is deliberately `null` rather than `p.picture` — the desk shows no
 * avatars, and a Google-hosted photo URL on a staff row is a third-party identifier stored for no purpose.
 *
 * The domain restriction is NOT here. `authorization.params.hd` is a hint Google honours on the account
 * chooser and not a guarantee about the token that comes back, so treating it as the gate would put the
 * access decision on the far side of the network. The gate is `callbacks.signIn` in `src/auth.ts`, over the
 * verified claims of the token we actually received — including the `hd` CLAIM in that token, which is a
 * different thing from the request parameter of the same name and is exactly as verified as `email_verified`.
 *
 * `allowDangerousEmailAccountLinking` IS DELIBERATELY ABSENT AND MUST NEVER BE ADDED. Without it, @auth/core
 * refuses a Google sign-in outright when a `User` row already holds that email and carries no Google
 * `Account` link: it throws `OAuthAccountNotLinked`, which the sign-in page renders as "This email is
 * already linked to a different sign-in method." That is the correct, fail-closed answer, and it is why
 * production's "Google alongside Okta" mode only ever serves identities with NO existing row — every
 * Okta-provisioned staff member already has one. Turning the flag on to "fix" that would let any verified
 * Google identity on an allowed domain ABSORB an existing staff row, after which `events.signIn` overwrites
 * that row's groups with `googleGroups()` — a domain-wide, configuration-level grant silently replacing a
 * per-person Okta one. If the additive mode is ever genuinely needed, it is an Okta-side or adapter-side
 * decision with its own review, not this switch. the build record states the same thing for operators.
 */
function googleProvider() {
  return Google({
    clientId: process.env.AUTH_GOOGLE_ID,
    clientSecret: process.env.AUTH_GOOGLE_SECRET,
    // STANDARD FIELDS ONLY: the adapter spreads this object into user.create (decision 6).
    profile(p) {
      return {
        id: p.sub,
        name: p.name ?? null,
        email: p.email,
        image: null,
      };
    },
  });
}

export const authConfig: NextAuthConfig = {
  // Okta first when both are configured: it is the real sign-in method, and the order is what the sign-in
  // page's primary/secondary CTA follows. Each provider is registered only when it is configured (#44).
  providers: [...(isOktaConfigured() ? [oktaProvider()] : []), ...(isGoogleConfigured() ? [googleProvider()] : [])],
  session: { strategy: "jwt", maxAge: 8 * 3600, updateAge: 3600 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  trustHost: true,
  callbacks: {
    jwt({ token, user, account, profile }) {
      if (account && user) {
        // Sign-in: `user.id` is the adapter row id (Okta) or the persona id (dev provider).
        token.uid = user.id ?? token.sub ?? "";
        token.oktaId = account.provider === "okta" ? account.providerAccountId : null;
        // Groups: the configured Okta claim (mapped) for OIDC sign-ins, `user.groups` for dev personas — never
        // the adapter's stored `User.groups` snapshot (#58; see groupsFromSignIn).
        token.groups = groupsFromSignIn(account.provider, user as { groups?: unknown }, profile);
        token.dev = account.provider === DEV_PROVIDER_ID;
        token.groupsSyncedAt = Date.now();
        return touchActivity(token);
      }
      // Re-issue / read: enforce the absolute lifetime. `null` invalidates the session (re-authentication).
      if (typeof token.groupsSyncedAt !== "number" || Date.now() - token.groupsSyncedAt > SESSION_ABSOLUTE_MAX_MS) {
        return null;
      }
      // and the idle lifetime. Same fail-closed shape — `null` forces re-authentication — and
      // the stamp advances only on a re-issue, so this costs no extra write.
      if (isIdleExpired(token)) return null;
      return touchActivity(token);
    },
    session({ session, token }) {
      session.user.id = token.uid;
      session.user.groups = token.groups ?? [];
      session.user.oktaId = token.oktaId ?? null;
      session.user.isDev = token.dev === true;
      return session;
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isApi = pathname.startsWith("/api/");
      if (!auth?.user) {
        if (isApi) return Response.json({ error: "unauthenticated" }, { status: 401 });
        // Not `false`: Auth.js would put the request's whole URL in callbackUrl, and behind a proxy that is the
        // app's own address (the demo's container sees https://0.0.0.0:3000), which the sign-in page refuses,
        // so a deep link fell back to /dashboard. The path is what safeRelativePath accepts behind any proxy.
        const url = new URL("/sign-in", request.nextUrl);
        url.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
        return Response.redirect(url, 307);
      }
      if (isPathAllowed(pathname, auth.user.groups ?? [])) return true;
      if (isApi) return Response.json({ error: "forbidden" }, { status: 403 });
      // I14, and the SAST finding in the build record (B12's note §3.2): the attempted
      // PATH is the evidence, and its QUERY STRING is not. `/no-access` writes what it receives into
      // `AuditLog.newValue`, which is append-only and no-hard-delete, and a forbidden URL can carry
      // `?requesterEmail=<a client's address>` — `sanitizePII` does not redact an address (it is a
      // first-class ticket field, deliberately), so that row could never be corrected afterwards.
      // Dropping `search` HERE means the address never enters the redirect, the browser history, the
      // access log or the ledger. `/no-access` strips it a second time, because a link can be typed.
      // `search` is deliberately not destructured above any more, so nothing can quietly re-add it.
      const url = new URL("/no-access", request.nextUrl);
      url.searchParams.set("from", pathname);
      return Response.redirect(url);
    },
  },
};
