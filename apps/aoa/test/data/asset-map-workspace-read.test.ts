import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requestMock, getIdTokenClientMock, GoogleAuthMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  const getIdTokenClientMock = vi.fn(async () => ({ request: requestMock }));
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient: getIdTokenClientMock };
  });
  return { requestMock, getIdTokenClientMock, GoogleAuthMock };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: GoogleAuthMock }));

import type { Prisma } from "@prisma/client";
import {
  fetchAssetMapHouseholdLiveExtras,
  fetchAssetMapScheduleStatus,
  householdStatusFromTallies,
  readAssetMapBulkOffset,
  readAssetMapHousehold,
  readAssetMapHouseholdList,
} from "@/lib/data/asset-map";

const BASE = "https://pipeline.example.test";
const queryRaw = vi.fn();
const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

function sql(callIndex: number): string {
  return (queryRaw.mock.calls[callIndex][0] as string[]).join("?");
}

const HOUSEHOLD_ROW = { id: "hh-1", client_name: "Synthetic Client A", processed_at: new Date("2026-09-01T12:00:00Z"), status_tallies: null };

function accountRow(extra: Record<string, unknown> = {}) {
  return {
    id: "acc-1", custodian: "Synthetic Custodian", account_type: "Individual", account_type_other: null,
    account_number: "000000001234", account_holder: "Synthetic Client A", statement_date: null,
    statement_age_days: null, is_stale: false, total_value: "1000.00", is_rollover: false,
    is_inherited: false, inherited_notes: null, apex_restriction: null, cost_basis_status: null,
    validation_status: null, validation_issues: null, custodian_intel: null, ...extra,
  };
}

function positionRow(extra: Record<string, unknown> = {}) {
  return {
    id: "pos-1", account_id: "acc-1", symbol: "SYNA", description: "Synthetic Fund A", asset_type: "ETF",
    quantity: "10.500000", market_value: "500.25", transfer_eligible: "ACAT", effective_status: null,
    transfer_notes: null, effective_notes: null, cost_basis: "400.00", cost_basis_granularity: "lot",
    transferring: null, lots: null, ...extra,
  };
}

function page(households: unknown[]) {
  return { status: 200, data: { page: 1, per_page: 200, total: 1000, households } };
}

beforeEach(() => {
  queryRaw.mockReset();
  requestMock.mockReset();
  getIdTokenClientMock.mockClear();
  vi.stubEnv("STATEMENT_PIPELINE_URL", BASE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("asset-map workspace mirror reads", () => {
  it("list reads every household run with no superseded filter and maps ISO dates and counts", async () => {
    queryRaw.mockResolvedValueOnce([
      { id: "hh-1", client_name: "Synthetic Client A", run_number: 2, processed_at: new Date("2026-09-01T12:00:00Z"), superseded_by: null, total_accounts: 3, total_positions: 9, status_tallies: { acat_count: 5, review_count: 1 } },
      { id: "hh-0", client_name: "Synthetic Client A", run_number: 1, processed_at: null, superseded_by: "hh-1", total_accounts: null, total_positions: null, status_tallies: null },
    ]);
    const list = await readAssetMapHouseholdList(tx);
    const q = sql(0);
    expect(q).toContain("FROM mirror.acat_asset_map_household");
    expect(q).toContain("total_positions, status_tallies");
    expect(q).not.toContain("WHERE");
    expect(q).not.toContain("superseded_by IS NULL");
    expect(q).toContain("ORDER BY client_name NULLS LAST, processed_at DESC NULLS LAST, id");
    expect(q).toContain("LIMIT 20000");
    expect(list).toEqual([
      { id: "hh-1", clientName: "Synthetic Client A", runNumber: 2, processedAt: "2026-09-01T12:00:00.000Z", supersededBy: null, totalAccounts: 3, totalPositions: 9, status: "caution" },
      { id: "hh-0", clientName: "Synthetic Client A", runNumber: 1, processedAt: null, supersededBy: "hh-1", totalAccounts: null, totalPositions: null, status: "neutral" },
    ]);
  });

  it("household status is the worst routing status in status_tallies", () => {
    const all = { acat_count: 1, transfer_count: 1, review_count: 1, liquidate_count: 1, unsupported_count: 1 };
    expect(householdStatusFromTallies(all)).toBe("blocked");
    expect(householdStatusFromTallies({ ...all, unsupported_count: 0 })).toBe("attention");
    expect(householdStatusFromTallies({ ...all, unsupported_count: 0, liquidate_count: 0 })).toBe("caution");
    expect(householdStatusFromTallies({ acat_count: 2 })).toBe("ok");
    expect(householdStatusFromTallies({ transfer_count: 1 })).toBe("ok");
    expect(householdStatusFromTallies({ acat_count: 0, review_count: "x" })).toBe("neutral");
    expect([null, undefined, "bad", []].map(householdStatusFromTallies)).toEqual(["neutral", "neutral", "neutral", "neutral"]);
  });

  it("household read returns null when the household id is not found", async () => {
    queryRaw.mockResolvedValueOnce([]);
    expect(await readAssetMapHousehold(tx, "missing")).toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual(["missing"]);
  });

  it("household read excludes deleted accounts and returns only masked account numbers", async () => {
    queryRaw
      .mockResolvedValueOnce([HOUSEHOLD_ROW])
      .mockResolvedValueOnce([accountRow()])
      .mockResolvedValueOnce([positionRow()]);
    const view = await readAssetMapHousehold(tx, "hh-1");
    expect(sql(1)).toContain("is_deleted IS NOT TRUE");
    expect(sql(1)).toContain("ORDER BY custodian NULLS LAST, account_type NULLS LAST, id");
    expect(sql(2)).toContain("account_id = ANY(");
    expect(queryRaw.mock.calls[2].slice(1)).toEqual([["acc-1"]]);
    expect(view?.accounts[0].accountNumberMasked).toBe("••••1234");
    expect(JSON.stringify(view)).not.toContain("000000001234");
  });

  it("household read coerces numerics and parses lots, custodian intel, validation issues, and document counts", async () => {
    queryRaw
      .mockResolvedValueOnce([{ ...HOUSEHOLD_ROW, status_tallies: { docs_total: 3, docs_extracted: 2, acat_count: 1 } }])
      .mockResolvedValueOnce([
        accountRow({
          validation_issues: ["synthetic issue", 7, null],
          custodian_intel: { dtcc_number: "0123", acat_timeline: "5-7 business days", extra: true },
        }),
        accountRow({ id: "acc-2", validation_issues: "not-an-array", custodian_intel: ["bad"] }),
      ])
      .mockResolvedValueOnce([
        positionRow({ lots: [{ acquisition_date: "2020-01-02", quantity: "2", cost_basis: 40 }, "bad", null] }),
        positionRow({ id: "pos-2", account_id: "acc-2", lots: { not: "array" }, quantity: null, cost_basis: null }),
      ]);
    const view = await readAssetMapHousehold(tx, "hh-1");
    expect(view?.docsTotal).toBe(3);
    expect(view?.docsExtracted).toBe(2);
    const [a1, a2] = view!.accounts;
    expect(a1.totalValue).toBe(1000);
    expect(a1.validationIssues).toEqual(["synthetic issue"]);
    expect(a1.custodianIntel).toEqual({ dtccNumber: "0123", acatTimeline: "5-7 business days" });
    expect(a1.positions[0]).toMatchObject({ quantity: 10.5, marketValue: 500.25, costBasis: 400 });
    expect(a1.positions[0].lots).toEqual([{ acquisitionDate: "2020-01-02", quantity: 2, costBasis: 40 }]);
    expect(a2.validationIssues).toEqual([]);
    expect(a2.custodianIntel).toBeNull();
    expect(a2.positions[0]).toMatchObject({ quantity: null, costBasis: null, lots: [] });
  });

  it("household read turns a statement_date Date into a YYYY-MM-DD string", async () => {
    queryRaw
      .mockResolvedValueOnce([HOUSEHOLD_ROW])
      .mockResolvedValueOnce([accountRow({ statement_date: new Date("2026-08-15T00:00:00.000Z") })])
      .mockResolvedValueOnce([]);
    const view = await readAssetMapHousehold(tx, "hh-1");
    expect(view?.accounts[0].statementDate).toBe("2026-08-15");
  });

  it("asset-map module does not import the ingest connection", () => {
    expect(readFileSync("lib/data/asset-map.ts", "utf8")).not.toContain("@/lib/ingest");
  });

  it("bulk offset counts households ahead of the target in processed_at descending order and returns null when absent", async () => {
    queryRaw.mockResolvedValueOnce([{ one: 1 }]).mockResolvedValueOnce([{ n: 437 }]);
    expect(await readAssetMapBulkOffset(tx, "hh-1")).toBe(437);
    const q = sql(1);
    expect(q).toContain("COUNT(*)::int AS n");
    expect(q).toContain("o.processed_at > t.processed_at");
    expect(q).toContain("o.processed_at = t.processed_at AND o.id < t.id");
    expect(q).toContain("o.processed_at IS NULL AND t.processed_at IS NOT NULL");
    expect(queryRaw.mock.calls[1].slice(1)).toEqual(["hh-1"]);

    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce([]);
    expect(await readAssetMapBulkOffset(tx, "missing")).toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("asset-map workspace live reads", () => {
  it("schedule status requests GET base/api/schedule-status with the OIDC client and maps the fields", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      data: { active: true, scan_interval_minutes: 15, business_days: "Mon–Fri", business_hours: "8:00 AM – 7:00 PM ET" },
    });
    const status = await fetchAssetMapScheduleStatus(BASE);
    expect(getIdTokenClientMock).toHaveBeenCalledWith(BASE);
    expect(requestMock.mock.calls[0][0]).toMatchObject({ url: `${BASE}/api/schedule-status`, method: "GET" });
    expect(status).toEqual({ active: true, scanIntervalMinutes: 15, businessDays: "Mon–Fri", businessHours: "8:00 AM – 7:00 PM ET" });
  });

  it("schedule status returns null for a non-200 response and logs only the status", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    requestMock.mockResolvedValue({ status: 503, data: { detail: "synthetic body" } });
    expect(await fetchAssetMapScheduleStatus(BASE)).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith("[asset-map] schedule_status=503");
  });

  it("schedule status returns null when the transport throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getIdTokenClientMock.mockRejectedValueOnce(new Error("no credential"));
    await expect(fetchAssetMapScheduleStatus(BASE)).resolves.toBeNull();
    requestMock.mockRejectedValueOnce(new Error("network"));
    await expect(fetchAssetMapScheduleStatus(BASE)).resolves.toBeNull();
    expect(err).toHaveBeenCalledWith("[asset-map] schedule_transport_failed");
    expect(err.mock.calls.flat().join(" ")).not.toContain(BASE);
  });

  it("live extras read the computed bulk page and return only the target household's documents and rollover notes", async () => {
    requestMock.mockResolvedValueOnce(page([
      { id: "hh-other", doc_results: [{ filename: "other.pdf", status: "rejected" }], accounts: [{ id: "acc-x", rollover_note: "Other note", account_number: "907708109728" }] },
      {
        id: "hh-1",
        doc_results: [
          { filename: "synthetic-statement.pdf", status: "extracted", reason: null, accounts_extracted: 2, positions_extracted: 7 },
          { filename: "synthetic-bad.pdf", status: "rejected", reason: "Not a statement" },
        ],
        accounts: [
          { id: "acc-1", rollover_note: "Synthetic live rollover note", account_number: "000000001234" },
          { id: "acc-2", rollover_note: "" },
          { id: "acc-3", rollover_note: null },
        ],
      },
    ]));
    const extras = await fetchAssetMapHouseholdLiveExtras(BASE, "hh-1", 450);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect((requestMock.mock.calls[0][0] as { url: string }).url).toBe(
      `${BASE}/api/v1/households?page=3&per_page=200&include_superseded=true`,
    );
    expect(extras).toEqual({
      docResults: [
        { filename: "synthetic-statement.pdf", status: "extracted", reason: null, accountsExtracted: 2, positionsExtracted: 7 },
        { filename: "synthetic-bad.pdf", status: "rejected", reason: "Not a statement", accountsExtracted: null, positionsExtracted: null },
      ],
      rolloverNotes: { "acc-1": "Synthetic live rollover note" },
      review: { reviewedAt: null, reviewedBy: null, updatedAt: null },
    });
    const json = JSON.stringify(extras);
    expect(json).not.toContain("other.pdf");
    expect(json).not.toContain("000000001234");
  });

  it("live extras try the next and previous page and return null when the household is not found", async () => {
    requestMock
      .mockResolvedValueOnce(page([{ id: "hh-a" }]))
      .mockResolvedValueOnce(page([{ id: "hh-b" }]))
      .mockResolvedValueOnce(page([{ id: "hh-c" }]));
    expect(await fetchAssetMapHouseholdLiveExtras(BASE, "hh-1", 450)).toBeNull();
    const pages = requestMock.mock.calls.map((c) => new URL((c[0] as { url: string }).url).searchParams.get("page"));
    expect(pages).toEqual(["3", "4", "2"]);

    requestMock.mockReset();
    requestMock.mockResolvedValueOnce(page([{ id: "hh-a" }])).mockResolvedValueOnce(page([{ id: "hh-1", doc_results: [], accounts: [] }]));
    expect(await fetchAssetMapHouseholdLiveExtras(BASE, "hh-1", 0)).toEqual({
      docResults: [], rolloverNotes: {}, review: { reviewedAt: null, reviewedBy: null, updatedAt: null },
    });
    const firstPages = requestMock.mock.calls.map((c) => new URL((c[0] as { url: string }).url).searchParams.get("page"));
    expect(firstPages).toEqual(["1", "2"]);
  });

  it("live extras carry the review time, reviewer, and last change of the target household", async () => {
    requestMock.mockResolvedValueOnce(page([
      { id: "hh-other", reviewed_at: "2026-01-01T00:00:00+00:00", reviewed_by: "other@example.invalid", updated_at: "2026-01-02T00:00:00+00:00" },
      {
        id: "hh-1", doc_results: [], accounts: [],
        reviewed_at: "2026-10-04T13:00:00.123456-04:00",
        reviewed_by: "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com",
        updated_at: "2026-10-04T12:00:00-04:00",
      },
    ]));
    const extras = await fetchAssetMapHouseholdLiveExtras(BASE, "hh-1", 0);
    expect(extras?.review).toEqual({
      reviewedAt: "2026-10-04T13:00:00.123456-04:00",
      reviewedBy: "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com",
      updatedAt: "2026-10-04T12:00:00-04:00",
    });
  });
});
