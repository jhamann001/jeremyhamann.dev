import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getHouseholdDirectory } from "@/lib/data/households";
import { householdDisplayCtes } from "@/lib/data/household-display";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS } from "@/lib/navigation/household-query";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "directory-members@example.invalid" };
const OPS = { role: "OPERATIONS", email: ADVISOR.email };
const OTHER_EMAIL = "other-directory-members@example.invalid";
const hh = (n: number) => `001HDM${String(n).padStart(9, "0")}AAA`;
const client = (n: number) => `003HDM${String(n).padStart(9, "0")}AAA`;
const contact = (n: number) => `con_directorymembers${n}`;
const householdIdentity = (n: number) => `hld_directorymembers${n}`;
const upload = "directory-members-upload";
const candidate = `dup_c${"21692412".padStart(24, "0")}`;
const opaqueIds = ["HDMOPAQUEPREFIX1-alpha", "HDMOPAQUEPREFIX1-beta"];
const filters = {
  ...DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS,
  query: "DirectoryMemberFixture",
  stage: "all" as const,
};
type DirectoryRow = Awaited<ReturnType<typeof getHouseholdDirectory>>["rows"][number];
const memberSummary = (rows: DirectoryRow[]) => rows.map(row => ({
  sf_id: row.sf_id, member_count: row.member_count, employeeStatus: row.employeeStatus,
}));

gated("Household directory page member aggregation under PostgreSQL RLS", () => {
  let owner: PrismaClient;

  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.employee_client_status WHERE source_upload_id = ${upload}`;
    await owner.$executeRaw`DELETE FROM app.employee_contact_mapping WHERE id LIKE 'directory-members-%'`;
    await owner.$executeRaw`DELETE FROM app.employee_roster_upload WHERE id = ${upload}`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate_event WHERE candidate_id = ${candidate}`;
    await owner.$executeRaw`DELETE FROM app.crm_duplicate_candidate WHERE id = ${candidate}`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'directory-members-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'con_directorymembers%' OR id LIKE 'hld_directorymembers%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003HDM%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001HDM%'
      OR sf_id IN (${opaqueIds[0]}, ${opaqueIds[1]})`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'directory-members-%'
      OR row_pk LIKE 'con_directorymembers%' OR row_pk LIKE 'hld_directorymembers%'
      OR row_pk LIKE '003HDM%' OR row_pk LIKE '001HDM%' OR row_pk = ${candidate}
      OR row_pk IN (${opaqueIds[0]}, ${opaqueIds[1]})`;
  }

  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL, reader = process.env.DATABASE_URL;
    if (!raw || !reader) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [reader, "app_rw"]]) {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !(url.port === "55444" && url.pathname === "/aoa_pagination_synthetic"
          || process.env.CI === "true" && url.port === "5432" && url.pathname === "/aoa")
        || url.username !== username || url.host !== target.host || url.pathname !== target.pathname
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email) VALUES
      (${hh(1)}, 'DirectoryMemberFixture A Empty', 'Client', ${ADVISOR.email}),
      (${hh(2)}, 'DirectoryMemberFixture B Scoped', 'Client', ${ADVISOR.email}),
      (${hh(3)}, 'DirectoryMemberFixture C Aliases', 'Client', ${ADVISOR.email}),
      (${hh(3).slice(0, 15)}, 'DirectoryMemberFixture C Aliases', 'Client', ${ADVISOR.email}),
      (${hh(4)}, 'DirectoryMemberFixture D Canonical', 'Client', ${ADVISOR.email}),
      (${hh(5)}, 'DirectoryMemberFixture Z Suppressed', 'Client', ${ADVISOR.email}),
      (${hh(6)}, 'DirectoryMemberFixture E Stale', 'Client', ${ADVISOR.email}),
      (${hh(7)}, 'DirectoryMemberFixture F Other', 'Client', ${OTHER_EMAIL})`;
    await owner.$executeRaw`INSERT INTO app.employee_roster_upload
      (id, file_sha256, effective_date, parser_version, row_count, employee_count,
       dependent_row_count, active_count, former_count, uploaded_by, updated_at)
      VALUES (${upload}, ${"d".repeat(64)}, '2026-09-24', 'directory-members-test',
        10, 10, 0, 7, 3, ${OPS.email}, now())`;

    // The visible household has a hidden active member: the advisor must see
    // only its former badge, whereas Operations sees the active precedence.
    for (const [n, parent, email] of [
      [1, hh(2), ADVISOR.email], [2, hh(2), OTHER_EMAIL],
      [3, hh(3).slice(0, 15), ADVISOR.email],
      [4, hh(4), ADVISOR.email], [5, hh(5), ADVISOR.email],
      [6, hh(6), ADVISOR.email], [7, hh(6), ADVISOR.email],
      [8, hh(6), ADVISOR.email], [9, hh(6), ADVISOR.email],
      [10, hh(7), OTHER_EMAIL],
    ] as const) {
      await owner.$executeRaw`INSERT INTO mirror.client
        (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${client(n)}, ${parent}, 'Invented', ${`Member${n}`}, ${email})`;
      await owner.crmIdentity.create({ data: {
        id: contact(n), identity_type: "CONTACT",
      } });
      await owner.crmSourceMapping.create({ data: {
        id: `directory-members-contact-source-${n}`, identity_id: contact(n),
        source_system: "CRM", source_namespace: "contact", source_key: client(n),
      } });
      if (n !== 9) await owner.employeeContactMapping.create({ data: {
        id: `directory-members-employee-map-${n}`, employee_id: `directory-members-employee-${n}`,
        contact_identity_id: contact(n), client_sf_id: client(n),
        state: "CONFIRMED", evidence: "MANUAL_SEARCH", reviewed_by: OPS.email,
      } });
      await owner.employeeClientStatus.create({ data: {
        client_sf_id: client(n), employment_state: [1, 4, 10].includes(n) ? "FORMER" : "ACTIVE",
        effective_date: new Date("2026-09-24"), source_upload_id: upload,
      } });
    }
    // Mapping validation correctly rejects already-invalid contacts. Establish
    // valid badges first, then model later CRM/mapping changes without rebuilding
    // the derived status cache; each read must reject those stale badges.
    await owner.employeeContactMapping.update({
      where: { id: "directory-members-employee-map-6" }, data: { state: "INVALIDATED" },
    });
    await owner.crmIdentity.update({ where: { id: contact(7) }, data: { lifecycle_state: "ARCHIVED" } });
    await owner.$executeRaw`UPDATE app.crm_source_mapping
      SET mapping_state = 'SUPERSEDED', superseded_at = now(), updated_at = now()
      WHERE id = 'directory-members-contact-source-8'`;
    await owner.$executeRaw`INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, lead_advisor_email) VALUES
      (${client(3).slice(0, 15)}, ${hh(3)}, 'Invented', 'Member3', ${ADVISOR.email}),
      (${client(11)}, ${hh(2)}, 'Invented', 'Unbadged', ${ADVISOR.email})`;
    await owner.employeeClientStatus.create({ data: {
      client_sf_id: client(3).slice(0, 15), employment_state: "FORMER",
      effective_date: new Date("2026-09-24"), source_upload_id: upload,
    } });

    for (const n of [4, 5]) {
      await owner.crmIdentity.create({ data: { id: householdIdentity(n), identity_type: "HOUSEHOLD" } });
      await owner.crmSourceMapping.create({ data: {
        id: `directory-members-household-source-${n}`, identity_id: householdIdentity(n),
        source_system: "CRM", source_namespace: "household", source_key: hh(n),
      } });
    }
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id,
       evidence_codes, status, canonical_identity_id, updated_at)
      VALUES (${candidate}, ${"21692412".padStart(64, "0")}, 'HOUSEHOLD',
        ${householdIdentity(4)}, ${householdIdentity(5)}, ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],
        'READY_FOR_FOLLOW_UP', ${householdIdentity(4)}, now())`;
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email) VALUES
      (${opaqueIds[0]}, 'DirectoryMemberOpaqueFixture A Source', 'Client', ${ADVISOR.email}),
      (${opaqueIds[1]}, 'DirectoryMemberOpaqueFixture B Source', 'Client', ${ADVISOR.email})`;
    await owner.$executeRaw`INSERT INTO mirror.client
      (sf_id, household_id, first_name, last_name, lead_advisor_email) VALUES
      (${client(12)}, ${opaqueIds[0]}, 'Invented', 'OpaqueOne', ${ADVISOR.email}),
      (${client(13)}, ${opaqueIds[0]}, 'Invented', 'OpaqueTwo', ${ADVISOR.email}),
      (${client(14)}, ${opaqueIds[1]}, 'Invented', 'OpaqueThree', ${ADVISOR.email})`;
  });

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
  });

  it("counts empty/visible households and applies employee precedence within each caller's book", async () => {
    const advisor = await getHouseholdDirectory(ADVISOR, filters, 1, 100);
    expect(memberSummary(advisor.rows)).toEqual([
      { sf_id: hh(1), member_count: 0, employeeStatus: null },
      { sf_id: hh(2), member_count: 2, employeeStatus: "FORMER" },
      { sf_id: hh(3).slice(0, 15), member_count: 8, employeeStatus: "ACTIVE" },
      { sf_id: hh(3), member_count: 8, employeeStatus: "ACTIVE" },
      { sf_id: hh(4), member_count: 2, employeeStatus: "ACTIVE" },
      { sf_id: hh(6), member_count: 4, employeeStatus: null },
    ]);
    const ops = await getHouseholdDirectory(OPS, filters, 1, 100);
    expect(memberSummary(ops.rows)).toEqual([
      ...memberSummary(advisor.rows).map(row => row.sf_id === hh(2)
        ? { ...row, member_count: 3, employeeStatus: "ACTIVE" } : row),
      { sf_id: hh(7), member_count: 1, employeeStatus: "FORMER" },
    ]);
    const viewer = await getHouseholdDirectory({ role: "VIEWER", email: ADVISOR.email }, filters, 1, 100);
    expect(viewer.rows).toEqual([]);
    expect(viewer.total).toBe(0);
  });

  it("retains 15/18-character source, client and current badge row multiplicity", async () => {
    const result = await getHouseholdDirectory(ADVISOR, { ...filters, query: "DirectoryMemberFixture C Aliases" }, 1, 1);
    const second = await getHouseholdDirectory(ADVISOR, { ...filters, query: "DirectoryMemberFixture C Aliases" }, 2, 1);
    // Compatibility with the former lateral COUNT(c.sf_id), not a count of
    // distinct people: two source rows × two client rows × two current badge
    // rows = eight. Restricting to one selected page row must not lose aliases.
    expect(memberSummary(result.rows)).toEqual([
      { sf_id: hh(3).slice(0, 15), member_count: 8, employeeStatus: "ACTIVE" },
    ]);
    expect(memberSummary(second.rows)).toEqual([
      { sf_id: hh(3), member_count: 8, employeeStatus: "ACTIVE" },
    ]);
    expect([result.total, second.total]).toEqual([2, 2]);
  });

  it("includes suppressed-source members on a later page without leaking enrichment between pages", async () => {
    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await getHouseholdDirectory(ADVISOR, filters, page, 2));
    expect(pages.map(page => page.rows.map(row => row.sf_id))).toEqual([
      [hh(1), hh(2)], [hh(3).slice(0, 15), hh(3)], [hh(4), hh(6)],
    ]);
    expect(pages.map(page => page.total)).toEqual([6, 6, 6]);
    expect(pages.map(page => page.pageCount)).toEqual([3, 3, 3]);
    expect(new Set(pages.map(page => page.snapshot)).size).toBe(1);
    expect(memberSummary(pages[2].rows)).toEqual([
      { sf_id: hh(4), member_count: 2, employeeStatus: "ACTIVE" },
      { sf_id: hh(6), member_count: 4, employeeStatus: null },
    ]);
  });

  it("preserves the legacy fifteen-character aggregate for distinct opaque IDs together and on separate pages", async () => {
    // Names/route identities distinguish opaque IDs, but the existing member
    // aggregate joins on left(..., 15). This optimization deliberately keeps
    // that quirk: both source rows join all three members, yielding six each.
    expect(opaqueIds[0].slice(0, 15)).toBe(opaqueIds[1].slice(0, 15));
    const legacy = await withUserScope(ADVISOR, tx => tx.$queryRaw<Array<{
      sf_id: string; member_count: bigint; employeeStatus: "ACTIVE" | "FORMER" | null;
    }>>`
      WITH ${householdDisplayCtes(true)}
      SELECT h.sf_id, member.member_count,
             CASE WHEN member.has_active_employee THEN 'ACTIVE'
                  WHEN member.has_former_employee THEN 'FORMER'
                  ELSE NULL END AS "employeeStatus"
        FROM visible_household h
        LEFT JOIN LATERAL (
          SELECT count(c.sf_id)::bigint AS member_count,
                 bool_or(es.employment_state = 'ACTIVE') AS has_active_employee,
                 bool_or(es.employment_state = 'FORMER') AS has_former_employee
            FROM visible_household source
            LEFT JOIN mirror.client c ON left(c.household_id, 15) = left(source.sf_id, 15)
            LEFT JOIN app.employee_client_status es
              ON left(es.client_sf_id, 15) = left(c.sf_id, 15)
             AND app.employee_badge_is_current(es.client_sf_id)
           WHERE left(source.canonical_sf_id, 15) = left(h.sf_id, 15)
        ) member ON true
       WHERE h.sf_id IN (${opaqueIds[0]}, ${opaqueIds[1]})
       ORDER BY h.sf_id`);
    const expected = opaqueIds.map(sf_id => ({ sf_id, member_count: 6, employeeStatus: null }));
    expect(legacy.map(row => ({ ...row, member_count: Number(row.member_count) }))).toEqual(expected);
    const opaqueFilters = { ...filters, query: "DirectoryMemberOpaqueFixture" };
    const together = await getHouseholdDirectory(ADVISOR, opaqueFilters, 1, 2);
    const first = await getHouseholdDirectory(ADVISOR, opaqueFilters, 1, 1);
    const second = await getHouseholdDirectory(ADVISOR, opaqueFilters, 2, 1);
    expect(memberSummary(together.rows)).toEqual(expected);
    expect(memberSummary([...first.rows, ...second.rows])).toEqual(expected);
    expect([together.total, first.total, second.total]).toEqual([2, 2, 2]);
  });

  it("rechecks badge validity after a suppressed member mapping changes and versions retained pages", async () => {
    const before = await getHouseholdDirectory(ADVISOR, filters, 1, 2);
    try {
      await owner.employeeContactMapping.update({
        where: { id: "directory-members-employee-map-5" }, data: { state: "INVALIDATED" },
      });
      const former = await getHouseholdDirectory(ADVISOR, filters, 3, 2);
      expect(memberSummary(former.rows)[0]).toEqual({ sf_id: hh(4), member_count: 2, employeeStatus: "FORMER" });
      const retained = await getHouseholdDirectory(ADVISOR, filters, 1, 2);
      expect(retained.rows).toEqual(before.rows);
      expect(retained.snapshot).not.toBe(before.snapshot);
      expect(retained.snapshot).toBe(former.snapshot);

      await owner.$executeRaw`UPDATE app.crm_source_mapping
        SET mapping_state = 'SUPERSEDED', superseded_at = now(), updated_at = now()
        WHERE id = 'directory-members-contact-source-4'`;
      const absent = await getHouseholdDirectory(ADVISOR, filters, 3, 2);
      expect(memberSummary(absent.rows)[0]).toEqual({ sf_id: hh(4), member_count: 2, employeeStatus: null });
      expect(absent.snapshot).not.toBe(former.snapshot);
    } finally {
      await owner.employeeContactMapping.update({
        where: { id: "directory-members-employee-map-5" }, data: { state: "CONFIRMED" },
      });
      await owner.crmSourceMapping.update({
        where: { id: "directory-members-contact-source-4" }, data: { mapping_state: "ACTIVE", superseded_at: null },
      });
    }
  });

  it("keeps each source's own member counts and badges when canonical reads are disabled", async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "0");
    try {
      const result = await getHouseholdDirectory(ADVISOR, filters, 1, 100);
      expect(result.total).toBe(7);
      expect(memberSummary(result.rows.filter(row => [hh(4), hh(5)].includes(row.sf_id)))).toEqual([
        { sf_id: hh(4), member_count: 1, employeeStatus: "FORMER" },
        { sf_id: hh(5), member_count: 1, employeeStatus: "ACTIVE" },
      ]);
    } finally { vi.stubEnv("CRM_IDENTITY_READS", "1"); }
  });
});
