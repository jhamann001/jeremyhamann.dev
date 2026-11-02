import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, querySpy, executeSpy } = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  querySpy: vi.fn(),
  executeSpy: vi.fn(),
}));

vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/flags", () => ({ crmIdentityReadsEnabled: () => true }));

import { getClientDirectory } from "@/lib/data/clients";
import { getHouseholdDirectory } from "@/lib/data/households";

const OPS = { role: "OPERATIONS", email: "ops@example.test" };

describe("bounded directory query seams", () => {
  beforeEach(() => {
    querySpy.mockReset();
    executeSpy.mockReset();
    scopeSpy.mockReset();
    scopeSpy.mockImplementation(async (_identity, fn) => fn({ $queryRaw: querySpy, $executeRaw: executeSpy }));
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns only the database-bounded Client Portrait page", async () => {
    querySpy.mockResolvedValue([{
      rows: [{
        sf_id: "client-1",
        name: "Client One",
        household_id: "household-1",
        household_name: "Household One",
        household_stage: "Client",
        lead_advisor_email: "advisor@example.test",
        advisor_name: "Advisor",
        employeeStatus: null,
      }],
      total: 205n,
      page: 2n,
      page_count: 3n,
      counts: {
        all: 220,
        client: 205,
        prospect: 10,
        lost_prospect: 2,
        lost_client: 3,
      },
    }]);

    const result = await getClientDirectory(
      OPS,
      { query: "one", stage: "client", sortKey: "name", sortDir: "asc" },
      2,
      100,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(205);
    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(3);
    expect(result.counts.client).toBe(205);
    const sql = (querySpy.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
    expect(sql).toContain("page_meta");
    expect(sql).toContain("current_employee_status AS MATERIALIZED");
    expect(sql.match(/app\.employee_badge_is_current\(/g)).toHaveLength(1);
    expect(sql).toContain("es.client_sf_id IS NOT NULL");
    expect(sql.match(/LEFT JOIN current_employee_status es/g)).toHaveLength(2);
    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect((executeSpy.mock.calls[0][0] as TemplateStringsArray).join("?")).toContain("set_config('jit', 'off', true)");
    // Keep the existing transaction budget instead of masking slow reads.
    expect(scopeSpy.mock.calls[0][2]).toEqual({ timeout: 5_000, maxWait: 2_000 });
  });

  it("returns household rows, KPIs, options, and AUM from one bounded query", async () => {
    querySpy.mockResolvedValue([{
      snapshot: "a".repeat(32),
      rows: [{
        sf_id: "household-1",
        name: "Household One",
        status: "Active",
        stage: "Client",
        aum: "125000.50",
        lead_advisor_email: "advisor@example.test",
        household_kind: "CLIENT",
        member_count: 2,
        advisor_name: "Advisor",
        aum_source: "apex",
        employeeStatus: "ACTIVE",
      }],
      total: 232n,
      page: 1n,
      page_count: 3n,
      counts: { all: 240, client: 232, lost_client: 4 },
      summary_counts: { clients: 232, prospects: 3, lost: 5 },
      advisor_options: [{ value: "advisor@example.test", label: "Advisor" }],
      status_options: ["Active"],
      aum_total: "1000000.25",
      aum_firm: "100000.25",
      aum_employee: "250000.10",
      aum_available: true,
    }]);

    const result = await getHouseholdDirectory(
      OPS,
      {
        query: "",
        stage: "client",
        advisor: "",
        status: "",
        sortKey: "name",
        sortDir: "asc",
      },
      1,
      100,
    );

    expect(result.rows[0]).toMatchObject({
      aum: 125000.5,
      member_count: 2,
      employeeStatus: "ACTIVE",
    });
    expect(result.snapshot).toBe("a".repeat(32));
    expect(result.summaryCounts).toEqual({ clients: 232, prospects: 3, lost: 5 });
    expect(result.aumSplit).toEqual({
      total: 1000000.25,
      firm: 100000.25,
      employee: 250000.1,
      available: true,
      employeeScopeComplete: true,
      sources: [],
    });
    expect(result.advisorOptions).toEqual([
      { value: "advisor@example.test", label: "Advisor" },
    ]);
    expect(querySpy).toHaveBeenCalledOnce();
    const sql = (querySpy.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain("account_base AS MATERIALIZED");
    expect(sql).toContain("directory_version AS");
    expect(sql).toContain("ORDER BY row_order");
    expect(sql).toContain("sf_id ASC");
    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
  });
});
