import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

import { searchCrmRelationshipHouseholds } from "@/lib/data/crm-relationship-workspace";
import { getCrmIdentitySummaries } from "@/lib/data/crm-explorer";
import { householdHeader } from "@/lib/data/households";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "relationships-216@example.test" };
const sfId = (n: number) => `001R216${String(n).padStart(8, "0")}AAA`;
const identityId = (n: number) => `hld_r216${n}`;
const duplicateId = `dup_c${"216216".padStart(24, "0")}`;

gated("Relationships household/member search under PostgreSQL RLS", () => {
  let owner: PrismaClient;

  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id = ${duplicateId}`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id = ${duplicateId}`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'r216-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_r216%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003R216%' OR sf_id LIKE '001R216%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001R216%'`;
    await owner.$executeRaw`
      DELETE FROM audit.row_change
       WHERE row_pk LIKE 'r216-map-%' OR row_pk LIKE 'hld_r216%' OR row_pk = ${duplicateId}`;
  }

  async function seedHouseholds(rows: Array<[number, string]>) {
    await owner.$executeRaw(Prisma.sql`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES ${Prisma.join(rows.map(([n, name]) => Prisma.sql`(${sfId(n)}, ${name}, ${OPS.email})`))}`);
    await owner.$executeRaw(Prisma.sql`
      INSERT INTO app.crm_identity (id, identity_type, updated_at)
      VALUES ${Prisma.join(rows.map(([n]) => Prisma.sql`(${identityId(n)}, 'HOUSEHOLD', now())`))}`);
    await owner.$executeRaw(Prisma.sql`
      INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES ${Prisma.join(rows.map(([n]) => Prisma.sql`
        (${"r216-map-" + n}, ${identityId(n)}, 'CRM', 'household', ${sfId(n)}, now())`))}`);
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error("Relationships search tests require an explicit loopback cleanup database");
    }
    owner = new PrismaClient({ datasourceUrl: url });
    await cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("CRM_RELATIONSHIPS", "1");
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    await seedHouseholds([
      [1, "Abbigail & Marion Jones Household"], [2, "Historic household alias"], [3, "Abbigail Jones Household"],
      [4, "de la Boehm Household"], [5, "Literal 50%_\\ source"],
      [6, "Bogan Household"], [7, "Blanda Household"],
    ]);
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES
        ('003G98686314123AAA', ${sfId(1)}, 'Abbigail', 'Jones', ${OPS.email}),
        ('003N73192365990AAA', ${sfId(2)}, 'Marion', 'Jones', ${OPS.email}),
        ('003R00078969359AAA', ${sfId(3)}, 'Abbigail', 'Jones', ${OPS.email}),
        ('003Q42575849289AAA', ${sfId(4)}, 'Ana', 'de la Boehm', ${OPS.email}),
        (${sfId(1)}, ${sfId(1)}, 'Placeholderneedle', 'Retired', ${OPS.email})`;
    await owner.$executeRaw`
      INSERT INTO app.crm_duplicate_candidate
        (id, detector_key, entity_type, left_identity_id, right_identity_id,
         evidence_codes, status, canonical_identity_id, updated_at)
      VALUES (${duplicateId}, ${"216216".padStart(64, "0")}, 'HOUSEHOLD',
        ${identityId(1)}, ${identityId(2)}, ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],
        'READY_FOR_FOLLOW_UP', ${identityId(1)}, now())`;
    await owner.$executeRaw`
      UPDATE app.crm_source_mapping SET mapping_state = 'SUPERSEDED', superseded_at = now()
       WHERE id = 'r216-map-6'`;
    await owner.$executeRaw`
      UPDATE app.crm_identity SET lifecycle_state = 'ARCHIVED' WHERE id = ${identityId(7)}`;
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
  });

  it("finds a member on a suppressed source and returns only the surviving household route", async () => {
    for (const query of ["Marion", "marion jones", "Historic household alias"]) {
      const result = await searchCrmRelationshipHouseholds(OPS, query);
      expect(result).toMatchObject({ ok: true, rows: [{ identityId: identityId(1), crmId: sfId(1) }] });
      if (!result.ok) throw new Error("search_failed");
      expect(result.rows).toHaveLength(1);
    }
  });

  it("matches first/full/compound names and keeps distinct similarly named households", async () => {
    for (const query of ["Abbigail", "abbigail jones"]) {
      const result = await searchCrmRelationshipHouseholds(OPS, query);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("search_failed");
      expect(result.rows.map((row) => row.identityId).sort()).toEqual([identityId(1), identityId(3)]);
    }
    for (const query of ["Ana", "Ana de la Boehm", "de la Boehm"]) {
      expect(await searchCrmRelationshipHouseholds(OPS, query)).toMatchObject({
        ok: true, rows: [{ identityId: identityId(4), crmId: sfId(4) }],
      });
    }
  });

  it("uses the same household label and canonical link in graph summaries", async () => {
    const search = await searchCrmRelationshipHouseholds(OPS, "Marion");
    const summaries = await getCrmIdentitySummaries(OPS, [identityId(1), identityId(2)]);
    if (!search.ok || !summaries.ok) throw new Error("summary_failed");
    expect(search.rows[0].name).toBe("Jones Household");
    expect(summaries.rows).toEqual([identityId(1), identityId(2)].map((id) => ({
      id, identityType: "HOUSEHOLD", displayName: search.rows[0].name,
      href: `/households/${sfId(1)}`,
    })));
    // Performance reporting consumes this ID as its account/audit scope. A
    // display-only rename must not change which source the report reads.
    expect(await householdHeader(OPS, sfId(2))).toEqual({
      sf_id: sfId(2), name: "Jones Household",
    });
    expect(await owner.$queryRaw`SELECT name FROM mirror.household WHERE sf_id = ${sfId(2)}`)
      .toEqual([{ name: "Historic household alias" }]);
  });

  it("keeps literal LIKE punctuation and never searches opaque IDs", async () => {
    expect(await searchCrmRelationshipHouseholds(OPS, "50%_\\")).toMatchObject({
      ok: true, rows: [{ identityId: identityId(5), name: "Literal 50%_\\ source" }],
    });
    expect(await searchCrmRelationshipHouseholds(OPS, "50XX")).toEqual({ ok: true, rows: [] });
    expect(await searchCrmRelationshipHouseholds(OPS, sfId(1))).toEqual({ ok: true, rows: [] });
  });

  it("excludes placeholder members and inactive mappings/identities", async () => {
    for (const query of ["Placeholderneedle", "Bogan", "Blanda"]) {
      expect(await searchCrmRelationshipHouseholds(OPS, query)).toEqual({ ok: true, rows: [] });
    }
  });

  it("preserves role gates, the feature flag, and the minimum query length", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", "unknown"]) {
      expect(await searchCrmRelationshipHouseholds({ ...OPS, role }, "Jones"))
        .toEqual({ ok: false, reason: "forbidden" });
    }
    expect(await searchCrmRelationshipHouseholds(OPS, " j ")).toEqual({ ok: true, rows: [] });
    vi.stubEnv("CRM_RELATIONSHIPS", "0");
    expect(await searchCrmRelationshipHouseholds(OPS, "Jones"))
      .toEqual({ ok: false, reason: "disabled" });
  });

  it("does not apply canonical overlays while identity reads are disabled", async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    const result = await searchCrmRelationshipHouseholds(OPS, "Marion");
    if (!result.ok) throw new Error("search_failed");
    // The name on source 1 and the member on source 2 each match. With the
    // overlay disabled, neither match may collapse into the other source.
    expect(result.rows.map((row) => [row.identityId, row.crmId]).sort()).toEqual([
      [identityId(1), sfId(1)], [identityId(2), sfId(2)],
    ]);
  });

  it("does not merge opaque household keys sharing their first fifteen characters", async () => {
    const firstKey = "001R216-imported-source-alpha";
    const secondKey = "001R216-imported-source-beta";
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      VALUES (${firstKey}, 'Botsford Household', ${OPS.email}),
             (${secondKey}, 'Boyer Household', ${OPS.email})`;
    await owner.$executeRaw`
      INSERT INTO app.crm_identity (id, identity_type, updated_at)
      VALUES (${identityId(700)}, 'HOUSEHOLD', now()), (${identityId(701)}, 'HOUSEHOLD', now())`;
    await owner.$executeRaw`
      INSERT INTO app.crm_source_mapping
        (id, identity_id, source_system, source_namespace, source_key, updated_at)
      VALUES ('r216-map-700', ${identityId(700)}, 'CRM', 'household', ${firstKey}, now()),
             ('r216-map-701', ${identityId(701)}, 'CRM', 'household', ${secondKey}, now())`;
    expect(await searchCrmRelationshipHouseholds(OPS, "Botsford")).toEqual({
      ok: true, rows: [{ identityId: identityId(700), crmId: firstKey, name: "Botsford Household" }],
    });
    const summaries = await getCrmIdentitySummaries(OPS, [identityId(700), identityId(701)]);
    expect(summaries).toEqual({ ok: true, rows: [
      { id: identityId(700), identityType: "HOUSEHOLD", displayName: "Botsford Household", href: `/households/${firstKey}` },
      { id: identityId(701), identityType: "HOUSEHOLD", displayName: "Boyer Household", href: `/households/${secondKey}` },
    ] });
  });

  it("returns at most twelve distinct results in repeatable order", async () => {
    await seedHouseholds(Array.from({ length: 15 }, (_, i) => [100 + i, `Boundedneedle ${String(i).padStart(2, "0")}`]));
    const first = await searchCrmRelationshipHouseholds(OPS, "Boundedneedle");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("search_failed");
    expect(first.rows).toHaveLength(12);
    expect(new Set(first.rows.map((row) => row.identityId)).size).toBe(12);
    expect(await searchCrmRelationshipHouseholds(OPS, "Boundedneedle")).toEqual(first);
  });
});
