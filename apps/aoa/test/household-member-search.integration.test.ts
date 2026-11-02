import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
import { globalSearch } from "@/lib/data/search";
import { getHouseholdDirectory, householdHeader } from "@/lib/data/households";
import { listHouseholdPickerTargets } from "@/lib/data/household-picker";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS as DEFAULTS } from "@/lib/navigation/household-query";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const ADVISOR = { role: "ADVISOR", email: "name-search@example.test" };
const OTHER = { role: "ADVISOR", email: "name-search-other@example.test" };
const hh = (n: number) => `001NMS${String(n).padStart(9, "0")}AAA`;
const cl = (n: number) => `003NMS${String(n).padStart(9, "0")}AAA`;

gated("household member-name search: real RLS, naming and progressive pages", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003NMS%' OR sf_id LIKE '001NMS%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001NMS%'`;
  }
  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error("Household name fixtures require an explicit loopback owner database");
    }
    owner = new PrismaClient({ datasourceUrl: url });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      VALUES (${hh(1)}, 'Marisol Smith & Stacey Jones Household', 'Client', ${ADVISOR.email}),
             (${hh(2)}, 'Willie van der Bosco Household', 'Client', ${ADVISOR.email}),
             (${hh(3)}, 'Smith Family Trust', 'Client', ${ADVISOR.email}),
             (${hh(4)}, 'Hidden Household', 'Client', ${OTHER.email}),
             (${hh(5)}, 'Literal Household', 'Client', ${ADVISOR.email}),
             (${hh(6)}, 'Marion Church Household', 'Client', ${ADVISOR.email}),
             (${hh(7)}, 'Church Family Trust Household', 'Client', ${ADVISOR.email})`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      VALUES (${cl(1)}, ${hh(1)}, 'Marisol', 'Smith', ${ADVISOR.email}),
             (${cl(2)}, ${hh(1)}, 'Stacey', 'Jones', ${ADVISOR.email}),
             (${cl(3)}, ${hh(2)}, 'Willie van der', 'Bosco', ${ADVISOR.email}),
             (${cl(4)}, ${hh(3)}, 'Cara', 'Smith', ${ADVISOR.email}),
             (${cl(5)}, ${hh(4)}, 'Outside', 'Bookneedle', ${OTHER.email}),
             (${cl(6)}, ${hh(1)}, 'Hidden', 'PrivateNeedle', ${OTHER.email}),
             (${cl(7)}, ${hh(5)}, 'Literal%_Name', 'Search', ${ADVISOR.email}),
             (${cl(8)}, ${hh(6)}, 'Marion', 'Church', ${ADVISOR.email}),
             (${cl(9)}, ${hh(7)}, 'Rowan', 'Church', ${ADVISOR.email}),
             (${hh(5)}, ${hh(5)}, 'PlaceholderNeedle', 'Ghost', ${ADVISOR.email})`;
    await owner.$executeRaw`
      INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      SELECT '001NMS' || lpad(i::text, 9, '0') || 'AAA', 'Paging household ' || i,
             'Client', ${ADVISOR.email}
        FROM generate_series(100, 304) i`;
    await owner.$executeRaw`
      INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      SELECT '003NMS' || lpad(i::text, 9, '0') || 'AAA',
             '001NMS' || lpad(i::text, 9, '0') || 'AAA',
             'LaterPage', 'Member' || i, ${ADVISOR.email}
        FROM generate_series(100, 304) i`;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (owner) { await cleanup(); await owner.$disconnect(); }
  });

  it("returns the household for first, last and full member names without removing client results", async () => {
    for (const query of ["Marisol", "Smith", "Marisol Smith", "STACEY JONES"]) {
      const matches = await globalSearch(ADVISOR, query);
      expect(matches.filter(r => r.type === "household" && r.id === hh(1))).toHaveLength(1);
      expect(matches.some(r => r.type === "client")).toBe(true);
      const page = await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, query }, 1, 100);
      expect(page.rows.some(r => r.sf_id === hh(1))).toBe(true);
    }
  });

  it("uses one shared label, keeps original-name lookup, and preserves compound and entity source names", async () => {
    const page = await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, query: "Marisol Smith & Stacey Jones" }, 1, 100);
    expect(page.total).toBe(1);
    expect(page.rows[0].name).toBe("Jones & Smith Household");
    expect((await householdHeader(ADVISOR, hh(1)))?.name).toBe(page.rows[0].name);
    expect((await globalSearch(ADVISOR, "van der Bosco")).find(r => r.type === "household")?.label)
      .toBe("Willie van der Bosco Household");
    expect((await householdHeader(ADVISOR, hh(3)))?.name).toBe("Smith Family Trust");
  });

  it("never uses invisible member names, invisible households or retired placeholders to match", async () => {
    for (const query of ["PrivateNeedle", "Bookneedle", "PlaceholderNeedle"]) {
      expect((await globalSearch(ADVISOR, query)).filter(r => r.type === "household")).toEqual([]);
      expect((await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, query }, 1, 100)).rows).toEqual([]);
    }
    expect((await globalSearch({ role: "VIEWER", email: ADVISOR.email }, "Marisol"))
      .filter(r => r.type === "household" || r.type === "client")).toEqual([]);
  });

  it("shares personal keyword labels across directory, header, search and picker without rewriting source names", async () => {
    for (const query of ["Marion", "Church", "Marion Church", "Marion Church Household"]) {
      const page = await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, query }, 1, 100);
      expect(page.rows.filter(row => row.sf_id === hh(6)).map(row => row.name)).toEqual(["Church Household"]);
      expect((await globalSearch(ADVISOR, query))
        .filter(row => row.type === "household" && row.id === hh(6)).map(row => row.label))
        .toEqual(["Church Household"]);
    }
    expect((await householdHeader(ADVISOR, hh(6)))?.name).toBe("Church Household");
    const picker = await listHouseholdPickerTargets(ADVISOR);
    expect(picker.find(row => row.sf_id === hh(6))).toEqual({
      sf_id: hh(6), name: "Church Household", source_names: ["Marion Church Household"],
    });
    expect(picker.find(row => row.sf_id === hh(7))?.name).toBe("Church Family Trust Household");
    expect((await householdHeader(ADVISOR, hh(7)))?.name).toBe("Church Family Trust Household");
    const source = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM mirror.household WHERE sf_id = ${hh(6)}`;
    expect(source[0].name).toBe("Marion Church Household");
  });

  it("matches literal wildcard characters without broadening the authorized result set", async () => {
    const page = await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, query: "%_" }, 1, 100);
    expect(page.rows.map(r => r.sf_id)).toEqual([hh(5)]);
    expect((await globalSearch(ADVISOR, "%_")).filter(r => r.type === "household").map(r => r.id)).toEqual([hh(5)]);
  });

  it("filters before paging and counts one household per match across later pages", async () => {
    const filters = { ...DEFAULTS, query: "LaterPage" };
    const pages = await Promise.all([1, 2, 3].map(page => getHouseholdDirectory(ADVISOR, filters, page, 100)));
    expect(pages.map(page => page.rows.length)).toEqual([100, 100, 5]);
    expect(pages.map(page => page.total)).toEqual([205, 205, 205]);
    expect(new Set(pages.flatMap(page => page.rows.map(row => row.sf_id))).size).toBe(205);
    expect(new Set(pages.map(page => page.snapshot)).size).toBe(1);
    const exact = await getHouseholdDirectory(ADVISOR, { ...DEFAULTS, query: "LaterPage Member304" }, 1, 100);
    expect(exact.rows.map(row => row.sf_id)).toEqual([hh(304)]);
  });

  it("invalidates the scoped snapshot on a member rename while preserving source records", async () => {
    const before = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    await owner.$executeRaw`UPDATE mirror.client SET first_name = 'Josh' WHERE sf_id = ${cl(1)}`;
    const after = await getHouseholdDirectory(ADVISOR, DEFAULTS, 1, 100);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect((await globalSearch(ADVISOR, "Josh Smith")).filter(r => r.type === "household").map(r => r.id)).toEqual([hh(1)]);
    const rows = await owner.$queryRaw<Array<{ name: string }>>`SELECT name FROM mirror.household WHERE sf_id = ${hh(1)}`;
    expect(rows[0].name).toBe("Marisol Smith & Stacey Jones Household");
  });
});
