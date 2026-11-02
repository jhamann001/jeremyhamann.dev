import { Prisma, type PrismaClient } from "@prisma/client";
const transferIds = Array.from({ length: 405 }, (_, index) => `PN-TRANSFER-${String(index + 1).padStart(4, "0")}`);
const auditIds = Array.from({ length: 205 }, (_, index) => -8_000_001 - index);

/** Owner is supplied only by the guarded loopback global fixture. */
export async function progressiveExtraFixture(owner: PrismaClient) {
  const [{ name }] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (name !== "aoa_pagination_synthetic") throw new Error("isolated_extra_fixture_required");
  async function cleanup() {
    await owner.$executeRaw(Prisma.sql`DELETE FROM app.transfer WHERE id IN (${Prisma.join(transferIds)})`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE table_name = 'transfer' AND row_pk IN (${Prisma.join(transferIds)})`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM audit."AuditLog" WHERE id IN (${Prisma.join(auditIds)}) AND "entityType" = 'pn_navigation_fixture'`);
    await owner.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE id IN (${Prisma.join(auditIds)}) AND table_name = 'pn_navigation_fixture'`);
  }
  const collision = await owner.$queryRaw<{ total: bigint }[]>(Prisma.sql`
    SELECT count(*) AS total FROM app.transfer WHERE id IN (${Prisma.join(transferIds)}) AND client_first_name <> 'PN Transfer Fixture'`);
  if (Number(collision[0].total)) throw new Error("transfer_fixture_id_collision");
  await cleanup();
  await owner.$executeRaw`
    INSERT INTO app.transfer (id, source, client_first_name, client_last_name, household_name, value, stage, stage_entered_at, owner_kind, updated_at)
    SELECT 'PN-TRANSFER-' || lpad(i::text, 4, '0'), 'APP', 'PN Transfer Fixture', lpad(i::text, 4, '0'), 'PN Transfer Fixture Household', i,
      (CASE WHEN i % 3 = 0 THEN 'FUNDED' WHEN i % 3 = 1 THEN 'DECISION' ELSE 'IN_TRANSFER' END)::app."TransferStage",
      '2026-09-01'::timestamptz, 'OPERATIONS', now() FROM generate_series(1, 405) i`;
  await owner.$executeRaw`
    INSERT INTO audit."AuditLog" (id, at, "actorEmail", "actorRole", action, "entityType", detail)
    SELECT -8000000 - i, '2026-09-01'::timestamptz + i * interval '1 second', 'pn-audit@example.invalid', 'OPERATIONS', 'pn.navigation', 'pn_navigation_fixture',
      '{"invented":"Synthetic navigation payload only, with enough invented text to exercise expanded audit detail safely without client information."}' FROM generate_series(1, 205) i`;
  await owner.$executeRaw`
    INSERT INTO audit.row_change (id, at, actor_email, actor_role, db_role, schema_name, table_name, op, row_pk, changed)
    SELECT -8000000 - i, '2026-09-01'::timestamptz + i * interval '1 second', 'pn-audit@example.invalid', 'OPERATIONS', 'app_rw', 'app', 'pn_navigation_fixture', 'INSERT', 'PN-AUDIT-' || i,
      '{"invented":"Synthetic field payload"}'::jsonb FROM generate_series(1, 205) i`;
  return cleanup;
}
