/**
 * Auth.js module augmentation.
 * Session/JWT carry the parsed Okta groups; `User.groups` lets the dev-persona `authorize()` return them.
 */
import type { DefaultSession } from "next-auth";
// Loads "next-auth/jwt" into every program, so the JWT augmentation below applies even where nothing else
// imports it: the image build has no test files, and only a test imported it before.
import type {} from "next-auth/jwt";
import type { OktaGroup } from "@/types/domain";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      groups: OktaGroup[];
      /** Okta `sub`; null for dev personas. */
      oktaId: string | null;
      /** True for dev-persona sessions (never true in production). */
      isDev: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    /** Set by the dev-persona provider's authorize(); Okta groups arrive via the OIDC `profile` instead. */
    groups?: OktaGroup[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid: string;
    groups: OktaGroup[];
    oktaId: string | null;
    dev: boolean;
    /** Epoch ms of the sign-in that produced `groups`; the absolute 8 h session bound is measured from it. */
    groupsSyncedAt: number;
  }
}
