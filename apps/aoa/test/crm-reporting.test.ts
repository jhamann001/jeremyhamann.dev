import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, querySpy, executeSpy } = vi.hoisted(() => {
  const query = vi.fn();
  const execute = vi.fn(async (..._args: unknown[]) => 1);
  return {
    querySpy: query,
    executeSpy: execute,
    scopeSpy: vi.fn(async (
      _identity: unknown,
      fn: (tx: unknown) => Promise<unknown>,
      _options: unknown,
    ) => fn({ $queryRaw: query, $executeRaw: execute })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import {
  CRM_REPORTING_LOCK_TIMEOUT_MS,
  CRM_REPORTING_ROLES,
  CRM_REPORTING_STATEMENT_TIMEOUT_MS,
  CRM_REPORTING_TRANSACTION_MAX_WAIT_MS,
  CRM_REPORTING_TRANSACTION_TIMEOUT_MS,
  canReadCrmReporting,
  getCrmReportingDatasets,
  hasCrmReportingReadContext,
} from "@/lib/data/crm-reporting";
import { parseCrmReportQuery } from "@/lib/crm/reporting-query";

const OPS = { role: "OPERATIONS", email: "ops@example.test" };

function householdRows() {
  return [{
    household_id: "001EXAMPLE00001",
    household: "Example Household",
    advisor: "Example Advisor",
    client_stage: "Client",
    aum: "1250000.50",
    accounts: 3n,
    members: 2n,
    aum_as_of: new Date("2026-08-12T00:00:00.000Z"),
    total_rows: 1n,
    total_aum: "1250000.50",
    total_accounts: "3",
    latest_aum_as_of: new Date("2026-08-12T00:00:00.000Z"),
    effective_page: 1,
    page_count: 1,
  }];
}

function dealRows() {
  return [{
    stage: "FUNDING",
    owner: "Example Owner",
    deals: 4n,
    pipeline_value: "425000.00",
    average_age_days: 18,
    overdue: 1n,
    earliest_overdue_close: new Date("2026-08-01T00:00:00.000Z"),
    next_expected_close: new Date("2026-08-29T00:00:00.000Z"),
    source_as_of: new Date("2026-08-13T12:00:00.000Z"),
    latest_source_as_of: new Date("2026-08-13T12:00:00.000Z"),
    total_rows: 1n,
    total_deals: "4",
    total_pipeline_value: "425000.00",
    total_overdue: "1",
    effective_page: 1,
    page_count: 1,
  }];
}

function engagementRows() {
  return [{
    household_id: "001EXAMPLE00001",
    household: "Example Household",
    advisor: "Example Advisor",
    open_tasks: 2n,
    last_call: new Date("2026-07-15T00:00:00.000Z"),
    last_email: new Date("2026-08-10T00:00:00.000Z"),
    last_interaction: new Date("2026-08-10T00:00:00.000Z"),
    days_since_interaction: 3,
    total_rows: 1n,
    total_open_tasks: "2",
    no_recorded_interaction: "0",
    stale_90_days: "0",
    latest_interaction: new Date("2026-08-10T00:00:00.000Z"),
    effective_page: 1,
    page_count: 1,
  }];
}

function transferRows() {
  return [{
    stage: "IN_TRANSFER",
    owner: "Example Owner",
    funding_type: "ACAT_FULL",
    transfers: 3n,
    transfer_value: "750000.00",
    average_days_in_stage: 21,
    stalled: 2n,
    open_checklist_items: "5",
    source_as_of: new Date("2026-08-13T12:00:00.000Z"),
    latest_source_as_of: new Date("2026-08-13T12:00:00.000Z"),
    total_rows: 1n,
    total_transfers: "3",
    in_flight_value: "750000.00",
    funded_value: null,
    total_stalled: "2",
    total_open_checklist_items: "5",
    effective_page: 1,
    page_count: 1,
  }];
}

function wireSuccessfulQueries() {
  querySpy.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as TemplateStringsArray).join(" ");
    if (sql.includes("mirror.client_account_aum")) return householdRows();
    if (sql.includes("FROM app.deal")) return dealRows();
    if (sql.includes("FROM mirror.activity")) return engagementRows();
    if (sql.includes("FROM app.transfer t")) return transferRows();
    throw new Error("unexpected report query");
  });
}

function queryText(call: unknown[]): string {
  const read = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(read).join(" ");
    if (value && typeof value === "object") {
      const sql = value as { sql?: string; values?: unknown[] };
      if (typeof sql.sql === "string") {
        return sql.sql;
      }
    }
    return typeof value === "string" ? value : "";
  };
  return call.map(read).join(" ").replace(/\s+/g, " ");
}

function queryValues(call: unknown[]): unknown[] {
  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const sql = value as { values?: unknown[] };
    if (Array.isArray(sql.values)) sql.values.forEach((item) => { values.push(item); visit(item); });
  };
  visit(call);
  return values;
}

describe("live CRM reporting seam", () => {
  beforeEach(() => {
    process.env.CRM_REPORTING = "1";
    scopeSpy.mockClear();
    querySpy.mockReset();
    executeSpy.mockClear();
    wireSuccessfulQueries();
  });

  afterEach(() => {
    delete process.env.CRM_REPORTING;
  });

  it("permits exactly ADMIN and OPERATIONS with a complete session", () => {
    expect([...CRM_REPORTING_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
    for (const role of ["ADMIN", "OPERATIONS"]) {
      expect(canReadCrmReporting(role)).toBe(true);
      expect(hasCrmReportingReadContext({ role, email: "reader@example.test" })).toBe(true);
    }
    for (const role of ["HEAD_OF_ADVISORY", "ADVISOR", "CLIENT_SERVICE", "VIEWER", ""]) {
      expect(canReadCrmReporting(role)).toBe(false);
    }
    expect(hasCrmReportingReadContext({ role: "OPERATIONS", email: null })).toBe(false);
  });

  it("fails before database work when disabled, forbidden, or missing context", async () => {
    delete process.env.CRM_REPORTING;
    await expect(getCrmReportingDatasets(OPS)).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });

    process.env.CRM_REPORTING = "1";
    await expect(getCrmReportingDatasets({
      role: "ADVISOR",
      email: "advisor@example.test",
    })).resolves.toEqual({ ok: false, reason: "forbidden" });
    await expect(getCrmReportingDatasets({
      role: "OPERATIONS",
      email: null,
    })).resolves.toEqual({ ok: false, reason: "missing_context" });
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("maps each selected report without exposing source or account IDs", async () => {
    const read = async (dataset: "household_aum" | "deal_pipeline" | "client_engagement" | "transfers_funding") => {
      const result = await getCrmReportingDatasets(OPS, parseCrmReportQuery({ dataset }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected reporting dataset");
      expect(result.datasets).toHaveLength(1);
      return result.datasets[0];
    };
    const household = await read("household_aum");
    const deals = await read("deal_pipeline");
    const engagement = await read("client_engagement");
    const transfers = await read("transfers_funding");

    expect(household).toMatchObject({
      available: true,
      totalRows: 1,
      page: 1,
      pageSize: 100,
      pageCount: 1,
      rows: [{
        household: "Example Household",
        advisor: "Example Advisor",
        clientStage: "Client",
        aum: 1250000.5,
        accounts: 3,
        members: 2,
        aumAsOf: "2026-08-12",
      }],
    });
    expect(deals).toMatchObject({
      available: true,
      rows: [{
        stage: "FUNDING",
        owner: "Example Owner",
        deals: 4,
        pipelineValue: 425000,
        averageAgeDays: 18,
        overdue: 1,
        earliestOverdueClose: "2026-08-01",
        nextExpectedClose: "2026-08-29",
      }],
      rowLinks: [{}],
    });
    expect(engagement).toMatchObject({
      available: true,
      rows: [{
        household: "Example Household",
        advisor: "Example Advisor",
        openTasks: 2,
        lastCall: "2026-07-15",
        lastEmail: "2026-08-10",
        lastInteraction: "2026-08-10",
        daysSinceInteraction: 3,
      }],
      metrics: [
        { label: "Households", value: 1, format: "number" },
        { label: "Open tasks", value: 2, format: "number" },
        { label: "No recorded interaction", value: 0, format: "number" },
        { label: "90+ days since interaction", value: 0, format: "number" },
        { label: "Latest interaction", value: "2026-08-10", format: "date" },
      ],
    });
    expect(transfers).toMatchObject({
      available: true,
      rows: [{
        stage: "In Transfer",
        owner: "Example Owner",
        fundingType: "ACAT Full",
        transfers: 3,
        transferValue: 750000,
        averageDaysInStage: 21,
        stalled: 2,
        openChecklistItems: 5,
      }],
      metrics: [
        { label: "Transfers", value: 3, format: "number" },
        { label: "In-flight value", value: 750000, format: "money" },
        { label: "Funded value", value: 0, format: "money" },
        { label: "14+ days in stage", value: 2, format: "number" },
        { label: "Open checklist items", value: 5, format: "number" },
      ],
      rowLinks: [{}],
    });
    for (const dataset of [household, deals, engagement, transfers]) {
      const keys = new Set(dataset.columns.map((column) => column.key));
      for (const key of dataset.defaultColumns) expect(keys.has(key)).toBe(true);
      for (const row of dataset.rows) {
        expect(Object.keys(row)).not.toContain("sf_id");
        expect(Object.keys(row)).not.toContain("account_number");
      }
    }
  });

  it("runs only the selected heavy report inside one bounded RLS transaction", async () => {
    await getCrmReportingDatasets(OPS, parseCrmReportQuery({ dataset: "deal_pipeline" }));

    expect(CRM_REPORTING_STATEMENT_TIMEOUT_MS).toBe(8_000);
    expect(CRM_REPORTING_LOCK_TIMEOUT_MS).toBe(2_000);
    expect(scopeSpy).toHaveBeenCalledTimes(1);
    for (const call of scopeSpy.mock.calls) {
      expect(call[2]).toEqual({
        timeout: CRM_REPORTING_TRANSACTION_TIMEOUT_MS,
        maxWait: CRM_REPORTING_TRANSACTION_MAX_WAIT_MS,
      });
    }
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const executedSql = executeSpy.mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(" "))
      .join(" ");
    expect(executedSql).toContain("statement_timeout");
    expect(executedSql).toContain("lock_timeout");
    expect(querySpy).toHaveBeenCalledTimes(1);
    const sql = queryText(querySpy.mock.calls[0]);
    expect(sql).toContain("FROM app.deal");
    expect(sql).not.toContain("mirror.client_account_aum");
    expect(sql).not.toContain("FROM mirror.activity");
    expect(sql).not.toContain("FROM app.transfer t");
  });

  it("returns a sanitized unavailable result for only the selected failed report", async () => {
    querySpy.mockImplementation(async (...args: unknown[]) => {
      const sql = (args[0] as TemplateStringsArray).join(" ");
      if (sql.includes("mirror.client_account_aum")) throw new Error("private database detail");
      if (sql.includes("FROM mirror.activity")) return engagementRows();
      if (sql.includes("FROM app.transfer t")) return transferRows();
      return dealRows();
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await getCrmReportingDatasets(OPS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reporting datasets");
    expect(result.datasets[0]).toMatchObject({
      id: "household_aum",
      available: false,
      rows: [],
      metrics: [],
    });
    expect(result.datasets).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({
      event: "crm_reporting_dataset_unavailable",
      datasetId: "household_aum",
    }));
    expect(consoleSpy.mock.calls.flat().join(" ")).not.toContain("private database detail");
    consoleSpy.mockRestore();
  });

  it("preserves legacy default priorities and appends deterministic tie-breakers", async () => {
    const cases = [
      ["household_aum", "aum DESC NULLS LAST, household ASC, household_id ASC"],
      ["deal_pipeline", "pipeline_value DESC, owner ASC"],
      ["client_engagement", "last_interaction ASC NULLS FIRST, open_tasks DESC, household ASC, household_id ASC"],
      ["transfers_funding", "stalled DESC, transfer_value DESC, owner ASC, funding_type ASC"],
    ] as const;
    for (const [dataset, expected] of cases) {
      querySpy.mockClear();
      await getCrmReportingDatasets(OPS, parseCrmReportQuery({ dataset }));
      expect(queryText(querySpy.mock.calls[0])).toContain(expected);
    }
  });

  it("applies search, preset-derived filters, date windows, and ranges as SQL parameters", async () => {
    await getCrmReportingDatasets(OPS, parseCrmReportQuery({
      dataset: "transfers_funding",
      search: "Spencer",
      fundingState: "missing",
      updatedWindow: "30",
      minValue: "33,333.50",
      maxValue: "150,000.25",
    }));
    const sql = queryText(querySpy.mock.calls[0]);
    expect(sql).toContain("owner ILIKE");
    expect(sql).toContain("NULLIF(funding_type, '') IS NULL");
    expect(sql).toContain("source_as_of >= CURRENT_DATE -");
    expect(sql).toContain("transfer_value >= ?");
    expect(sql).toContain("transfer_value <= ?");
    expect(queryValues(querySpy.mock.calls[0])).toContain(33333.5);
    expect(queryValues(querySpy.mock.calls[0])).toContain(150000.25);
    expect(queryValues(querySpy.mock.calls[0])).toContain("%Spencer%");
    expect(sql).not.toContain("33333.5");
  });

  it("filters DRS transfers and preserves its acronym in rows and filter options", async () => {
    querySpy.mockResolvedValueOnce([{ ...transferRows()[0], funding_type: "DRS" }]);
    const result = await getCrmReportingDatasets(OPS, parseCrmReportQuery({
      dataset: "transfers_funding",
      fundingType: "DRS",
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reporting dataset");
    const report = result.datasets[0];
    expect(report.rows[0]).toMatchObject({ fundingType: "DRS" });
    expect(report.filters.find((filter) => filter.key === "fundingType")?.options)
      .toContainEqual({ value: "DRS", label: "DRS" });
    expect(queryText(querySpy.mock.calls[0])).toContain("funding_type = ?");
    expect(queryValues(querySpy.mock.calls[0])).toContain("DRS");
  });

  it("maps each dataset's new search and date branches without changing the query seam", async () => {
    const cases = [
      ["household_aum", { search: "Spencer", aumAge: "older60" }, ["household ILIKE", "aum_as_of < CURRENT_DATE -"]],
      ["deal_pipeline", { search: "Open", dealState: "open", closeWindow: "next30" }, ["stage NOT IN", "close_date <= CURRENT_DATE +"]],
      ["client_engagement", { search: "Spencer", interactionAge: "31to60" }, ["household ILIKE", "days_since_interaction >= 31"]],
      ["transfers_funding", { search: "ACH", fundingState: "missing", updatedWindow: "90" }, ["funding_type ILIKE", "NULLIF(funding_type, '') IS NULL"]],
    ] as const;
    for (const [dataset, filters, fragments] of cases) {
      querySpy.mockClear();
      await getCrmReportingDatasets(OPS, parseCrmReportQuery({ dataset, ...filters }));
      const sql = queryText(querySpy.mock.calls[0]);
      for (const fragment of fragments) expect(sql).toContain(fragment);
    }
  });

  it("guards contradictory ranges without bypassing the report query", async () => {
    const result = await getCrmReportingDatasets(OPS, parseCrmReportQuery({
      dataset: "deal_pipeline",
      minValue: "100",
      maxValue: "99",
    }));
    expect(result.ok).toBe(true);
    const sql = queryText(querySpy.mock.calls[0]);
    expect(sql).toContain("FALSE");
  });

  it("keeps exact totals while clamping an out-of-range page", async () => {
    querySpy.mockResolvedValueOnce([{
      ...householdRows()[0],
      total_rows: 126n,
      total_aum: "9000000",
      total_accounts: "18",
      effective_page: 6,
      page_count: 6,
    }]);
    const result = await getCrmReportingDatasets(OPS, parseCrmReportQuery({ page: "999", pageSize: "25" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.datasets[0]).toMatchObject({
      page: 6,
      pageCount: 6,
      totalRows: 126,
      metrics: [
        { label: "Households", value: 126 },
        { label: "Current AUM", value: 9_000_000 },
        { label: "Accounts", value: 18 },
        { label: "Latest AUM date", value: "2026-08-12" },
      ],
    });
  });

  it("maps the always-present totals sentinel to an honest empty report", async () => {
    querySpy.mockResolvedValueOnce([{
      household_id: null,
      household: null,
      advisor: null,
      client_stage: null,
      aum: null,
      accounts: null,
      members: null,
      aum_as_of: null,
      total_rows: 0n,
      total_aum: null,
      total_accounts: null,
      latest_aum_as_of: null,
      effective_page: 1,
      page_count: 1,
    }]);
    const result = await getCrmReportingDatasets(OPS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.datasets[0]).toMatchObject({
      rows: [],
      rowLinks: [],
      totalRows: 0,
      page: 1,
      pageCount: 1,
    });
  });
});
