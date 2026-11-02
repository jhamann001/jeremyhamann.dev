import { prisma } from "@/lib/db";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import type { Prisma } from "@prisma/client";

export type Identity = { role?: string | null; email?: string | null };
export type UserScopeTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Trusted, parameterized SET LOCAL expressions appended to the scope setup. */
  initialSettingsSql?: Prisma.Sql;
  /** Optional passive timing observer after acquisition/BEGIN, before scope setup. */
  onTransactionAcquired?: () => void;
};

/**
 * Run queries inside a transaction with the per-request RLS context set from
 * the authenticated session. `set_config(..., true)` is the SET LOCAL form, so
 * the GUCs live only for this transaction — no leakage across the shared pool.
 *
 * Postgres RLS (see the mirror_roles_grants_rls migration) reads these GUCs to
 * scope rows to the user's book of business. An unknown role falls back to
 * VIEWER, and a missing email yields '' — both fail closed (no rows).
 */
export async function withUserScope<T>(
  identity: Identity,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: UserScopeTransactionOptions,
): Promise<T> {
  const role = normalizeAppRole(identity.role);
  const email = identity.email ?? "";
  const { initialSettingsSql, onTransactionAcquired, ...transactionOptions } = options ?? {};
  return prisma.$transaction(async (tx) => {
    try { onTransactionAcquired?.(); } catch {
      // Optional observations must never change authorization or transaction work.
    }
    if (initialSettingsSql) {
      // One setup round trip for latency-sensitive reads. RLS context and
      // extra transaction-local settings are in place before the data query.
      await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true),
        set_config('app.user_email', ${email}, true) ${initialSettingsSql}`;
    } else {
      await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_email', ${email}, true)`;
    }
    // `prisma` is now a `$extends`-wrapped client (ticket retry extension), so
    // `$transaction` hands us its extended tx-client type. Its runtime shape and
    // behaviour are unchanged, but its static type is no longer identical to the
    // vanilla `Prisma.TransactionClient` the app's tx helpers (lib/audit.ts,
    // lib/data/deal-stage-write.ts) are typed against — so we present the public
    // `Prisma.TransactionClient` contract to callers and cast here at the single
    // boundary. NB: the retry extension never retries inside a transaction (see
    // lib/db.ts), so RLS scope integrity is preserved.
    return fn(tx as unknown as Prisma.TransactionClient);
  }, transactionOptions);
}
