import { PrismaClient } from "@prisma/client";

// Test-only helper for the DB-gated ingest integration cases. Whether the live
// path runs is decided by INGEST_DATABASE_URL: absent → the suites
// describe.skip with a logged reason (npm run test never fails for lack of a
// DB); present → the suites run against the real `ingest_rw` connection.
//
// Cleanup: `ingest_rw` has NO DELETE grant (ADR-7), so fixtures are removed via
// a SEPARATE superuser/BYPASSRLS connection (INGEST_TEST_CLEANUP_URL, or the
// same host with a superuser). All fixture ids are clearly namespaced
// (TEST-D2-*, ACCT-D2-*, user-…-0000000n) so cleanup is scoped and a partial
// run leaves nothing stray.

export const INGEST_DB_URL = process.env.INGEST_DATABASE_URL;
export const dbGated = INGEST_DB_URL ? describe : describe.skip;

import { describe } from "vitest";

// The write client the handlers use (ingest_rw). Bounded pool not needed for
// tests; a plain client on the ingest URL is enough.
export function makeIngestClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: INGEST_DB_URL } } });
}

// Superuser/BYPASSRLS client for setup snapshots + teardown DELETEs. Defaults to
// INGEST_TEST_CLEANUP_URL; if unset, tries a peer-auth superuser on the same db.
export function makeCleanupClient(): PrismaClient {
  // Superuser/BYPASSRLS connection: reads mirror despite FORCE RLS and can
  // DELETE (ingest_rw cannot). Prefer an explicit INGEST_TEST_CLEANUP_URL; else
  // fall back to a peer-auth connection as the local OS user, which is a
  // SUPERUSER + BYPASSRLS in the local aoa stack (libpq peer auth, no password).
  const url =
    process.env.INGEST_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=mirror`;
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Namespaced fixture ids — every row this suite writes carries one of these so
 * teardown is exact. */
export const FX = {
  hh1: "TEST-D2-HH1",
  // Second household under a DIFFERENT lead_advisor_email — the own_book RLS
  // cross-book-leak case (shares the TEST-D2-% household cleanup).
  hh2: "TEST-D2-HH2",
  c1: "TEST-D2-C1",
  c2: "TEST-D2-C2",
  acct1: "ACCT-D2-1",
  acct2: "ACCT-D2-2",
  // tkt account-AUM feed apex account numbers (share the ACCT-D2-% cleanup).
  aum1: "ACCT-D2-AUM1",
  aum2: "ACCT-D2-AUM2",
  // ticket custodian ULIDs (the mirror.client_account_aum PK) — namespaced so
  // they share the ACCT-D2-% cleanup.
  cust1: "ACCT-D2-CU1",
  cust2: "ACCT-D2-CU2",
  // A real firm corporate ULID (Fee Account) + the firm household sentinel — the
  // feed attributes this account to the firm household; cleanup removes firm rows
  // by household_sf_id below.
  firmCust: "01SYNTH6BDYNAGTJ07KC0SFYGY",
  firmHousehold: "FIRM-CEDAR-RIDGE",
  user1: "user-00000000-0000-0000-0000-000000000001",
  user2: "user-00000000-0000-0000-0000-000000000002",
} as const;

/** DELETE every fixture row via the cleanup (superuser) client, then confirm
 * the mirror tables are back to their pre-test counts (all fixtures gone). */
export async function cleanupFixtures(cleanup: PrismaClient): Promise<void> {
  // account_holder → account (FK), client → household (FK). Delete children
  // first. Only TEST-D2-*/ACCT-D2-* ids are touched.
  await cleanup.$executeRaw`DELETE FROM mirror.account_holder WHERE custodian_account_id LIKE 'ACCT-D2-%'`;
  await cleanup.$executeRaw`DELETE FROM mirror.account WHERE custodian_account_id LIKE 'ACCT-D2-%'`;
  // account-AUM feed: no FK. ticket re-keyed it to custodian_account_id, so
  // clean up by the namespaced custodian id OR the (still-namespaced) apex number,
  // plus any firm-household rows the firm-attribution test inserted (the firm
  // custodian ULID is a real, non-namespaced id, so scope it by the sentinel).
  await cleanup.$executeRaw`
    DELETE FROM mirror.client_account_aum
    WHERE custodian_account_id LIKE 'ACCT-D2-%'
       OR apex_account_number LIKE 'ACCT-D2-%'
       OR household_sf_id = 'FIRM-CEDAR-RIDGE'`;
  await cleanup.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'TEST-D2-%'`;
  await cleanup.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'TEST-D2-%'`;
  // tkt-households-aum-rollup (AUM6): deal fixtures seeded directly by the
  // superuser client (app roles can't DELETE — ADR; superuser bypasses). The
  // app.deal row-change trigger (audit.row_change, PR #113) records these
  // inserts AND this delete, so purge the trigger's rows AFTER the deals go —
  // row_pk carries the namespaced deal id.
  await cleanup.$executeRaw`DELETE FROM app.deal WHERE id LIKE 'TEST-D2-DEAL%'`;
  // Tolerate a local DB that predates the audit_row_change migration (to_regclass
  // → NULL when the table is absent); on a fully-migrated DB the trigger rows go.
  await cleanup.$executeRaw`
    DO $$ BEGIN
      IF to_regclass('audit.row_change') IS NOT NULL THEN
        DELETE FROM audit.row_change WHERE table_name = 'deal' AND row_pk LIKE 'TEST-D2-DEAL%';
      END IF;
    END $$`;
  // Audit rows written by the ingest runs (ingest_run entityType). ingest_rw
  // cannot delete audit; the superuser cleanup client removes the test rows so
  // the audit table is left as it was found. entityId is the synthetic run_id.
  await cleanup.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityType" = 'ingest_run' AND "entityId" LIKE 'RUN-D2-%'`;
  // The account-AUM cron generates a random-UUID run_id (not RUN-D2-*), so scope
  // those test audit rows by their unique action instead. Test-DB only.
  await cleanup.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityType" = 'ingest_run' AND action = 'ingest.account_aum'`;
}

/** Row counts for the four mirror tables (via the cleanup/superuser client so
 * RLS never hides a row from the snapshot). */
export async function mirrorCounts(
  cleanup: PrismaClient,
): Promise<Record<string, number>> {
  const rows = await cleanup.$queryRaw<Array<{ t: string; n: bigint }>>`
    SELECT 'household' AS t, count(*) AS n FROM mirror.household
    UNION ALL SELECT 'client', count(*) FROM mirror.client
    UNION ALL SELECT 'account', count(*) FROM mirror.account
    UNION ALL SELECT 'account_holder', count(*) FROM mirror.account_holder
  `;
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}
