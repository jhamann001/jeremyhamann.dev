// Database-free NextAuth base config.
//
// Used alone only for public Proxy paths, where the session is useful for
// request logging/rate limits but cannot authorize protected data. Protected
// Proxy paths and route handlers use `./auth.ts`, which adds current
// allow-list and role checks. Next.js 16 Proxy supports that Node.js code.
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import {
  SESSION_MAX_AGE_SEC,
  SESSION_UPDATE_AGE_SEC,
} from "@/lib/auth-jwt";

export const authConfig: NextAuthConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SEC,
    updateAge: SESSION_UPDATE_AGE_SEC,
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    // Pure token→session mapping. No DB access. The full
    // config in auth.ts does NOT override this — it's the single source
    // of truth for how the role lands on the client-visible Session.
    session({ session, token }) {
      if (session.user) {
        // ticket: ADVISOR is a third role — see prisma/schema.prisma
        // and src/lib/auth.ts module-augment.
        session.user.role =
          (token.role as "ADMIN" | "USER" | "ADVISOR") ?? "USER";
      }
      return session;
    },
  },
};
