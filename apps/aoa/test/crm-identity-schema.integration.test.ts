import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { withIngestScope } from "@/lib/ingest/scope";

// The database CI job already sets AUDIT_TEST_DB_URL and applies every
// migration before running this suite. Reuse that gate/cleanup connection so
// the identity schema is exercised in the same real PostgreSQL persona matrix
// as the repository's audit guardrail.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;

const ID = "con_phaseoneidentity";
const MAP_ID = "phaseonemapping";
const EXCEPTION_ID = "phaseoneexception";
const SENSITIVE_SOURCE_KEY = "TEST-FULL-ACCOUNT-123456789";

function makeCleanupClient(): PrismaClient {
  const url =
    process.env.AUDIT_TEST_CLEANUP_URL ??
    `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa`;
  return new PrismaClient({ datasources: { db: { url } } });
}

async function cleanup(db: PrismaClient): Promise<void> {
  await db.$executeRaw`DELETE FROM app.crm_identity_exception WHERE id LIKE 'phaseone%'`;
  await db.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'phaseone%'`;
  await db.$executeRaw`
    DELETE FROM app.crm_identity
     WHERE id LIKE 'con_phaseone%' OR id LIKE 'hld_phaseone%'`;
  await db.$executeRaw`
    DELETE FROM audit.row_change
     WHERE row_pk LIKE 'phaseone%'
        OR row_pk LIKE 'con_phaseone%'
        OR row_pk LIKE 'hld_phaseone%'`;
}

async function seedIdentityAndMapping(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, updated_at)
    VALUES
      (${ID}, 'CONTACT', 'ACTIVE', now())`;
  await db.$executeRaw`
    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    VALUES
      (${MAP_ID}, ${ID}, 'CRM', 'contact', ${SENSITIVE_SOURCE_KEY}, now())`;
}

gated("CRM Phase 1 identity schema", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = makeCleanupClient();
  });
  beforeEach(async () => {
    await cleanup(owner);
    await seedIdentityAndMapping(owner);
  });
  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
  });

  it("keeps source-invisible mappings fail-closed for all five human roles", async () => {
    for (const role of [
      "ADMIN",
      "OPERATIONS",
      "ADVISOR",
      "CLIENT_SERVICE",
      "VIEWER",
    ]) {
      await expect(
        withUserScope({ role, email: "phase-one@example.test" }, (tx) =>
          tx.$queryRaw`SELECT id FROM app.crm_identity WHERE id = ${ID}`,
        ),
      ).resolves.toEqual([]);

      await expect(
        withUserScope({ role, email: "phase-one@example.test" }, (tx) =>
          tx.$executeRaw`
            INSERT INTO app.crm_identity
              (id, identity_type, lifecycle_state, updated_at)
            VALUES ('con_phaseone_runtime_write', 'CONTACT', 'ACTIVE', now())`,
        ),
      ).rejects.toThrow();
    }
  });

  it("keeps ingest_rw dark instead of weakening the mirror-only boundary", async () => {
    await expect(
      withIngestScope((tx) =>
        tx.$queryRaw`SELECT id FROM app.crm_identity LIMIT 1`,
      ),
    ).rejects.toThrow();
  });

  it("allows the migration owner to manage the dark schema", async () => {
    const rows = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM app.crm_identity WHERE id = ${ID}`;
    expect(rows).toEqual([{ id: ID }]);
  });

  it("makes one source coordinate idempotent but allows the same raw key in another namespace", async () => {
    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_source_mapping
          (id, identity_id, source_system, source_namespace, source_key, updated_at)
        VALUES
          ('phaseonemappingduplicate', ${ID}, 'CRM', 'contact', ${SENSITIVE_SOURCE_KEY}, now())`,
    ).rejects.toThrow();

    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_source_mapping
          (id, identity_id, source_system, source_namespace, source_key, updated_at)
        VALUES
          ('phaseonemappingothernamespace', ${ID}, 'CRM', 'prospect_contact', ${SENSITIVE_SOURCE_KEY}, now())`,
    ).resolves.toBe(1);
  });

  it("rejects an identity whose type and public-ID prefix disagree", async () => {
    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_identity
          (id, identity_type, lifecycle_state, updated_at)
        VALUES
          ('hld_phaseonewrongtype', 'CONTACT', 'ACTIVE', now())`,
    ).rejects.toThrow();
  });

  it("rejects cross-type merges and indirect merge cycles", async () => {
    await owner.$executeRaw`
      INSERT INTO app.crm_identity
        (id, identity_type, lifecycle_state, updated_at)
      VALUES
        ('con_phaseonemergeb', 'CONTACT', 'ACTIVE', now()),
        ('con_phaseonemergec', 'CONTACT', 'ACTIVE', now()),
        ('hld_phaseonemergehousehold', 'HOUSEHOLD', 'ACTIVE', now())`;

    await expect(
      owner.$executeRaw`
        UPDATE app.crm_identity
           SET lifecycle_state = 'MERGED',
               merged_into_id = 'hld_phaseonemergehousehold',
               updated_at = now()
         WHERE id = ${ID}`,
    ).rejects.toThrow();

    await owner.$executeRaw`
      UPDATE app.crm_identity
         SET lifecycle_state = 'MERGED',
             merged_into_id = 'con_phaseonemergeb',
             updated_at = now()
       WHERE id = ${ID}`;
    await owner.$executeRaw`
      UPDATE app.crm_identity
         SET lifecycle_state = 'MERGED',
             merged_into_id = 'con_phaseonemergec',
             updated_at = now()
       WHERE id = 'con_phaseonemergeb'`;

    await expect(
      owner.$executeRaw`
        UPDATE app.crm_identity
           SET lifecycle_state = 'MERGED',
               merged_into_id = ${ID},
               updated_at = now()
         WHERE id = 'con_phaseonemergec'`,
    ).rejects.toThrow();
  });

  it("preserves a source re-key as a new alias instead of rewriting history", async () => {
    await expect(
      owner.$executeRaw`
        UPDATE app.crm_source_mapping
           SET source_key = 'REKEYED-IN-PLACE', updated_at = now()
         WHERE id = ${MAP_ID}`,
    ).rejects.toThrow();

    await owner.$executeRaw`
      UPDATE app.crm_source_mapping
         SET mapping_state = 'SUPERSEDED', superseded_at = now(), updated_at = now()
       WHERE id = ${MAP_ID}`;
    await owner.$executeRaw`
      INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES
        ('phaseonemappingrekeyed', ${ID}, 'CRM', 'contact', 'REKEYED-ALIAS', now())`;

    const mappings = await owner.$queryRaw<
      Array<{ identity_id: string; mapping_state: string }>
    >`
      SELECT identity_id, mapping_state
        FROM app.crm_source_mapping
       WHERE id IN (${MAP_ID}, 'phaseonemappingrekeyed')
       ORDER BY id`;
    expect(mappings).toEqual([
      { identity_id: ID, mapping_state: "SUPERSEDED" },
      { identity_id: ID, mapping_state: "ACTIVE" },
    ]);
  });

  it("requires coded, internally consistent unresolved exceptions", async () => {
    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_identity_exception
          (id, source_mapping_id, reason_code, exception_state, resolution_code, updated_at)
        VALUES
          (${EXCEPTION_ID}, ${MAP_ID}, 'FREE_TEXT_REASON', 'OPEN', NULL, now())`,
    ).rejects.toThrow();

    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_identity_exception
          (id, source_mapping_id, reason_code, exception_state, resolution_code, updated_at)
        VALUES
          (${EXCEPTION_ID}, ${MAP_ID}, 'MISSING_PARENT_MAPPING', 'OPEN', 'MANUAL_LINK', now())`,
    ).rejects.toThrow();

    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_identity_exception
          (id, source_mapping_id, reason_code, exception_state, updated_at)
        VALUES
          (${EXCEPTION_ID}, ${MAP_ID}, 'MISSING_PARENT_MAPPING', 'OPEN', now())`,
    ).resolves.toBe(1);
  });

  it("never copies the sensitive source key into the audit trail", async () => {
    const rows = await owner.$queryRaw<Array<{ changed: unknown }>>`
      SELECT changed
        FROM audit.row_change
       WHERE table_name = 'crm_source_mapping'
         AND row_pk = ${MAP_ID}
         AND op = 'INSERT'`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].changed)).not.toContain(SENSITIVE_SOURCE_KEY);
    expect(rows[0].changed).toMatchObject({
      id: MAP_ID,
      identity_id: ID,
      source_system: "CRM",
      source_namespace: "contact",
      mapping_state: "ACTIVE",
    });
  });

  it("does not create audit noise for last-seen-only updates", async () => {
    await owner.$executeRaw`
      UPDATE app.crm_source_mapping
         SET last_seen_at = last_seen_at + interval '1 second',
             updated_at = updated_at + interval '1 second'
       WHERE id = ${MAP_ID}`;
    const rows = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
        FROM audit.row_change
       WHERE table_name = 'crm_source_mapping'
         AND row_pk = ${MAP_ID}
         AND op = 'UPDATE'`;
    expect(Number(rows[0].n)).toBe(0);
  });
});
