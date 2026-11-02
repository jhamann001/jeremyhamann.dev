import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { getCrmRelationshipTraversal } from "@/lib/data/crm-relationships";
import { getCrmIdentitySummaries } from "@/lib/data/crm-explorer";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;

const HOUSEHOLD_ONE_KEY = "001170837395544AAA";
const HOUSEHOLD_TWO_KEY = "001332649221008AAA";
const CONTACT_ONE_KEY = "003170837395544AAA";
const CONTACT_TWO_KEY = "003332649221008AAA";
const DEAL_KEY = "phase-four-d-deal";
const TRANSFER_KEY = "phase-four-d-transfer";

const HOUSEHOLD_ONE = "hld_phasefourdhouseholdone";
const HOUSEHOLD_TWO = "hld_phasefourdhouseholdtwo";
const CONTACT_ONE = "con_phasefourdcontactone";
const CONTACT_TWO = "con_phasefourdcontacttwo";
const DEAL = "dea_phasefourdintegration";
const TRANSFER = "xfr_phasefourdintegration";

const HOUSEHOLD_ONE_MAP = "phasefourdhouseholdonemap";
const HOUSEHOLD_TWO_MAP = "phasefourdhouseholdtwomap";
const CONTACT_ONE_MAP = "phasefourdcontactonemap";
const CONTACT_TWO_MAP = "phasefourdcontacttwomap";
const DEAL_MAP = "phasefourdintegrationdealmap";
const TRANSFER_MAP = "phasefourdintegrationtransfermap";

const ACTIVE_RELATIONSHIPS = [
  "rel_phasefourdhonecone",
  "rel_phasefourdhonectwo",
  "rel_phasefourdhtwocone",
  "rel_phasefourdhtwoctwo",
  "rel_phasefourddeal",
  "rel_phasefourdtransfer",
] as const;
const INACTIVE_RELATIONSHIP = "rel_phasefourdinactive";

const OPS = { role: "OPERATIONS", email: "phase-four-d-ops@example.test" };

function ownerClient(): PrismaClient {
  const url = process.env.AUDIT_TEST_CLEANUP_URL
    ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/aoa?schema=app`;
  return new PrismaClient({ datasourceUrl: url });
}

async function cleanup(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    DELETE FROM app.crm_relationship
     WHERE id IN (${Prisma.join([...ACTIVE_RELATIONSHIPS, INACTIVE_RELATIONSHIP])})`;
  await db.$executeRaw`
    DELETE FROM app.crm_source_mapping
     WHERE id IN (${Prisma.join([
       HOUSEHOLD_ONE_MAP,
       HOUSEHOLD_TWO_MAP,
       CONTACT_ONE_MAP,
       CONTACT_TWO_MAP,
       DEAL_MAP,
       TRANSFER_MAP,
     ])})`;
  await db.$executeRaw`
    DELETE FROM app.crm_identity
     WHERE id IN (${Prisma.join([
       HOUSEHOLD_ONE,
       HOUSEHOLD_TWO,
       CONTACT_ONE,
       CONTACT_TWO,
       DEAL,
       TRANSFER,
     ])})`;
  await db.$executeRaw`DELETE FROM app.transfer WHERE id = ${TRANSFER_KEY}`;
  await db.$executeRaw`DELETE FROM app.deal WHERE id = ${DEAL_KEY}`;
  await db.$executeRaw`
    DELETE FROM mirror.client WHERE sf_id IN (${CONTACT_ONE_KEY}, ${CONTACT_TWO_KEY})`;
  await db.$executeRaw`
    DELETE FROM mirror.household
     WHERE sf_id IN (${HOUSEHOLD_ONE_KEY}, ${HOUSEHOLD_TWO_KEY})`;
  await db.$executeRaw`
    DELETE FROM audit.row_change
     WHERE row_pk IN (${Prisma.join([
       ...ACTIVE_RELATIONSHIPS,
       INACTIVE_RELATIONSHIP,
       HOUSEHOLD_ONE_MAP,
       HOUSEHOLD_TWO_MAP,
       CONTACT_ONE_MAP,
       CONTACT_TWO_MAP,
       DEAL_MAP,
       TRANSFER_MAP,
       HOUSEHOLD_ONE,
       HOUSEHOLD_TWO,
       CONTACT_ONE,
       CONTACT_TWO,
       DEAL,
       TRANSFER,
       DEAL_KEY,
       TRANSFER_KEY,
     ])})`;
}

async function seed(db: PrismaClient): Promise<void> {
  await db.$executeRaw`
    INSERT INTO mirror.household (sf_id, name, lead_advisor_email, synced_at)
    VALUES
      (${HOUSEHOLD_ONE_KEY}, 'Phase Four D One', ${OPS.email}, now()),
      (${HOUSEHOLD_TWO_KEY}, 'Phase Four D Two', ${OPS.email}, now())`;
  await db.$executeRaw`
    INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, lead_advisor_email, synced_at)
    VALUES
      (${CONTACT_ONE_KEY}, ${HOUSEHOLD_ONE_KEY}, 'Phase', 'One', ${OPS.email}, now()),
      (${CONTACT_TWO_KEY}, ${HOUSEHOLD_TWO_KEY}, 'Phase', 'Two', ${OPS.email}, now())`;
  await db.$executeRaw`
    INSERT INTO app.deal
      (id, source, name, client_first_name, client_last_name,
       household_sf_id, amount, stage, created_date, updated_at)
    VALUES
      (${DEAL_KEY}, 'APP', 'Phase Four D Deal', 'Phase', 'Four',
       ${HOUSEHOLD_ONE_KEY}, 1000, 'COMMITTED', '2026-08-07', now())`;
  await db.$executeRaw`
    INSERT INTO app.transfer
      (id, source, client_first_name, client_last_name,
       household_sf_id, value, stage, owner_kind, updated_at)
    VALUES
      (${TRANSFER_KEY}, 'APP', 'Phase', 'Four', ${HOUSEHOLD_ONE_KEY},
       1000, 'DECISION', 'OPERATIONS', now())`;

  await db.$executeRaw`
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, updated_at)
    VALUES
      (${HOUSEHOLD_ONE}, 'HOUSEHOLD', 'ACTIVE', now()),
      (${HOUSEHOLD_TWO}, 'HOUSEHOLD', 'ACTIVE', now()),
      (${CONTACT_ONE}, 'CONTACT', 'ACTIVE', now()),
      (${CONTACT_TWO}, 'CONTACT', 'ACTIVE', now()),
      (${DEAL}, 'DEAL', 'ACTIVE', now()),
      (${TRANSFER}, 'TRANSFER', 'ACTIVE', now())`;
  await db.$executeRaw`
    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    VALUES
      (${HOUSEHOLD_ONE_MAP}, ${HOUSEHOLD_ONE}, 'CRM', 'household',
       ${HOUSEHOLD_ONE_KEY}, now()),
      (${HOUSEHOLD_TWO_MAP}, ${HOUSEHOLD_TWO}, 'CRM', 'household',
       ${HOUSEHOLD_TWO_KEY}, now()),
      (${CONTACT_ONE_MAP}, ${CONTACT_ONE}, 'CRM', 'contact',
       ${CONTACT_ONE_KEY}, now()),
      (${CONTACT_TWO_MAP}, ${CONTACT_TWO}, 'CRM', 'contact',
       ${CONTACT_TWO_KEY}, now()),
      (${DEAL_MAP}, ${DEAL}, 'AOA', 'deal', ${DEAL_KEY}, now()),
      (${TRANSFER_MAP}, ${TRANSFER}, 'AOA', 'transfer', ${TRANSFER_KEY}, now())`;

  await db.$executeRaw`
    INSERT INTO app.crm_relationship
      (id, relationship_type, from_identity_id, to_identity_id,
       evidence_mapping_id, relationship_state, inactivated_at, updated_at)
    VALUES
      ('rel_phasefourdhonecone', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_ONE},
       ${CONTACT_ONE}, ${CONTACT_ONE_MAP}, 'ACTIVE', NULL, now()),
      ('rel_phasefourdhonectwo', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_ONE},
       ${CONTACT_TWO}, ${CONTACT_TWO_MAP}, 'ACTIVE', NULL, now()),
      ('rel_phasefourdhtwocone', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_TWO},
       ${CONTACT_ONE}, ${CONTACT_ONE_MAP}, 'ACTIVE', NULL, now()),
      ('rel_phasefourdhtwoctwo', 'HOUSEHOLD_HAS_MEMBER', ${HOUSEHOLD_TWO},
       ${CONTACT_TWO}, ${CONTACT_TWO_MAP}, 'ACTIVE', NULL, now()),
      ('rel_phasefourddeal', 'DEAL_FOR_HOUSEHOLD', ${DEAL}, ${HOUSEHOLD_ONE},
       ${DEAL_MAP}, 'ACTIVE', NULL, now()),
      ('rel_phasefourdtransfer', 'TRANSFER_FOR_HOUSEHOLD', ${TRANSFER},
       ${HOUSEHOLD_ONE}, ${TRANSFER_MAP}, 'ACTIVE', NULL, now()),
      (${INACTIVE_RELATIONSHIP}, 'DEAL_FOR_HOUSEHOLD', ${DEAL}, ${HOUSEHOLD_TWO},
       ${DEAL_MAP}, 'INACTIVE', now(), now())`;
}

gated("CRM Phase 4D bounded relationship reads", () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = ownerClient();
  });
  beforeEach(async () => {
    process.env.CRM_RELATIONSHIPS = "1";
    process.env.CRM_IDENTITY_READS = "1";
    await cleanup(owner);
    await seed(owner);
  });
  afterEach(() => {
    delete process.env.CRM_RELATIONSHIPS;
    delete process.env.CRM_IDENTITY_READS;
  });
  afterAll(async () => {
    await cleanup(owner);
    await owner.$disconnect();
  });

  it("traverses a cyclic graph once per edge with deterministic bounded output", async () => {
    const result = await getCrmRelationshipTraversal(OPS, DEAL, { maxDepth: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows).toHaveLength(ACTIVE_RELATIONSHIPS.length);
    expect(new Set(result.rows.map((row) => row.relationshipId)).size).toBe(
      ACTIVE_RELATIONSHIPS.length,
    );
    expect(result.rows.every((row) => row.depth >= 1 && row.depth <= 4)).toBe(true);
    expect(result.rows.map((row) => row.relationshipId)).not.toContain(
      INACTIVE_RELATIONSHIP,
    );
    expect(result.rows[0]).toMatchObject({
      relationshipId: "rel_phasefourddeal",
      parentIdentityId: DEAL,
      endpointIdentityId: HOUSEHOLD_ONE,
      direction: "OUTGOING",
      depth: 1,
    });

    const coordinates = result.rows.map((row) => [
      row.depth,
      row.relationshipType,
      row.relationshipId,
      row.endpointIdentityId,
    ].join("|"));
    expect(coordinates).toEqual([...coordinates].sort((left, right) => {
      const [leftDepth, ...leftRest] = left.split("|");
      const [rightDepth, ...rightRest] = right.split("|");
      return Number(leftDepth) - Number(rightDepth)
        || leftRest.join("|").localeCompare(rightRest.join("|"));
    }));
    expect(Object.keys(result.rows[0]).sort()).toEqual([
      "depth",
      "direction",
      "endpointIdentityId",
      "endpointIdentityType",
      "fromIdentityId",
      "parentIdentityId",
      "relationshipId",
      "relationshipType",
      "toIdentityId",
    ]);
  });

  it("honors requested depth and the reviewed relationship-type filter", async () => {
    const direct = await getCrmRelationshipTraversal(OPS, HOUSEHOLD_ONE, {
      maxDepth: 1,
      relationshipTypes: ["HOUSEHOLD_HAS_MEMBER"],
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.rows.map((row) => row.relationshipId)).toEqual([
      "rel_phasefourdhonecone",
      "rel_phasefourdhonectwo",
    ]);
    expect(direct.rows.every((row) => row.depth === 1)).toBe(true);
  });

  it("resolves graph labels without returning raw source aliases", async () => {
    const result = await getCrmIdentitySummaries(OPS, [HOUSEHOLD_ONE, CONTACT_ONE, DEAL]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows).toEqual([
      expect.objectContaining({
        id: HOUSEHOLD_ONE,
        identityType: "HOUSEHOLD",
        displayName: "Phase Four D One",
      }),
      expect.objectContaining({
        id: CONTACT_ONE,
        identityType: "CONTACT",
        displayName: "Phase One",
      }),
      expect.objectContaining({
        id: DEAL,
        identityType: "DEAL",
        displayName: "Phase Four D Deal",
      }),
    ]);
    expect(Object.keys(result.rows[0]).sort()).toEqual([
      "displayName",
      "href",
      "id",
      "identityType",
    ]);
  });

  it("filters relationships whose endpoint is no longer an active canonical identity", async () => {
    await owner.$executeRaw`
      UPDATE app.crm_identity
         SET lifecycle_state = 'ARCHIVED', updated_at = now()
       WHERE id = ${CONTACT_ONE}`;

    const result = await getCrmRelationshipTraversal(OPS, HOUSEHOLD_ONE, {
      maxDepth: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.endpointIdentityId)).not.toContain(CONTACT_ONE);
    expect(result.rows.map((row) => row.relationshipId)).not.toContain(
      "rel_phasefourdhonecone",
    );
  });

  it("enforces the database role policy independently of the TypeScript gate", async () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      await expect(withUserScope({ role, email: OPS.email }, (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM app.crm_relationship
           WHERE id = 'rel_phasefourddeal'`,
      )).resolves.toEqual([{ id: "rel_phasefourddeal" }]);
    }

    await expect(withUserScope(OPS, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM app.crm_relationship
         WHERE id = ${INACTIVE_RELATIONSHIP}`,
    )).resolves.toEqual([]);
    await expect(withUserScope(OPS, (tx) =>
      tx.$queryRaw`
        SELECT evidence_mapping_id FROM app.crm_relationship
         WHERE id = 'rel_phasefourddeal'`,
    )).rejects.toThrow();

    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      await expect(withUserScope({ role, email: OPS.email }, (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM app.crm_relationship
           WHERE id = 'rel_phasefourddeal'`,
      )).resolves.toEqual([]);
      await expect(getCrmRelationshipTraversal(
        { role, email: OPS.email },
        DEAL,
      )).resolves.toEqual({ ok: false, reason: "forbidden" });
    }
  });
});
