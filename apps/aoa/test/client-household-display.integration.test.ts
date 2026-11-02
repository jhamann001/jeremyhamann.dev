import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getClientDirectory, getClientWithHousehold, listClients } from "@/lib/data/clients";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "tkt16-client-fixture@example.invalid" };
const household = "001Z176S2749620AAA";
const otherHousehold = "001H581Z6727708AAA";
const alice = "003Z176S2749620AAA";
const zoe = "003H581Z6727708AAA";
const hidden = "003D610H8515016AAA";
const filters = { query: "", stage: "all" as const, sortKey: "name" as const, sortDir: "asc" as const };

gated("Client household display and directory snapshots", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id IN (${alice}, ${zoe}, ${hidden})`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${household}, ${otherHousehold})`;
  }

  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !(url.pathname === "/aoa_pagination_synthetic" && url.port === "55444"
          || process.env.CI === "true" && url.pathname === "/aoa" && url.port === "5432")
        || url.username !== username || url.host !== target.host || url.pathname !== target.pathname
        || [...url.searchParams.keys()].some((key) => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_tkt16_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      VALUES (${household}, 'Marisol Smith Household', 'Client', ${ADVISOR.email}),
        (${otherHousehold}, 'Hidden Jones Household', 'Client', 'tkt16-other@example.invalid')`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES (${alice}, ${household}, 'Marisol', 'Smith', ${ADVISOR.email}),
        (${zoe}, ${household}, 'Zoe', 'Smith', ${ADVISOR.email}),
        (${hidden}, ${otherHousehold}, 'Hidden', 'Jones', 'tkt16-other@example.invalid')`;
  });

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
  });

  it("shares the household label across the client list, bounded directory and client detail", async () => {
    const list = await listClients(ADVISOR);
    const page = await getClientDirectory(ADVISOR, filters, 1, 1);
    const detail = await getClientWithHousehold(ADVISOR, alice);
    expect(list.map((row) => row.household_name)).toEqual(["Smith Household", "Smith Household"]);
    expect(page.rows[0].household_name).toBe("Smith Household");
    expect(detail?.household?.name).toBe("Smith Household");
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.pageCount).toBe(2);
    expect(JSON.stringify(page.rows)).not.toContain("household_source_names");
    expect(JSON.stringify(page.rows)).not.toContain("member_names");
  });

  it("keeps raw household names searchable and never returns another advisor's members", async () => {
    const rawName = await getClientDirectory(ADVISOR, { ...filters, query: "Marisol Smith Household" }, 1, 10);
    expect(rawName.rows.map((row) => row.sf_id)).toEqual([alice, zoe]);
    expect(rawName.rows.every((row) => row.household_name === "Smith Household")).toBe(true);
    const denied = await getClientDirectory(ADVISOR, { ...filters, query: "Hidden" }, 1, 10);
    expect(denied.rows).toEqual([]);
    expect(await getClientWithHousehold(ADVISOR, hidden)).toBeNull();
  });

  it("invalidates all directory pages when household naming inputs change", async () => {
    const first = await getClientDirectory(ADVISOR, filters, 1, 1);
    const second = await getClientDirectory(ADVISOR, filters, 2, 1);
    expect(first.snapshot).toBe(second.snapshot);
    // The changed member is outside the first page. Its different surname
    // makes the source label ambiguous, so both pages must use the fallback.
    await owner.$executeRaw`UPDATE mirror.client SET last_name = 'Jones' WHERE sf_id = ${zoe}`;
    try {
      const changed = await getClientDirectory(ADVISOR, filters, 1, 1);
      expect(changed.snapshot).not.toBe(first.snapshot);
      expect(changed.rows[0].household_name).toBe("Marisol Smith Household");
    } finally {
      await owner.$executeRaw`UPDATE mirror.client SET last_name = 'Smith' WHERE sf_id = ${zoe}`;
    }
  });

  it("preserves 15/18-character Salesforce IDs and distinct opaque household keys without exposing computed keys", async () => {
    const first = "tkt16-client-key-household-first";
    const second = "tkt16-client-key-household-second";
    const fifteen = "001D479P6488602";
    const clientIds = ["tkt16-client-key-person-first", "tkt16-client-key-person-second", "003X400F9034701AAA"];
    try {
      await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        VALUES (${first}, 'First opaque household', 'Client', ${ADVISOR.email}),
          (${second}, 'Second opaque household', 'Prospect', ${ADVISOR.email}),
          (${fifteen}, 'Alias Member Household', 'Client', ${ADVISOR.email})`;
      await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        VALUES (${clientIds[0]}, ${first}, 'Opaque', 'First', ${ADVISOR.email}),
          (${clientIds[1]}, ${second}, 'Opaque', 'Second', ${ADVISOR.email}),
          (${clientIds[2]}, ${fifteen}, 'Alias', 'Member', ${ADVISOR.email})`;
      const list = await listClients(ADVISOR);
      expect(list.filter((row) => clientIds.includes(row.sf_id))).toHaveLength(3);
      expect(list.find((row) => row.sf_id === clientIds[0])).toMatchObject({ household_id: first, household_name: "First opaque household" });
      expect(list.find((row) => row.sf_id === clientIds[1])).toMatchObject({ household_id: second, household_name: "Second opaque household", household_stage: "Prospect" });
      expect(list.find((row) => row.sf_id === clientIds[2])).toMatchObject({ household_id: fifteen, household_name: "Member Household" });
      expect(list.find((row) => row.sf_id === alice)).toMatchObject({ household_id: household, household_name: "Smith Household" });
      const page = await getClientDirectory(ADVISOR, { ...filters, query: "Opaque" }, 1, 100);
      expect(page.total).toBe(2);
      expect(page.rows.map((row) => row.household_id).sort()).toEqual([first, second].sort());
      for (const payload of [list, page.rows]) {
        expect(JSON.stringify(payload)).not.toMatch(/household_source_key|resolved_household_key|household_key/);
      }
    } finally {
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ANY(${clientIds}::text[])`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id IN (${first}, ${second}, ${fifteen})`;
    }
  });

  it("loads the full picker and bounded directory for a 4,000-household book within unchanged database limits", async () => {
    const scaleIdentity = { role: "ADVISOR", email: "tkt16-client-scale@example.invalid" };
    const scaleHouseholdIds = Array.from({ length: 4_000 }, (_, i) => `001CPS${String(i + 1).padStart(9, "0")}AAA`);
    const scaleClientIds = Array.from({ length: 6_000 }, (_, i) => `003CPS${String(i + 1).padStart(9, "0")}AAA`);
    const cleanScale = async () => {
      await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id = ANY(${scaleClientIds}::text[])`;
      await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id = ANY(${scaleHouseholdIds}::text[])`;
    };
    await cleanScale();
    try {
      await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        SELECT '001CPS' || lpad(n::text, 9, '0') || 'AAA', 'Scale fixture household ' || n,
          'Client', ${scaleIdentity.email} FROM generate_series(1, 4000) n`;
      await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        SELECT '003CPS' || lpad(n::text, 9, '0') || 'AAA',
          '001CPS' || lpad((1 + (n - 1) % 4000)::text, 9, '0') || 'AAA',
          'ScaleFixture', lpad(n::text, 4, '0'), ${scaleIdentity.email}
          FROM generate_series(1, 6000) n`;
      await owner.$executeRaw`ANALYZE mirror.household`;
      await owner.$executeRaw`ANALYZE mirror.client`;
      // The real seams enforce their normal four-second SQL/five-second
      // transaction deadlines. The former regex join failed at this scale.
      // ACAT uses Operations; the client directory also supports Advisors.
      for (const role of ["OPERATIONS", "ADVISOR"]) {
        const list = (await listClients({ ...scaleIdentity, role })).filter((row) => row.sf_id.startsWith("003CPS"));
        expect(list).toHaveLength(6_000);
        expect(new Set(list.map((row) => row.sf_id)).size).toBe(6_000);
        expect(list.every((row, i) => row.sf_id === scaleClientIds[i]
          && row.household_id === scaleHouseholdIds[i % 4_000]
          && row.household_stage === "Client")).toBe(true);
      }
      const firstPage = await getClientDirectory(scaleIdentity, { ...filters, query: "ScaleFixture" }, 1, 100);
      const lastPage = await getClientDirectory(scaleIdentity, { ...filters, query: "ScaleFixture" }, 60, 100);
      expect(firstPage.total).toBe(6_000);
      expect(firstPage.rows).toHaveLength(100);
      expect(firstPage.rows[0].sf_id).toBe(scaleClientIds[0]);
      expect(lastPage.rows).toHaveLength(100);
      expect(lastPage.rows[99].sf_id).toBe(scaleClientIds[5_999]);
      expect(lastPage.snapshot).toBe(firstPage.snapshot);
      expect((await listClients({ role: "ADVISOR", email: "tkt16-empty-scale@example.invalid" }))).toEqual([]);
    } finally { await cleanScale(); }
  }, 20_000);
});
