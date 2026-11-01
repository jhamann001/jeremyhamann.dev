/**
 * Node-side Auth.js instance (§h "Sign-in").
 *
 * Adds to the edge-safe `authConfig`: the Prisma adapter, the dev-persona Credentials provider
 * (registered ONLY when the kill switch is on) and the audit events USER_SIGNED_IN / USER_SIGNED_OUT.
 * The module-load assertion below is defense in depth; `src/instrumentation.ts` runs the same check at
 * `next start` so a misconfigured production process dies at boot.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { withoutOidcTokens } from "@/lib/auth-adapter";
import { authConfig, groupsFromSignIn } from "@/auth.config";
import { isNextBuildPhase } from "@/lib/env"; // importing evaluates `env`: parseEnv's production invariants run at first import (fail closed)
import { prisma } from "@/lib/db";
import { isAllowedGoogleProfile, refusedGoogleDomain } from "@/lib/google-domain";
import { recordRefusedSignIn } from "@/lib/denial-throttle";
import { systemRequestContext, writeAudit } from "@/lib/audit";
import { getRequestContext } from "@/lib/request-context";
import {
  DEV_PROVIDER_ID,
  assertDevLoginNotInProduction,
  findDevPersona,
  isDevLoginEnabled,
} from "@/lib/dev-login";
import { parseGroups } from "@/lib/rbac";
import type { AuditActor } from "@/types/domain";

// Module-load assertion. Skipped only inside the `next build` worker, which evaluates this module with
// NODE_ENV=production while collecting route metadata and serves nothing (the local .env legitimately carries
// AUTH_DEV_LOGIN=true there). Every serving process still runs it: here at module load (`next start` never sets
// NEXT_PHASE=phase-production-build) and again in src/instrumentation.ts at boot. Decision #43.
if (!isNextBuildPhase) assertDevLoginNotInProduction();

/**
 * Fixed-persona sign-in for local development. `authorize` re-checks the kill switch on every call so a
 * process whose env flipped mid-life cannot mint a persona session; the persona User row is upserted so
 * seeded tickets can reference it and `getViewer()` finds a row.
 *
 * This function must never change `User.isActive`. `callbacks.signIn` below is the one place that decides
 * whether a sign-in is allowed, and it reads the stored flag — so a write here would make
 * that check answer a question it had just changed the answer to. See the comment inside `authorize`.
 */
const devPersonaProvider = Credentials({
  id: DEV_PROVIDER_ID,
  name: "Development persona",
  credentials: { persona: { type: "text" } },
  async authorize(c) {
    if (!isDevLoginEnabled()) return null;
    const p = findDevPersona(String(c?.persona ?? ""));
    if (!p) return null;
    // Decision #72 is enforced by `callbacks.signIn`, which runs AFTER this function. Two rules keep that
    // verdict a reading of stored state rather than a self-fulfilling one:
    //
    //  1. A persona row Operations has DEACTIVATED is not written to AT ALL — this returns the persona
    //     identity and lets the callback refuse it. (Before this, `authorize` upserted `isActive: true`,
    //     so the callback always saw an active row: a deactivation audited as USER_DEACTIVATED was
    //     silently reverted in the database with no USER_REACTIVATED row to explain it, and the
    //     reactivation was partial — the assignments the deactivation cleared stayed cleared.)
    //  2. The upsert's `update` branch never carries `isActive`; only `create` may set it. So a
    //     deactivation committed between the read and the write still cannot be undone here, and the
    //     callback — which re-reads the row — gets the last word either way.
    //
    // Returning the identity instead of `null` keeps the refusal in one place: a deactivated persona and
    // a deactivated Okta user both land on /sign-in?error=AccessDenied, whose copy names both causes.
    const existing = await prisma.user.findUnique({ where: { id: p.id }, select: { isActive: true } });
    if (existing && !existing.isActive) {
      return { id: p.id, email: p.email, name: p.name, image: null, groups: p.groups };
    }
    const u = await prisma.user.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        email: p.email,
        name: p.name,
        groups: p.groups,
        emailVerified: new Date(),
        isActive: true,
      },
      update: { name: p.name, groups: p.groups },
    });
    return { id: u.id, email: u.email, name: u.name, image: null, groups: p.groups };
  },
});

/**
 * a deactivated staff account cannot sign IN.
 *
 * `getViewer()` already makes a deactivated user's still-valid JWT inert on every request,
 * which covers EXISTING sessions. What it did not cover is a NEW sign-in: Okta may still hold the
 * user's assignment for hours after Operations offboards them here, and without this hook that user
 * gets a fresh 8-hour token and a USER_SIGNED_IN row that reads as legitimate access.
 *
 * This callback is node-side on purpose. `auth.config.ts` is imported by the edge middleware and may
 * never touch the database (guardrail G2), so the check lives here, in the only place that can ask.
 * It is looked up by the adapter user id for an Okta sign-in and by id for a dev persona; a user row
 * that does not exist yet (first-ever Okta sign-in, created by the adapter) is allowed through —
 * `isActive` defaults to true, and the very next request re-checks it through `getViewer()`.
 * Returning `false` makes Auth.js redirect to /sign-in?error=AccessDenied and write no session.
 *
 * This is only as truthful as the writes that precede it: nothing on either sign-in path may set
 * `isActive` on an EXISTING row. `authorize` above upholds that for the dev provider, and the Okta path
 * reaches the adapter, whose `createUser` is the only `isActive` write there.
 */
async function isSignInAllowed(userId: string | undefined): Promise<boolean> {
  if (!userId) return true; // no id to check; getViewer() is the backstop on the first request
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  return row === null || row.isActive;
}

/**
 * Why a Google identity is refused, or `null` when it is not. Two gates, in this order:
 *
 *  1. `isAllowedGoogleProfile` — the verified address on an allowlisted domain, with an allowlisted `hd`.
 *  2. Decision #72, BY EMAIL. `isSignInAllowed` below cannot answer for a Google sign-in that has no
 *     `Account` link yet: @auth/core builds that first-sign-in `user` with `crypto.randomUUID()` ("the
 *     user's id is intentionally not set based on the profile id"), so the id lookup is always against a
 *     random UUID, always finds nothing, and always allows. Until this existed, a deactivated colleague's
 *     first Google sign-in was refused only INCIDENTALLY, by the adapter throwing `OAuthAccountNotLinked`
 *     because a row with that email already existed — a refusal that reads to the person as "wrong sign-in
 *     method" and to an operator as a linking bug. The lookup here is the SAME `findUnique({ where: { email } })`
 *     the adapter makes, so the two can never disagree about which row this identity is.
 *
 * WHAT THIS DOES NOT DO, stated because the gap is the point of the temporary design: there is no roster.
 * A colleague with no `User` row at all is ALLOWED, the adapter creates their row, and `events.signIn`
 * grants them whatever `AUTH_GOOGLE_GROUPS` names. The domain allowlist plus that variable IS the
 * authorization decision for a first-time Google identity — Okta's per-person application assignment is
 * exactly what this stopgap does not have. Requiring a pre-existing row instead would be a stricter rule
 * with no way to admit the first person, on a service where the only existing rows are dev personas.
 * Keep `google_auth_groups` as small as the work needs; the build record is the whole argument.
 */
async function googleRefusalReason(profile: unknown): Promise<string | null> {
  if (!isAllowedGoogleProfile(profile)) return "google:profile-refused";
  const email = (profile as { email?: unknown }).email;
  if (typeof email !== "string") return "google:profile-refused"; // unreachable: the gate above proved it
  const row = await prisma.user.findUnique({ where: { email }, select: { isActive: true } });
  return row !== null && !row.isActive ? "google:deactivated" : null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // The $extends-ed client satisfies `PrismaClient | ReturnType<PrismaClient["$extends"]>` — no cast.
  // wrapped so `linkAccount` never persists Okta's access, refresh or id
  // token. The session strategy is "jwt" and nothing here calls an Okta API on a user's behalf, so
  // those three columns would be a stored third-party credential with no use — see
  // `src/lib/auth-adapter.ts` for the whole argument.
  adapter: withoutOidcTokens(PrismaAdapter(prisma)),
  providers: [...authConfig.providers, ...(isDevLoginEnabled() ? [devPersonaProvider] : [])],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      // The temporary Google gate. It REFUSES the sign-in rather than granting a session with no groups,
      // and the difference matters. A session with zero groups is still a session: the adapter has created
      // a `User` row for an outsider, a USER_SIGNED_IN row says they authenticated, a JWT exists for eight
      // hours, and every future widening of a default grant silently widens to them as well. Returning
      // `false` here means no row is linked, no token is issued, and the person lands on
      // /sign-in?error=AccessDenied — the same shape as every other refusal this callback makes.
      //
      // The check reads the VERIFIED claims of the token we received — the address, `email_verified` and
      // `hd` — not the `hd` hint we asked for in the authorization request, and not `user.email` (which the
      // adapter may have loaded from a pre-existing row). See `src/lib/google-domain.ts` for why the match
      // is exact, why `hd` is required, and why the allowlist cannot resolve to empty.
      if (account?.provider === "google") {
        const reason = await googleRefusalReason(profile);
        if (reason !== null) {
          // A refusal that writes nothing is a refusal nobody can review. Auth.js runs this callback before
          // `handleLoginOrRegister`, so `events.signIn` — the only other place a sign-in is recorded — never
          // runs for a refused identity, and on a publicly invokable service that left the whole new refusal
          // class visible only in the request log. Coalesced, and the DOMAIN only: never the local part.
          const ctx = await getRequestContext().catch(() => systemRequestContext("auth"));
          await recordRefusedSignIn(ctx, "google", reason, refusedGoogleDomain(profile?.email));
          return false;
        }
      }
      // Decision #72 still runs for EVERY provider, Google included. For Google it has already run, by
      // email, inside `googleRefusalReason` — the id lookup below cannot see a first-time identity's row.
      // Both gates only ever subtract, so no ordering of them can admit a deactivated account.
      return isSignInAllowed(user.id);
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      const userId = user.id;
      if (!userId) return; // adapter users and personas always carry an id; nothing to record otherwise
      // Same source of truth as the jwt callback, through the same function (#58): the configured
      // Okta claim mapped onto the internal groups for OIDC, user.groups for dev personas — never the stored
      // snapshot. An absent claim refreshes User.groups to [].
      const groups = groupsFromSignIn(account?.provider, user, profile);
      await prisma.user.update({
        where: { id: userId },
        data: {
          groups,
          name: user.name ?? undefined,
          oktaId: account?.provider === "okta" ? account.providerAccountId : undefined,
        },
      });
      const ctx = await getRequestContext().catch(() => systemRequestContext("auth"));
      const actor: AuditActor = { id: userId, email: user.email ?? "", groups };
      await writeAudit(prisma, actor, ctx, {
        action: "USER_SIGNED_IN",
        entityType: "SESSION",
        entityId: userId,
        fieldChanged: "groups",
        newValue: groups.join(","),
        metadata: { provider: account?.provider ?? "unknown" },
      });
    },
    async signOut(msg) {
      if (!("token" in msg) || !msg.token) return;
      const token = msg.token;
      const uid = typeof token.uid === "string" && token.uid.length > 0 ? token.uid : null;
      const groups = parseGroups(token.groups);
      const ctx = await getRequestContext().catch(() => systemRequestContext("auth"));
      const actor: AuditActor = { id: uid, email: token.email ?? "", groups };
      await writeAudit(prisma, actor, ctx, {
        action: "USER_SIGNED_OUT",
        entityType: "SESSION",
        entityId: uid,
      });
    },
  },
});
