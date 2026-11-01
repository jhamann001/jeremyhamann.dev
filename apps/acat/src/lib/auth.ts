import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { processJwtRefresh } from "@/lib/auth-jwt";
import { authConfig } from "@/lib/auth-config";
import { authorizePersona } from "@/lib/demo/persona-auth";
import { personaSignInEnabled } from "@/lib/demo/personas";

// ticket: ADVISOR added so AllowedUser rows tagged with that role can
// reach the /advisor self-service view (and nothing else).
declare module "next-auth" {
  interface Session {
    user: {
      email: string;
      name?: string | null;
      image?: string | null;
      role: "ADMIN" | "USER" | "ADVISOR";
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: "ADMIN" | "USER" | "ADVISOR";
    // Unix-epoch seconds of the last time we re-verified this user's
    // allow-list entry + role against the DB.
    lastRoleCheckAt?: number;
    // Unix-epoch seconds of the last time the user made an authenticated
    // request. Used to enforce idle timeout server-side.
    lastActivityAt?: number;
  }
}

const ALLOWED_DOMAINS = ["example.com", "example.org"];

// Fail fast if someone deploys with the committed dev placeholder.
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXTAUTH_SECRET === "dev-secret-change-in-production"
) {
  throw new Error(
    "NEXTAUTH_SECRET is set to the dev placeholder in production; refusing to start"
  );
}

// Hard stop: the dev bypass must never be live in production, even if env
// variables leak. This guard is the second line of defense — the provider
// itself is already gated on NODE_ENV !== "production" below.
if (
  process.env.NODE_ENV === "production" &&
  process.env.DEV_AUTH_BYPASS === "1"
) {
  throw new Error(
    "DEV_AUTH_BYPASS is enabled in production; refusing to start"
  );
}

const devBypassEnabled =
  process.env.NODE_ENV !== "production" &&
  process.env.DEV_AUTH_BYPASS === "1";

// Extend the database-free providers with the DB-backed Credentials
// provider used for local sign-in. Its authorize callback runs only in the
// /api/auth/* route handlers; protected Proxy requests only read sessions.
const providers = [...authConfig.providers];

if (devBypassEnabled) {
  providers.push(
    // Dev-only: sign in by typing an allow-listed email. The standard signIn
    // callback below still enforces domain + AllowedUser checks, so an
    // attacker can't forge an arbitrary user even if they reach this
    // provider in dev.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Credentials({
      id: "dev",
      name: "Dev sign-in",
      credentials: {
        email: { label: "Email", type: "email" },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        if (!email) return null;
        const allowed = await prisma.allowedUser.findUnique({
          where: { email },
          select: { email: true, name: true, active: true },
        });
        if (!allowed || !allowed.active) return null;
        return {
          email: allowed.email,
          name: allowed.name ?? email.split("@")[0],
        };
      },
    }) as unknown as (typeof providers)[number]
  );
}

if (personaSignInEnabled()) {
  providers.push(
    // Demo: sign in as one of the persona staff, with no password. Only the
    // persona accounts are accepted, and only while active; the signIn and jwt
    // callbacks below still apply the domain, allow-list and role checks.
    Credentials({
      id: "persona",
      name: "Demo persona",
      credentials: {
        email: { label: "Email", type: "email" },
      },
      async authorize(creds) {
        return authorizePersona(creds?.email, (email) =>
          prisma.allowedUser.findUnique({
            where: { email },
            select: { email: true, name: true, active: true },
          })
        );
      },
    }) as unknown as (typeof providers)[number]
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      const email = user.email;
      if (!email) return false;
      const domain = email.split("@")[1]?.toLowerCase();
      if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
        return "/login?error=AccessDenied";
      }
      const allowed = await prisma.allowedUser.findUnique({
        where: { email: email.toLowerCase() },
      });
      if (!allowed || !allowed.active) {
        return "/login?error=AccessDenied";
      }
      return true;
    },
    async jwt({ token, user, trigger }) {
      return processJwtRefresh(token, user ?? undefined, trigger, {
        now: () => Math.floor(Date.now() / 1000),
        findAllowedUser: async (email) => {
          const row = await prisma.allowedUser.findUnique({
            where: { email },
            select: { active: true, role: true },
          });
          return row ?? null;
        },
        log: {
          info: (payload, msg) => logger.info(payload, msg),
          warn: (payload, msg) =>
            typeof payload === "string"
              ? logger.warn(payload)
              : logger.warn(payload, msg ?? ""),
        },
      });
    },
  },
});
