import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

import { GET } from "@/app/api/households/route";
import { getHouseholdDirectory } from "@/lib/data/households";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS as DEFAULTS } from "@/lib/navigation/household-query";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "paging-advisor@example.test" };
const OTHER = "paging-other@example.test";
const sfId = (n: number) => `001PGD${String(n).padStart(9, "0")}AAA`;
const fixtureRequest = (query = "") => new Request(`https://example.test/api/households?${query}`);
const OVERLAY_FIRST = "hld_pgdoverlayc1";
const OVERLAY_SECOND = "hld_pgdoverlayc2";
const OVERLAY_SOURCE = "hld_pgdoverlaysource";
const OVERLAY_FIRST_REVIEW = `dup_c${"504741".padStart(24, "0")}`;
const OVERLAY_SECOND_REVIEW = `dup_c${"504742".padStart(24, "0")}`;

gated("Households progressive pages: actual PostgreSQL/RLS and concurrent changes", () => {
  let owner: PrismaClient;

  async function cleanup() {
    await owner.$executeRaw`
      DELETE FROM app.crm_duplicate_candidate_event
       WHERE candidate_id IN (${OVERLAY_FIRST_REVIEW}, ${OVERLAY_SECOND_REVIEW})`;
    await owner.$executeRaw`
      DELETE FROM app.crm_duplicate_candidate
       WHERE id IN (${OVERLAY_FIRST_REVIEW}, ${OVERLAY_SECOND_REVIEW})`;
    await owner.$executeRaw`
      DELETE FROM app.crm_source_mapping
       WHERE identity_id IN (${OVERLAY_FIRST}, ${OVERLAY_SECOND}, ${OVERLAY_SOURCE})`;
    await owner.$executeRaw`
      DELETE FROM app.crm_identity
       WHERE id IN (${OVERLAY_FIRST}, ${OVERLAY_SECOND}, ${OVERLAY_SOURCE})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001PGD%'`;
    await owner.$executeRaw`
      DELETE FROM audit.row_change
       WHERE (table_name = 'crm_duplicate_candidate'
              AND row_pk IN (${OVERLAY_FIRST_REVIEW}, ${OVERLAY_SECOND_REVIEW}))
          OR (table_name = 'crm_identity'
              AND row_pk IN (${OVERLAY_FIRST}, ${OVERLAY_SECOND}, ${OVERLAY_SOURCE}))
          OR (table_name = 'crm_source_mapping'
              AND row_pk IN ('pgd-overlay-map-first', 'pgd-overlay-map-second', 'pgd-overlay-map-source'))`;
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url) throw new Error("Synthetic household paging tests require an explicit cleanup URL");
    const target = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
      throw new Error("Synthetic household paging tests require a loopback database");
    }
    owner = new PrismaClient({ datasourceUrl: url });
    await cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    authMock.mockResolvedValue({ user: ADVISOR });
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, status, lead_advisor_email, aum)
      SELECT '001PGD' || lpad(i::text, 9, '0') || 'AAA',
             'Progressive Synthetic Same Name',
             CASE WHEN i <= 215 THEN 'Client' WHEN i <= 218 THEN 'Lost Client' ELSE 'Prospect' END,
             'Active', ${ADVISOR.email}, i
        FROM generate_series(1, 222) i`;
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, status, lead_advisor_email, aum)
      SELECT '001PGD' || lpad(i::text, 9, '0') || 'AAA',
             'Progressive Synthetic Other Book', 'Client', 'Other Status', ${OTHER}, 99999
        FROM generate_series(300, 310) i`;
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("returns 100/100/15 distinct ordered rows while full-book counts and options stay complete", async () => {
    const first = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    const second = await getHouseholdDirectory(ADVISOR, DEFAULTS, 2, 100);
    const third = await getHouseholdDirectory(ADVISOR, DEFAULTS, 3, 100);
    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([100, 100, 15]);
    expect([first.snapshot, second.snapshot, third.snapshot]).toEqual(Array(3).fill(first.snapshot));
    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.sf_id);
    expect(ids).toEqual(Array.from({ length: 215 }, (_, i) => sfId(i + 1)));
    expect(new Set(ids).size).toBe(215);
    expect(first.total).toBe(215);
    expect(first.counts).toEqual({ all: 222, client: 215, lost_client: 3 });
    expect(first.summaryCounts).toEqual({ clients: 215, prospects: 4, lost: 3 });
    expect(first.statusOptions).toEqual(["Active"]);
    expect(first.advisorOptions.map((option) => option.value)).toEqual([ADVISOR.email]);
  });

  it("caps internal oversized reads to 200 and preserves explicit sort direction with a unique tie-breaker", async () => {
    const page = await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, sortKey: "aum", sortDir: "desc" }, 1, 50_000);
    expect(page.pageSize).toBe(200);
    expect(page.rows.length).toBe(200);
    expect(page.rows[0].sf_id).toBe(sfId(215));
    expect(page.rows[199].sf_id).toBe(sfId(16));
  });

  it("enforces current RLS on every page and does not disclose the other book in summaries/options", async () => {
    const first = await GET(fixtureRequest());
    const body = await first.json();
    authMock.mockResolvedValue({ user: { role: "ADVISOR", email: OTHER } });
    const switched = await GET(fixtureRequest(`page=2&snapshot=${body.snapshot}`));
    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual({ error: "household_directory_changed" });
    authMock.mockResolvedValue({ user: { role: "VIEWER", email: ADVISOR.email } });
    const denied = await GET(fixtureRequest());
    const deniedBody = await denied.json();
    expect(deniedBody.rows).toEqual([]);
    expect(deniedBody.counts).toEqual({ all: 0, client: 0, lost_client: 0 });
    expect(deniedBody.advisorOptions).toEqual([]);
    expect(deniedBody.statusOptions).toEqual([]);
  });

  it("accepts an unchanged append and rejects an insertion that shifts offsets", async () => {
    const first = await GET(fixtureRequest());
    const { snapshot } = await first.json();
    expect((await GET(fixtureRequest(`page=2&snapshot=${snapshot}`))).status).toBe(200);
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      VALUES (${sfId(500)}, 'AAA Progressive Synthetic New', 'Client', ${ADVISOR.email})`;
    const changed = await GET(fixtureRequest(`page=2&snapshot=${snapshot}`));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "household_directory_changed" });
  });

  it("rejects deletion and sorting-value changes instead of appending mixed versions", async () => {
    const first = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ${sfId(1)}`;
    expect((await GET(fixtureRequest(`page=2&snapshot=${first.snapshot}`))).status).toBe(409);
    const sorted = await GET(fixtureRequest("sort=aum&dir=desc"));
    const { snapshot } = await sorted.json();
    await owner.$executeRaw`UPDATE mirror.household SET aum = 999999 WHERE sf_id = ${sfId(2)}`;
    expect((await GET(fixtureRequest(`sort=aum&dir=desc&page=2&snapshot=${snapshot}`))).status).toBe(409);
  });

  it("keeps outside-book writes from invalidating an advisor's scoped snapshot", async () => {
    const first = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    await owner.$executeRaw`UPDATE mirror.household SET name = 'Changed other book' WHERE sf_id = ${sfId(300)}`;
    const second = await getHouseholdDirectory(ADVISOR, DEFAULTS, 2, 100);
    expect(second.snapshot).toBe(first.snapshot);
  });

  it("invalidates retained rows after a visible membership change", async () => {
    const first = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES ('003VDH233764942AAA', ${sfId(1)}, 'Synthetic', 'Member', ${ADVISOR.email})`;
    const refreshed = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    expect(refreshed.snapshot).not.toBe(first.snapshot);
    expect(refreshed.rows[0].member_count).toBe(1);
  });

  it("rejects a canonical source reassignment even when directory rows and raw parents stay unchanged", async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO app.crm_identity (id, identity_type, updated_at)
        VALUES (${OVERLAY_FIRST}, 'HOUSEHOLD', now()),
               (${OVERLAY_SECOND}, 'HOUSEHOLD', now()),
               (${OVERLAY_SOURCE}, 'HOUSEHOLD', now())`;
      await tx.$executeRaw`
        INSERT INTO app.crm_source_mapping
          (id, identity_id, source_system, source_namespace, source_key, updated_at)
        VALUES ('pgd-overlay-map-first', ${OVERLAY_FIRST}, 'CRM', 'household', ${sfId(1)}, now()),
               ('pgd-overlay-map-second', ${OVERLAY_SECOND}, 'CRM', 'household', ${sfId(150)}, now()),
               ('pgd-overlay-map-source', ${OVERLAY_SOURCE}, 'CRM', 'household', ${sfId(215)}, now())`;
      await tx.$executeRaw`
        INSERT INTO app.crm_duplicate_candidate
          (id, detector_key, entity_type, left_identity_id, right_identity_id,
           evidence_codes, status, canonical_identity_id, updated_at)
        VALUES (${OVERLAY_FIRST_REVIEW}, ${"504741".padStart(64, "0")}, 'HOUSEHOLD',
                ${OVERLAY_FIRST}, ${OVERLAY_SOURCE}, ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],
                'READY_FOR_FOLLOW_UP', ${OVERLAY_FIRST}, now()),
               (${OVERLAY_SECOND_REVIEW}, ${"504742".padStart(64, "0")}, 'HOUSEHOLD',
                ${OVERLAY_SECOND}, ${OVERLAY_SOURCE}, ARRAY['SHARED_CEDAR_RIDGE_USER_ID'],
                'NEW', NULL, now())`;
      await tx.$executeRaw`
        INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES ('003GVI470159470AAA', ${sfId(215)}, 'Synthetic', 'Overlay', ${ADVISOR.email})`;
    });
    const beforeFirst = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    const beforeSecond = await getHouseholdDirectory(ADVISOR, DEFAULTS, 2, 100);
    expect(beforeFirst.total).toBe(214);
    expect(beforeSecond.snapshot).toBe(beforeFirst.snapshot);
    expect(beforeFirst.rows.find((row) => row.sf_id === sfId(1))?.member_count).toBe(1);
    expect(beforeSecond.rows.find((row) => row.sf_id === sfId(150))?.member_count).toBe(0);

    // The source stays suppressed throughout this atomic review change. No
    // source household, raw client parent, balance or directory order changes.
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE app.crm_duplicate_candidate SET status = 'NEW'
         WHERE id = ${OVERLAY_FIRST_REVIEW}`;
      await tx.$executeRaw`
        UPDATE app.crm_duplicate_candidate
           SET status = 'READY_FOR_FOLLOW_UP', canonical_identity_id = ${OVERLAY_SECOND}
         WHERE id = ${OVERLAY_SECOND_REVIEW}`;
    });
    const afterFirst = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    const afterSecond = await getHouseholdDirectory(ADVISOR, DEFAULTS, 2, 100);
    expect(afterFirst).toEqual({
      ...beforeFirst, snapshot: afterFirst.snapshot,
      rows: beforeFirst.rows.map((row) => row.sf_id === sfId(1) ? { ...row, member_count: 0 } : row),
    });
    expect(afterSecond).toEqual({
      ...beforeSecond, snapshot: afterSecond.snapshot,
      rows: beforeSecond.rows.map((row) => row.sf_id === sfId(150) ? { ...row, member_count: 1 } : row),
    });
    expect(afterFirst.snapshot).not.toBe(beforeFirst.snapshot);
    expect(afterSecond.snapshot).toBe(afterFirst.snapshot);
    const rejected = await GET(fixtureRequest(`page=2&snapshot=${beforeFirst.snapshot}`));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "household_directory_changed" });
  });

  it("returns empty/end-of-list states without replaying a clamped final page", async () => {
    const first = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    const overrun = await GET(fixtureRequest(`page=4&snapshot=${first.snapshot}`));
    expect(overrun.status).toBe(416);
    const empty = await GET(fixtureRequest("q=does-not-exist"));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 });
  });
});
