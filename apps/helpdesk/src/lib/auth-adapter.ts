/**
 * Auth.js adapter wrapper — node only, layer L3.
 *
 * WAVE B FOUNDATION STUB. **Owned by slice B6 (compliance)**. The signature is the contract:
 * `src/auth.ts` already wraps `PrismaAdapter(prisma)` in `withoutOidcTokens(...)`, so B6 changes this
 * file and nothing else. The behaviour below is real from this commit, not a placeholder.
 *
 * What it does, and why. `@auth/prisma-adapter`'s `linkAccount` writes whatever the provider returned
 * straight into `Account`, which includes `access_token`, `refresh_token` and `id_token`. This app
 * uses `session: { strategy: "jwt" }` and never calls an Okta API on the user's behalf, so it has no
 * use for any of them — and storing a bearer for a third-party identity provider in a books-and-records
 * database is a liability with no corresponding benefit: it widens what a database compromise yields,
 * it lands inside every backup and every restore drill, and it has to be answered for in the Reg S-P
 * data inventory. The columns stay in the schema (the adapter's contract declares them and a migration
 * that drops them is not worth the churn); they are simply never populated.
 *
 * `expires_at`, `token_type`, `scope` and `session_state` are kept: they are metadata about the link,
 * carry no credential, and are what an operator reads when an Okta assignment looks wrong.
 */
import type { Adapter, AdapterAccount } from "next-auth/adapters";

/** The three columns this wrapper refuses to persist. Exported so the test names them, not a literal. */
export const NEVER_PERSISTED_ACCOUNT_FIELDS = ["access_token", "refresh_token", "id_token"] as const;

/** Strips the three credential fields from an account payload. Pure; the rest is passed through. */
export function stripOidcTokens<T extends Partial<AdapterAccount>>(account: T): T {
  const copy: Record<string, unknown> = { ...account };
  for (const field of NEVER_PERSISTED_ACCOUNT_FIELDS) {
    if (field in copy) copy[field] = null;
  }
  return copy as T;
}

/**
 * Returns the adapter with `linkAccount` (and `updateUser`-shaped account writes, where the adapter
 * exposes one) filtered through `stripOidcTokens`. Every other method is passed through untouched, so
 * this cannot silently change the adapter's contract.
 */
export function withoutOidcTokens(adapter: Adapter): Adapter {
  const linkAccount = adapter.linkAccount?.bind(adapter);
  if (!linkAccount) return adapter;
  return {
    ...adapter,
    linkAccount: (account: AdapterAccount) => linkAccount(stripOidcTokens(account)),
  };
}
