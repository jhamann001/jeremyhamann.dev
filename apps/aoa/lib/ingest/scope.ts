import { ingestPrisma } from "@/lib/ingest/db";
import type { Prisma } from "@prisma/client";

/**
 * Run ingest writes inside ONE `ingest_rw` transaction. The upserts and the
 * per-run audit row commit together (TDD ADR-8): a failed write leaves no audit
 * row, and a failed audit insert rolls the writes back.
 *
 * GUC-less by design — the ingest sibling of `withUserScope` MINUS the
 * `set_config('app.user_role'|'app.user_email', …)` calls. FINDING (verified
 * against prisma/migrations/20260703180639_mirror_account_ingest/migration.sql
 * and …_mirror_roles_grants_rls): the ingest write policies —
 * `account_ingest_all`, `account_holder_ingest_all`, `household_ingest_all`,
 * `client_ingest_all` — are all `FOR ALL TO ingest_rw USING (true) WITH CHECK
 * (true)`. They reference NO `current_setting(...)` GUC and admit every row for
 * the `ingest_rw` role unconditionally. The GUC-scoped policies (`*_ops_all`,
 * `*_own_book`) are `TO app_rw` only and never evaluate for `ingest_rw`.
 * Therefore this wrapper sets NO GUCs — it is exactly
 * `ingestPrisma.$transaction(fn)`. DO NOT add `set_config` calls here "to match
 * `withUserScope`": `withUserScope` needs them because `app_rw`'s policies are
 * GUC-predicated; `ingest_rw`'s are not.
 *
 * One interactive transaction; the default (non-pooler) connection preserves
 * interactive-transaction semantics (the lib/db.ts ADR-3 caveat).
 *
 * TIMEOUT: the clients route issues ONE sequential $executeRaw per household and
 * per client inside this single transaction. Prisma's default interactive-
 * transaction timeout is 5s — ample for the original Client-only households feed
 * (~hundreds of statements), but the feed now pulls ALL Salesforce stages
 * (Client/Prospect/Lost*), ~2.6k rows ⇒ ~5k statements, which blew past 5s and
 * surfaced as a generic 500 (P2028, swallowed by the route's catch). The route
 * caps a batch at MAX_ITEMS=5,000 (413 above that) ⇒ ≤ ~10k statements at
 * ~1–2ms each ≈ well under 30s, so a 120s ceiling is a safe, bounded upper
 * bound with wide headroom. Lock contention is a non-issue: ingest_rw is the
 * SOLE writer of mirror.* and app_rw only READS it, so a longer-held ingest
 * transaction never blocks app traffic. maxWait is the pool-acquire budget.
 */
export async function withIngestScope<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return ingestPrisma.$transaction(fn, { timeout: 120_000, maxWait: 15_000, ...options });
}
