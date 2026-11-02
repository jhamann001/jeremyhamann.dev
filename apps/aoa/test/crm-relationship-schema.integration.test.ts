import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import { withIngestScope } from "@/lib/ingest/scope";

const gated =
  process.env.AUDIT_TEST_DB_URL && process.env.CRM_RECONCILER_DATABASE_URL
    ? describe
    : describe.skip;

const HOUSEHOLD_ID = "hld_phasefourhousehold";
const CONTACT_ID = "con_phasefourcontact";
const DEAL_ID = "dea_phasefourdeal";
const TRANSFER_ID = "xfr_phasefourtransfer";
const HOUSEHOLD_MAP = "phasefourhouseholdmap";
const CONTACT_MAP = "phasefourcontactmap";
const DEAL_MAP = "phasefourdealmap";
const TRANSFER_MAP = "phasefourtransfermap";
const RELATIONSHIP_ID = "rel_phasefourmember";
const SENSITIVE_SOURCE_KEY = "TEST-PHASE-FOUR-SOURCE-123456789";

function ownerClient(): PrismaClient {
  const url =
    process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

function reconcilerClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.CRM_RECONCILER_DATABASE_URL! });
}

async function cleanup(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    DELETE FROM app.crm_relationship WHERE id LIKE 'rel_phasefour%'`;
  await db.$executeRaw`
    DELETE FROM app.crm_source_mapping WHERE id LIKE 'phasefour%'`;
  await db.$executeRaw`
    DELETE FROM app.crm_identity
     WHERE id IN (${HOUSEHOLD_ID}, ${CONTACT_ID}, ${DEAL_ID}, ${TRANSFER_ID})`;
  await db.$executeRaw`
    DELETE FROM audit.row_change
     WHERE row_pk LIKE 'rel_phasefour%'
        OR row_pk LIKE 'phasefour%'
        OR row_pk IN (${HOUSEHOLD_ID}, ${CONTACT_ID}, ${DEAL_ID}, ${TRANSFER_ID})`;
}

async function seed(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, updated_at)
    VALUES
      (${HOUSEHOLD_ID}, 'HOUSEHOLD', 'ACTIVE', now()),
      (${CONTACT_ID}, 'CONTACT', 'ACTIVE', now()),
      (${DEAL_ID}, 'DEAL', 'ACTIVE', now()),
      (${TRANSFER_ID}, 'TRANSFER', 'ACTIVE', now())`;

  await db.$executeRaw`
    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    VALUES
      (${HOUSEHOLD_MAP}, ${HOUSEHOLD_ID}, 'CRM', 'household', '001PHASEFOURAAA', now()),
      (${CONTACT_MAP}, ${CONTACT_ID}, 'CRM', 'contact', ${SENSITIVE_SOURCE_KEY}, now()),
      (${DEAL_MAP}, ${DEAL_ID}, 'AOA', 'deal', 'phase-four-deal', now()),
      (${TRANSFER_MAP}, ${TRANSFER_ID}, 'AOA', 'transfer', 'phase-four-transfer', now())`;
}

async function insertMembership(db: PrismaClient, id = RELATIONSHIP_ID): Promise<void> {
  await db.$executeRaw`
    INSERT INTO app.crm_relationship
      (id, relationship_type, from_identity_id, to_identity_id,
       evidence_mapping_id, relationship_state, updated_at)
    VALUES
      (${id}, 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_ID}, ${CONTACT_ID},
       ${CONTACT_MAP}, 'ACTIVE', now())`;
}

gated("CRM relationship schema security", () => {
  let owner: PrismaClient;
  let reconciler: PrismaClient;

  beforeAll(() => {
    owner = ownerClient();
    reconciler = reconcilerClient();
  });
  beforeEach(async () => {
    await cleanup(owner);
    await seed(owner);
  });
  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
    await reconciler.$disconnect();
  });

  it("allows only ADMIN and OPERATIONS reads while keeping all human writes denied", async () => {
    await insertMembership(owner);

    for (const role of ["ADMIN", "OPERATIONS"]) {
      await expect(
        withUserScope({ role, email: "phase-four@example.test" }, (tx) =>
          tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM app.crm_relationship WHERE id = ${RELATIONSHIP_ID}`,
        ),
      ).resolves.toEqual([{ id: RELATIONSHIP_ID }]);
    }

    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      await expect(
        withUserScope({ role, email: "phase-four@example.test" }, (tx) =>
          tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM app.crm_relationship WHERE id = ${RELATIONSHIP_ID}`,
        ),
      ).resolves.toEqual([]);
    }

    for (const role of [
      "ADMIN",
      "OPERATIONS",
      "ADVISOR",
      "CLIENT_SERVICE",
      "VIEWER",
    ]) {
      await expect(
        withUserScope({ role, email: "phase-four@example.test" }, (tx) =>
          tx.$executeRaw`
            INSERT INTO app.crm_relationship
              (id, relationship_type, from_identity_id, to_identity_id,
               evidence_mapping_id, relationship_state, updated_at)
            VALUES
              ('rel_phasefourruntime', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_ID},
               ${CONTACT_ID}, ${CONTACT_MAP}, 'ACTIVE', now())`,
        ),
      ).rejects.toThrow();
    }
  });

  it("keeps ingest and the Phase 3 identity reconciler dark", async () => {
    await expect(
      withIngestScope((tx) =>
        tx.$queryRaw`SELECT id FROM app.crm_relationship LIMIT 1`,
      ),
    ).rejects.toThrow();
    await expect(
      reconciler.$queryRaw`SELECT id FROM app.crm_relationship LIMIT 1`,
    ).rejects.toThrow();
    await expect(
      reconciler.$executeRaw`
        INSERT INTO app.crm_relationship
          (id, relationship_type, from_identity_id, to_identity_id,
           evidence_mapping_id, relationship_state, updated_at)
        VALUES
          ('rel_phasefourmachine', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_ID},
           ${CONTACT_ID}, ${CONTACT_MAP}, 'ACTIVE', now())`,
    ).rejects.toThrow();
  });

  it("allows the migration owner to create each reviewed exact relationship", async () => {
    await insertMembership(owner);
    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_relationship
          (id, relationship_type, from_identity_id, to_identity_id,
           evidence_mapping_id, relationship_state, updated_at)
        VALUES
          ('rel_phasefourdeal', 'DEAL_FOR_HOUSEHOLD', ${DEAL_ID}, ${HOUSEHOLD_ID},
           ${DEAL_MAP}, 'ACTIVE', now()),
          ('rel_phasefourtransfer', 'TRANSFER_FOR_HOUSEHOLD', ${TRANSFER_ID},
           ${HOUSEHOLD_ID}, ${TRANSFER_MAP}, 'ACTIVE', now())`,
    ).resolves.toBe(2);
  });

  it("rejects wrong endpoint direction and mismatched evidence", async () => {
    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_relationship
          (id, relationship_type, from_identity_id, to_identity_id,
           evidence_mapping_id, relationship_state, updated_at)
        VALUES
          ('rel_phasefourwrongdirection', 'HOUSEHOLD_HAS_MEMBER', ${CONTACT_ID},
           ${HOUSEHOLD_ID}, ${CONTACT_MAP}, 'ACTIVE', now())`,
    ).rejects.toThrow();

    await expect(
      owner.$executeRaw`
        INSERT INTO app.crm_relationship
          (id, relationship_type, from_identity_id, to_identity_id,
           evidence_mapping_id, relationship_state, updated_at)
        VALUES
          ('rel_phasefourwrongevidence', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_ID},
           ${CONTACT_ID}, ${HOUSEHOLD_MAP}, 'ACTIVE', now())`,
    ).rejects.toThrow();
  });

  it("requires active endpoint identities and evidence mappings", async () => {
    await owner.$executeRaw`
      UPDATE app.crm_source_mapping
         SET mapping_state = 'SUPERSEDED', superseded_at = now(), updated_at = now()
       WHERE id = ${CONTACT_MAP}`;
    await expect(insertMembership(owner)).rejects.toThrow();

    await owner.$executeRaw`
      UPDATE app.crm_source_mapping
         SET mapping_state = 'ACTIVE', superseded_at = NULL, updated_at = now()
       WHERE id = ${CONTACT_MAP}`;
    await owner.$executeRaw`
      UPDATE app.crm_identity
         SET lifecycle_state = 'ARCHIVED', updated_at = now()
       WHERE id = ${CONTACT_ID}`;
    await expect(insertMembership(owner)).rejects.toThrow();
  });

  it("keeps the evidence coordinate idempotent and immutable", async () => {
    await insertMembership(owner);
    await expect(
      insertMembership(owner, "rel_phasefourduplicate"),
    ).rejects.toThrow();
    await expect(
      owner.$executeRaw`
        UPDATE app.crm_relationship
           SET evidence_mapping_id = ${HOUSEHOLD_MAP}, updated_at = now()
         WHERE id = ${RELATIONSHIP_ID}`,
    ).rejects.toThrow();
  });

  it("enforces inactive lifecycle timestamps", async () => {
    await insertMembership(owner);
    await expect(
      owner.$executeRaw`
        UPDATE app.crm_relationship
           SET relationship_state = 'INACTIVE', updated_at = now()
         WHERE id = ${RELATIONSHIP_ID}`,
    ).rejects.toThrow();
    await expect(
      owner.$executeRaw`
        UPDATE app.crm_relationship
           SET relationship_state = 'INACTIVE', inactivated_at = now(), updated_at = now()
         WHERE id = ${RELATIONSHIP_ID}`,
    ).resolves.toBe(1);
  });

  it("audits controlled relationship IDs without copying raw source keys", async () => {
    await insertMembership(owner);
    const rows = await owner.$queryRaw<Array<{ changed: unknown }>>`
      SELECT changed
        FROM audit.row_change
       WHERE table_name = 'crm_relationship'
         AND row_pk = ${RELATIONSHIP_ID}
         AND op = 'INSERT'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].changed).toMatchObject({
      id: RELATIONSHIP_ID,
      relationship_type: "HOUSEHOLD_HAS_MEMBER",
      from_identity_id: HOUSEHOLD_ID,
      to_identity_id: CONTACT_ID,
      evidence_mapping_id: CONTACT_MAP,
    });
    expect(JSON.stringify(rows[0].changed)).not.toContain(SENSITIVE_SOURCE_KEY);
  });
});
