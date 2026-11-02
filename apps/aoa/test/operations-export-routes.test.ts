import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";
import type { TradeReconciliationRunExport } from "@/lib/operations/operations-export-csv";

const { authMock, feeReadMock, feeFlagMock, reconReadMock, reconFlagMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  feeReadMock: vi.fn(),
  feeFlagMock: vi.fn(),
  reconReadMock: vi.fn(),
  reconFlagMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/operations-fee-requests", () => ({ operationsFeeRequestExportRows: feeReadMock }));
vi.mock("@/lib/data/trade-reconciliation-export", () => ({ exportTradeReconciliationRuns: reconReadMock }));
vi.mock("@/lib/flags", () => ({
  operationsFeeRequestsPreviewEnabled: feeFlagMock,
  operationsTradeReconciliationPreviewEnabled: reconFlagMock,
}));

import { GET as exportFeeRequests } from "@/app/api/operations/fee-requests/export/route";
import { GET as exportTradeRuns } from "@/app/api/operations/trade-reconciliation/export/route";

const SCOPE = "a".repeat(64);
const feeRow = { id: "synthetic-fee-request-1", kind: "FEE_CREDIT", status: "PENDING", scope: "CLIENT", clientName: "Synthetic client", canonicalClientName: null, householdName: null, accounts: [], feeTypes: [], feeAmount: null, waiverStart: null, waiverDurationMonths: null, indefiniteDuration: false, submittedBy: "Operator", submittedAt: "2026-09-17T12:00:00.000Z", reason: "Synthetic", relevantTicketRefs: [], reviewedBy: null, reviewedAt: null, creditedAt: null, apexRequestId: null, legacyApexContext: null, completedBy: null, completedAt: null, legacySource: null, legacySourceId: null, events: [] } as OperationsFeeRequestListRow;
const runRow: TradeReconciliationRunExport = { id: "synthetic-run-1", runDate: "2026-09-17", tradeDate: "2026-09-16", completedAt: "2026-09-17T20:00:00.000Z", apexRecords: 1, meridianRecords: 1, matched: 1, explained: 0, unresolved: 0, runNote: "" };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { role: "OPERATIONS", email: "operator@example.test" }, navigationScope: SCOPE });
  feeFlagMock.mockReturnValue(true);
  reconFlagMock.mockReturnValue(true);
  feeReadMock.mockResolvedValue([feeRow]);
  reconReadMock.mockResolvedValue([runRow]);
});

describe("fee request CSV export route", () => {
  const call = (query: string) => exportFeeRequests(new Request(`https://example.test/api/operations/fee-requests/export${query}`));

  it("downloads the full authorized work area and ignores list filters by not accepting them", async () => {
    const response = await call("?area=credits");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="fee-credits.csv"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
    expect(feeReadMock).toHaveBeenCalledWith({ role: "OPERATIONS", email: "operator@example.test" }, "credits");
    expect(await response.text()).toContain("synthetic-fee-request-1");
  });

  it("uses the exceptions file for service guarantees and billing exceptions", async () => {
    const response = await call("?area=exceptions");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="service-guarantees-and-billing-exceptions.csv"');
    expect(feeReadMock).toHaveBeenCalledWith({ role: "OPERATIONS", email: "operator@example.test" }, "exceptions");
  });

  it.each(["", "?area=credits&status=PENDING", "?area=all", "?tab=credits"])("rejects %s before reading", async (query) => {
    expect((await call(query)).status).toBe(400);
    expect(feeReadMock).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "VIEWER", "CLIENT_SERVICE", "unknown"])("denies %s before reading", async (role) => {
    authMock.mockResolvedValue({ user: { role }, navigationScope: SCOPE });
    expect((await call("?area=credits")).status).toBe(403);
    expect(feeReadMock).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and disabled requests before reading", async () => {
    authMock.mockResolvedValue(null);
    expect((await call("?area=credits")).status).toBe(401);
    authMock.mockResolvedValue({ user: { role: "ADMIN" }, navigationScope: SCOPE });
    feeFlagMock.mockReturnValue(false);
    expect((await call("?area=credits")).status).toBe(403);
    expect(feeReadMock).not.toHaveBeenCalled();
  });

  it("returns a fixed error when the export read fails", async () => {
    feeReadMock.mockRejectedValue(new Error("password=synthetic-secret-only"));
    const response = await call("?area=credits");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"fee_request_export_unavailable"}');
  });
});

describe("trade reconciliation CSV export route", () => {
  const call = (query = "") => exportTradeRuns(new Request(`https://example.test/api/operations/trade-reconciliation/export${query}`));

  it("downloads every saved run for an authorized operator", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="trade-reconciliation-runs.csv"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(reconReadMock).toHaveBeenCalledWith({ role: "OPERATIONS", email: "operator@example.test" });
    expect(await response.text()).toContain("synthetic-run-1,2026-09-17,2026-09-16");
  });

  it("rejects query parameters before reading", async () => {
    expect((await call("?view=daily")).status).toBe(400);
    expect(reconReadMock).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "VIEWER"])("denies %s before reading", async (role) => {
    authMock.mockResolvedValue({ user: { role }, navigationScope: SCOPE });
    expect((await call()).status).toBe(403);
    expect(reconReadMock).not.toHaveBeenCalled();
  });

  it("rejects a disabled tool before reading", async () => {
    reconFlagMock.mockReturnValue(false);
    expect((await call()).status).toBe(403);
    expect(reconReadMock).not.toHaveBeenCalled();
  });

  it("returns a fixed error when the export read fails", async () => {
    reconReadMock.mockRejectedValue("token=synthetic-secret-only");
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"trade_reconciliation_export_unavailable"}');
  });
});
