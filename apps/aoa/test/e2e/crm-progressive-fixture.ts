import { Prisma, type PrismaClient } from "@prisma/client";

const numbers = Array.from({ length: 205 }, (_, index) => index + 1);
const identities = numbers.map(n => `hld_pncrm${String(n).padStart(4, "0")}`);
const mappings = numbers.map(n => `pn-crm-map-${String(n).padStart(4, "0")}`);
const candidates = numbers.map(n => `dup_ccc02${String(n).padStart(20, "0")}`);
const sourceIds = numbers.map(n => `PN-HH-${String(n).padStart(4, "0")}`);

/** Uses the already validated owner and existing PN household fixtures; never creates real identities. */
export async function setupCrmProgressiveFixture(owner: PrismaClient): Promise<() => Promise<void>> {
  const target = await owner.$queryRaw<{ database_name: string; role_name: string; address: string }[]>`
    SELECT current_database() AS database_name, current_user AS role_name, inet_server_addr()::text AS address`;
  if (target[0]?.database_name !== "aoa_pagination_synthetic" || target[0]?.role_name !== "aoa" ||
    !["127.0.0.1/32", "127.0.0.1", "::1/128", "::1"].includes(target[0]?.address) ||
    process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE || ["prod", "dev"].includes(process.env.APP_ENV ?? "")) {
    throw new Error("crm_fixture_requires_isolated_loopback_database");
  }
  const [{ count }] = await owner.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS count FROM mirror.household WHERE sf_id IN (${Prisma.join(sourceIds)})
      AND name = 'PN Fixture Household ' || right(sf_id, 4)`);
  if (Number(count) !== 205) throw new Error("crm_fixture_requires_existing_synthetic_households");
  const [{ conflicts }] = await owner.$queryRaw<{ conflicts: bigint }[]>(Prisma.sql`
    SELECT (SELECT count(*) FROM app.crm_identity WHERE id IN (${Prisma.join(identities)})
      AND (identity_type <> 'HOUSEHOLD' OR first_seen_at IS DISTINCT FROM '2026-09-01'::timestamptz))
      + (SELECT count(*) FROM app.crm_source_mapping WHERE id IN (${Prisma.join(mappings)})
        AND (identity_id NOT IN (${Prisma.join(identities)}) OR source_key NOT IN (${Prisma.join(sourceIds)})))
      + (SELECT count(*) FROM app.crm_duplicate_candidate WHERE id IN (${Prisma.join(candidates)})
        AND (left_identity_id NOT IN (${Prisma.join(identities)}) OR right_identity_id NOT IN (${Prisma.join(identities)}))) AS conflicts`);
  if (Number(conflicts)) throw new Error("crm_fixture_id_collision");
  const cleanup = async () => {
    await owner.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id IN (${Prisma.join(candidates)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.crm_duplicate_candidate WHERE id IN (${Prisma.join(candidates)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.crm_identity_exception WHERE source_mapping_id IN (${Prisma.join(mappings)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.crm_source_mapping WHERE id IN (${Prisma.join(mappings)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM app.crm_identity WHERE id IN (${Prisma.join(identities)})`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM audit.row_change WHERE schema_name = 'app' AND (
        (table_name = 'crm_identity' AND row_pk IN (${Prisma.join(identities)})) OR
        (table_name = 'crm_source_mapping' AND row_pk IN (${Prisma.join(mappings)})) OR
        (table_name = 'crm_duplicate_candidate' AND row_pk IN (${Prisma.join(candidates)})))`);
    });
  };
  await cleanup();
  try {
    await owner.$transaction(async tx => {
      await tx.$executeRaw`
        INSERT INTO app.crm_identity (id, identity_type, first_seen_at, updated_at)
        SELECT 'hld_pncrm' || lpad(i::text, 4, '0'), 'HOUSEHOLD', '2026-09-01'::timestamptz, '2026-09-01'::timestamptz
        FROM generate_series(1, 205) i`;
      await tx.$executeRaw`
        INSERT INTO app.crm_source_mapping (id, identity_id, source_system, source_namespace, source_key, updated_at)
        SELECT 'pn-crm-map-' || lpad(i::text, 4, '0'), 'hld_pncrm' || lpad(i::text, 4, '0'),
          'CRM', 'household', 'PN-HH-' || lpad(i::text, 4, '0'), '2026-09-01'::timestamptz
        FROM generate_series(1, 205) i`;
      // A ring supplies205 distinct sorted pairs from205 identities without an
      // extra uncounted registry identity. No resolution/canonicalization writes.
      await tx.$executeRaw`
        INSERT INTO app.crm_duplicate_candidate (id, detector_key, entity_type,
          left_identity_id, right_identity_id, evidence_codes, detected_at, updated_at)
        SELECT 'dup_ccc02' || lpad(i::text, 20, '0'), 'cc02' || lpad(i::text, 60, '0'), 'HOUSEHOLD',
          'hld_pncrm' || lpad(least(i, 1 + (i % 205))::text, 4, '0'),
          'hld_pncrm' || lpad(greatest(i, 1 + (i % 205))::text, 4, '0'),
          ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], '2026-09-01'::timestamptz, '2026-09-01'::timestamptz
        FROM generate_series(1, 205) i`;
    });
  } catch (error) { await cleanup(); throw error; }
  return cleanup;
}
