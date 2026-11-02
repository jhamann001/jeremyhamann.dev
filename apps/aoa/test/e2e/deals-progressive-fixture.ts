import { Prisma, type PrismaClient } from "@prisma/client";

const ids = Array.from({ length: 352 }, (_, index) => `PN-DEAL-${String(index + 1).padStart(4, "0")}`);

/** Receives the global fixture's validated owner; refuses any other database before writing. */
export async function setupDealsProgressiveFixture(owner: PrismaClient): Promise<() => Promise<void>> {
  const target = await owner.$queryRaw<{ database_name: string; role_name: string; address: string }[]>`
    SELECT current_database() AS database_name, current_user AS role_name, inet_server_addr()::text AS address`;
  if (target[0]?.database_name !== "aoa_pagination_synthetic" || target[0]?.role_name !== "aoa" ||
    !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(target[0]?.address) ||
    process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["prod", "dev"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("deals_fixture_requires_isolated_loopback_database");
  }
  const conflicts = await owner.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS count FROM app.deal WHERE id IN (${Prisma.join(ids)})
      AND (name IS DISTINCT FROM 'PN Deal Fixture Deal ' || right(id, 4)
        OR client_first_name IS DISTINCT FROM 'PN Deal Fixture')`);
  if (Number(conflicts[0]?.count)) throw new Error("deals_fixture_id_collision");
  const cleanup = async () => {
    await owner.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.deal WHERE id IN (${Prisma.join(ids)})`);
      // Inserts/updates/deletes generate row-change audit entries even in this
      // synthetic database. Remove only this fixture's exact primary keys.
      await tx.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE schema_name = 'app'
        AND table_name = 'deal' AND row_pk IN (${Prisma.join(ids)})`);
    });
  };
  await cleanup();
  try {
    await owner.$executeRaw`
      INSERT INTO app.deal (id, source, name, client_first_name, client_last_name,
        household_name, amount, stage, created_date, close_date, statements,
        account_type, transferring_firm, cedar_ridge_user_id, archived_at, archived_by, archived_reason, updated_at)
      SELECT 'PN-DEAL-' || lpad(i::text, 4, '0'), 'APP', 'PN Deal Fixture Deal ' || lpad(i::text, 4, '0'),
        'PN Deal Fixture', 'Person ' || lpad(i::text, 4, '0'), 'PN Deal Household ' || lpad(i::text, 4, '0'),
        i * 100, (ARRAY['POTENTIAL','COMMITTED','FUNDING','WON','LOST'])[1 + (i % 5)]::app."DealStage",
        '2026-09-01'::date, '2026-10-01'::date, i % 3 <> 0, 'IRA', 'PN Invented Custodian',
        'synthetic-deal-private-' || i,
        CASE WHEN i > 350 THEN '2026-09-02'::timestamptz ELSE NULL END,
        CASE WHEN i > 350 THEN 'synthetic@example.invalid' ELSE NULL END,
        CASE WHEN i > 350 THEN 'PN Synthetic removal reason' ELSE NULL END, '2026-09-01'::timestamptz
      FROM generate_series(1, 352) i`;
  } catch (error) { await cleanup(); throw error; }
  return cleanup;
}
