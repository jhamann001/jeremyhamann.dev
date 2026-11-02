import NextAuth from "next-auth";
import { randomBytes } from "node:crypto";
import Okta from "next-auth/providers/okta";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import { roleFromGroups } from "@/lib/auth/roles";
import { DEV_LOGIN } from "@/lib/auth/mode";
import { devLoginEmail } from "@/lib/demo/personas";
import { logAuthFailure } from "@/lib/observability/structured-log";
import {
  SESSION_MAX_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "@/lib/auth/session-timeout";
import { safeAuthRedirect } from "@/lib/auth/redirect";
import { listNavigationScope } from "@/lib/navigation/list-scope";

/**
 * Auth.js (NextAuth v5).
 *
 * OKTA MODE (prod): Okta OIDC + database-backed sessions (Prisma adapter). Okta
 *       groups → app role drives Postgres RLS (book-of-business scoping).
 * DEV-LOGIN MODE: a credentials "dev login" that signs you in as any seeded
 *       persona, with JWT sessions, so the app is fully usable WITHOUT standing
 *       up Okta. Always on locally; on a deployed instance it is opt-in via
 *       `AUTH_DEV_LOGIN=1` (the aoa-dev service). The single mode switch lives in
 *       `lib/auth/mode.ts` (DEV_LOGIN) and is shared with the sign-in page so the
 *       two never disagree. The prod deploy sets no such flag, so prod stays
 *       Okta-only.
 *
 * The Okta app (one per environment) supplies AUTH_OKTA_ID/SECRET/ISSUER.
 */
const isProd = process.env.NODE_ENV === "production";

// Un-missable signal when the persona dev-login is enabled on a production
// BUILD (i.e. the aoa-dev Cloud Run service). Expected ONLY there; it must never
// appear in the real prod service, whose deploy sets no AUTH_DEV_LOGIN.
if (isProd && process.env.AUTH_DEV_LOGIN === "1") {
  console.warn(
    "[auth] AUTH_DEV_LOGIN=1 — persona dev-login is ENABLED on a production build. " +
      "Expected ONLY on the aoa-dev instance; it must never be set on prod.",
  );
}

// Auth.js requires a signing secret. In PROD it must come from the environment
// (GCP Secret Manager) — if it's missing we leave it undefined so Auth.js fails
// loudly rather than signing with a weak key. In local DEV we fall back to a
// fixed, intentionally non-secret value so `npm run dev` works with zero setup;
// it only ever signs local, synthetic-data sessions and is never used in prod.
//
// INVARIANT — do NOT switch this to key off DEV_LOGIN. The fallback must stay
// gated on `isProd`, not the auth mode: the deployed aoa-dev instance has
// isProd=true AND DEV_LOGIN=true, so keying on DEV_LOGIN would hand that
// internet-reachable service the hard-coded public string below and let anyone
// forge JWTs. On any deployed instance (dev included) AUTH_SECRET must be set;
// missing → undefined → fail loud. The two switches are deliberately different.
const secret =
  process.env.AUTH_SECRET && process.env.AUTH_SECRET.length > 0
    ? process.env.AUTH_SECRET
    : isProd
      ? undefined
      : "aoa-local-dev-insecure-not-a-secret";

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret,
  // Auth.js funnels provider, callback, adapter, and session failures through
  // this seam. Emit only a stable error class—never the exception message,
  // stack, profile, token, email, or request—so Cloud Logging can alert without
  // turning authentication telemetry into a new data-leak surface.
  logger: {
    error: logAuthFailure,
  },
  // Cloud Run terminates TLS ahead of us and Auth.js v5 only auto-trusts the
  // Host header on known platforms (Vercel) or localhost — everywhere else it
  // throws UntrustedHost and EVERY /api/auth/* route 500s ("problem with the
  // server configuration"), which is exactly what the first prod sign-in hit
  // (2026-07-02). Cloud Run sets X-Forwarded-Host/Proto itself, so trusting
  // the host here is safe.
  trustHost: true,
  // ticket: our branded sign-in UI lives at "/" (app/page.tsx). Point Auth.js
  // here so it never renders its unstyled default /api/auth/signin page — any
  // framework-initiated sign-in (and the middleware redirect) lands on our page.
  pages: { signIn: "/" },
  // Database sessions need the adapter; the dev JWT path does not.
  adapter: DEV_LOGIN ? undefined : PrismaAdapter(prisma),
  // ticket / ticket: 4h sliding/idle session for BOTH strategies.
  //  - maxAge (14400s) is the session lifetime; with no user interaction it
  //    expires ~4h out. PROD (database): the adapter stamps Session.expires =
  //    now + maxAge at creation and re-stamps it on update. DEV (jwt): the token
  //    `exp` is now + maxAge.
  //  - updateAge (1800s) is the slide: Auth.js only re-stamps expiry once the
  //    session is older than updateAge, so ongoing server interaction (any page
  //    that calls auth()) pushes expires forward, while true inactivity lets it
  //    lapse. Auth.js requires updateAge < maxAge; it applies to both strategies.
  // The 5-min warning + "Stay signed in" renew (see /api/session/renew) then
  // handles the idle-reader case on top of this server-side slide.
  session: {
    strategy: DEV_LOGIN ? "jwt" : "database",
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
  },
  providers: DEV_LOGIN
    ? [
        Credentials({
          id: "dev",
          name: "Dev login",
          credentials: { email: { label: "Email", type: "text" } },
          async authorize(creds) {
            // The public demo signs in only as its four personas, never as any other seeded user.
            const email = devLoginEmail(creds?.email);
            if (!email) return null;
            const user = await prisma.user.findUnique({ where: { email } });
            if (!user) return null;
            return {
              id: user.id,
              email: user.email ?? undefined,
              name: user.name ?? undefined,
              role: user.role,
            };
          },
        }),
      ]
    : [
        Okta({
          clientId: process.env.AUTH_OKTA_ID,
          clientSecret: process.env.AUTH_OKTA_SECRET,
          issuer: process.env.AUTH_OKTA_ISSUER,
          // Request the group claim so we can map Okta groups → app roles.
          // AS-BUILT (IT, 2026-07-02): the custom scope is `aoa_groups` (the
          // generic `groups` scope was taken by another app's config); it
          // releases the `OpsPortalGroups` claim onto the ID token — verified in
          // IT's token preview: scp [openid, profile, email, aoa_groups],
          // id_token.OpsPortalGroups = ["AOA-Operations"].
          authorization: {
            params: { scope: "openid email profile aoa_groups" },
          },
        }),
      ],
  callbacks: {
    // Preserve explicit same-origin in-app targets; foreign origins fall back to
    // baseUrl (no open redirect). Post-login home = Command Center (TDD ADR-3) is
    // carried by the explicit `redirectTo: "/command-center"` at the signIn call
    // sites (app/page.tsx), for BOTH the dev Credentials and Okta paths — we do NOT
    // rewrite the bare site root here, so sign-out (`signOut({ redirectTo: "/" })`)
    // correctly lands on the public landing page instead of being forced to
    // /command-center (which the auth middleware would then bounce to sign-in).
    async redirect({ url, baseUrl }) {
      return safeAuthRedirect({ url, baseUrl });
    },
    // DEV (JWT): persist the app role and a non-credential navigation nonce at
    // sign-in. Auth.js keeps this nonce in its encrypted JWT through renewal;
    // rotating exp/iat/jti are deliberately not used as navigation identity.
    async jwt({ token, user, trigger }) {
      if (DEV_LOGIN && user && (trigger === "signIn" || trigger === "signUp")) {
        token.navigationSessionNonce = randomBytes(32).toString("hex");
      }
      if (user && "role" in user) {
        (token as { role?: string }).role = normalizeAppRole(
          (user as { role?: string }).role,
        );
      }
      return token;
    },
    // Surface the app role on the session for RLS / UI gating.
    // PROD reads it from the DB user; DEV from the JWT.
    async session({ session, token, user }) {
      const role =
        (user as { role?: string } | undefined)?.role ??
        (token as { role?: string } | undefined)?.role ??
        "VIEWER";
      if (session.user) {
        (session.user as { role?: string }).role = normalizeAppRole(role);
        // The JWT strategy's default session user carries no id; server code
        // that reads the user's own row needs it in both strategies.
        const id = user?.id ?? token?.sub;
        if (typeof id === "string" && id !== "") session.user.id = id;
      }
      // The database strategy passes the adapter session, INCLUDING its bearer
      // sessionToken, to this server callback. Hash it here, then return only
      // explicit public fields so neither that credential nor the dev nonce
      // can reach /api/auth/session, client props, logs, or navigation storage.
      // A pre-upgrade dev JWT without a nonce has no persistent navigation scope
      // until its next sign-in. Do not mint one on reads (server rendering may
      // not persist cookies and parallel reads would then disagree).
      const loginKey = DEV_LOGIN
        ? (typeof token?.navigationSessionNonce === "string" &&
            /^[a-f0-9]{64}$/.test(token.navigationSessionNonce)
          ? token.navigationSessionNonce : null)
        : session.sessionToken;
      const navigationScope = listNavigationScope(
        session.user ? {
          id: user?.id ?? token?.sub ?? session.user.id,
          email: session.user.email,
          role: normalizeAppRole(role),
        } : null,
        { strategy: DEV_LOGIN ? "jwt" : "database", key: loginKey },
      );
      return { user: session.user, expires: session.expires, navigationScope };
    },
  },
  events: {
    // PROD (Okta + DB sessions): map the Okta group claim → app role on EVERY
    // sign-in, so role/RLS stays current when Okta group membership changes — not
    // just at first login. The DB-session path never runs the `jwt` callback, so
    // this event is where groups→role must be applied (roleFromGroups fails closed
    // to VIEWER on no/unknown groups). Dev (JWT/credentials) never hits this.
    //
    // CLAIM NAME: our Okta app emits the group list as `OpsPortalGroups` (the org's
    // Okta admin couldn't reuse the name `groups` — already claimed by another
    // app's authorization-server config; confirmed 2026-07-02). Same shape:
    // an array of `AOA-*` group-name strings on the ID token. We read
    // `OpsPortalGroups` first and keep `groups` as a fallback in case the claim is
    // ever renamed back.
    async signIn({ user, account, profile }) {
      if (account?.provider !== "okta" || !user?.id) return;
      const p = profile as
        | { OpsPortalGroups?: unknown; groups?: unknown }
        | null
        | undefined;
      const raw = p?.OpsPortalGroups ?? p?.groups;
      const groups = Array.isArray(raw)
        ? raw.filter((g): g is string => typeof g === "string")
        : [];
      const role = roleFromGroups(groups);
      if ((user as { role?: Role }).role !== role) {
        await prisma.user.update({ where: { id: user.id }, data: { role } });
      }
    },
  },
});

// roleFromGroups lives in `lib/auth/roles.ts` (a dependency-free module) so it can
// be unit-tested without importing the whole next-auth stack. Imported above for the
// events.signIn groups→role mapping; re-exported here so `@/auth` stays its import
// path for the rest of the app.
export { roleFromGroups };
