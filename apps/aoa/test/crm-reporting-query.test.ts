import { describe, expect, it } from "vitest";
import {
  CRM_PINNED_REPORT_VIEWS,
  CRM_REPORT_PRESETS,
  crmPinnedReportHref,
  crmReportHref,
  formatCrmReportSourceAsOf,
  parseCrmReportQuery,
} from "@/lib/crm/reporting-query";

describe("CRM reporting URL state", () => {
  it("preserves DRS funding filters through report links and pagination", () => {
    const query = parseCrmReportQuery({
      dataset: "transfers_funding",
      fundingType: "DRS",
    });
    expect(query.filters).toEqual({ fundingType: "DRS" });

    const href = crmReportHref(query, { page: 2 });
    const params = new URL(href, "https://example.test").searchParams;
    expect(parseCrmReportQuery(Object.fromEntries(params))).toMatchObject({
      dataset: "transfers_funding",
      page: 2,
      filters: { fundingType: "DRS" },
    });
  });

  it("accepts only bounded pagination, known datasets, sorts, columns, and filters", () => {
    expect(parseCrmReportQuery({
      dataset: "deal_pipeline",
      page: "2",
      pageSize: "50",
      sort: "pipelineValue",
      direction: "asc",
      columns: ["stage", "pipelineValue", "not-a-column"],
      owner: " Example Owner ",
      advisor: "ignored for this dataset",
    })).toEqual({
      dataset: "deal_pipeline",
      page: 2,
      pageSize: 50,
      sort: "pipelineValue",
      direction: "asc",
      columns: ["stage", "pipelineValue"],
      columnsExplicit: true,
      filters: { owner: "Example Owner" },
    });
  });

  it("falls back safely for malformed or cross-dataset input", () => {
    expect(parseCrmReportQuery({
      dataset: "unknown",
      page: "-4",
      pageSize: "1000",
      sort: "DROP TABLE app.deal",
      direction: "sideways",
      minAum: "1,500",
      owner: "ignored",
    })).toMatchObject({
      dataset: "household_aum",
      page: 1,
      pageSize: 100,
      sort: "aum",
      direction: "desc",
      filters: { minAum: "1500" },
    });
  });

  it("resets incompatible report state when the dataset selector changes", () => {
    expect(parseCrmReportQuery({
      currentDataset: "household_aum",
      dataset: "transfers_funding",
      page: "9",
      sort: "aum",
      direction: "asc",
      columns: ["stage", "owner"],
      owner: "Old filter",
    })).toEqual({
      dataset: "transfers_funding",
      page: 1,
      pageSize: 100,
      sort: "stage",
      direction: "asc",
      columns: [],
      columnsExplicit: false,
      filters: {},
    });
  });

  it("builds bookmarkable pagination links that retain filters and columns", () => {
    const query = parseCrmReportQuery({
      dataset: "client_engagement",
      advisor: "A. Advisor",
      interactionAge: "older90",
      columns: "household,lastInteraction",
    });
    expect(crmReportHref(query, { page: 3 })).toBe(
      "/reporting?dataset=client_engagement&page=3&columnsSubmitted=1&columns=household%2ClastInteraction&advisor=A.+Advisor&interactionAge=older90",
    );
  });

  it("represents an explicitly empty column selection without restoring defaults", () => {
    const query = parseCrmReportQuery({
      dataset: "deal_pipeline",
      columnsSubmitted: "1",
    });
    expect(query.columnsExplicit).toBe(true);
    expect(query.columns).toEqual([]);
    expect(crmReportHref(query)).toBe(
      "/reporting?dataset=deal_pipeline&columnsSubmitted=1",
    );
  });

  it("formats date-only source freshness in UTC without a prior-day shift", () => {
    expect(formatCrmReportSourceAsOf("2026-08-12")).toBe("Aug 12, 2026");
  });

  it("normalizes comma-formatted decimal ranges and rejects contradictory bounds", () => {
    const query = parseCrmReportQuery({
      dataset: "deal_pipeline",
      minValue: "33,333.50",
      maxValue: "150,000.25",
      search: "  Spencer  ",
    });
    expect(query.filters).toMatchObject({
      minValue: "33333.5",
      maxValue: "150000.25",
      search: "Spencer",
    });
    expect(parseCrmReportQuery({ dataset: "deal_pipeline", minValue: "1,2,3" }).filters).toEqual({});
    expect(parseCrmReportQuery({ dataset: "deal_pipeline", minValue: "1e4" }).filters).toEqual({});
    expect(parseCrmReportQuery({
      dataset: "household_aum",
      minAum: "5000",
      maxAum: "4999.99",
    }).rangeError).toBe("Minimum cannot be greater than maximum.");
  });

  it("keeps date shortcuts and presets visible as ordinary allowlisted filters", () => {
    expect(parseCrmReportQuery({
      dataset: "client_engagement",
      interactionAge: "31to60",
    }).filters).toEqual({ interactionAge: "31to60" });
    const preset = CRM_REPORT_PRESETS.deal_pipeline.find((item) => item.id === "open-pipeline");
    expect(preset?.filters).toEqual({ dealState: "open" });
    const presetQuery = parseCrmReportQuery({ dataset: "deal_pipeline", ...(preset?.filters ?? {}) });
    expect(presetQuery.filters).toEqual({ dealState: "open" });
    expect(crmReportHref(presetQuery)).toContain("dealState=open");
    expect(crmReportHref(presetQuery, { filters: {} })).not.toContain("dealState=");
  });

  it("resets to the first page while retaining other URL state when filters change", () => {
    const query = parseCrmReportQuery({
      dataset: "transfers_funding",
      page: "7",
      columns: "stage,transferValue",
      search: "wire",
    });
    expect(crmReportHref({ ...query, page: 1 }, { filters: { ...query.filters, stalledState: "stalled" } })).toContain(
      "columns=stage%2CtransferValue&search=wire&stalledState=stalled",
    );
    expect(crmReportHref({ ...query, page: 1 }, { filters: {} })).not.toContain("search=");
  });

  it("builds the four pinned operating reports from allowlisted URL state", () => {
    expect(CRM_PINNED_REPORT_VIEWS.map((view) => [view.id, crmPinnedReportHref(view)])).toEqual([
      ["aum-needs-review", "/reporting?aumAge=older30"],
      ["open-pipeline", "/reporting?dataset=deal_pipeline&dealState=open"],
      ["stale-engagement", "/reporting?dataset=client_engagement&interactionAge=older90"],
      ["stalled-transfers", "/reporting?dataset=transfers_funding&stalledState=stalled"],
    ]);
  });
});
