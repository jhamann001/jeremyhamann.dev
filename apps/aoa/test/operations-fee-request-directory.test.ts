import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEE_REQUEST_FILTERS, feeRequestListHref, feeRequestPageUrl, parseFeeRequestQuery } from "@/lib/operations/fee-request-query";
import { appendFeeRequestRows, fetchFeeRequestPage } from "@/lib/operations/fee-request-pages";
import type { OperationsFeeRequestListRow } from "@/lib/data/operations-fee-requests";

const { authMock, readMock, flagMock } = vi.hoisted(() => ({ authMock: vi.fn(), readMock: vi.fn(), flagMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/operations-fee-requests", () => ({ operationsFeeRequestDirectory: readMock }));
vi.mock("@/lib/flags", () => ({ operationsFeeRequestsPreviewEnabled: flagMock }));
import { GET } from "@/app/api/operations/fee-requests/route";

const SCOPE = "a".repeat(64);
const SNAPSHOT = "b".repeat(32);
const query = (value = "") => parseFeeRequestQuery(new URLSearchParams(value));
const row = (id: string) => ({ id, kind: "FEE_CREDIT", status: "PENDING", clientName: "Synthetic client", submittedAt: "2026-09-17T12:00:00Z", accounts: [], events: [], feeTypes: [], relevantTicketRefs: [] }) as unknown as OperationsFeeRequestListRow;
const result = () => ({ rows: [row("synthetic_fee_request_001")], page: 1, pageSize: 100, pageCount: 1, total: 1,
  snapshot: SNAPSHOT, queryKey: "", counts: { pending: 1, approved: 0, credited: 0, closed: 0, total: 1 } });
const request = (value = "") => new Request(`https://example.test/api/operations/fee-requests?${value}`);

beforeEach(() => {
  vi.clearAllMocks(); authMock.mockResolvedValue({ user: { role: "OPERATIONS", email: "operator@example.test" }, navigationScope: SCOPE });
  flagMock.mockReturnValue(true); readMock.mockResolvedValue(result());
});

describe("Fee request query contract", () => {
  it("defaults to all-status fee credits, newest first and 100 rows", () => {
    expect(query()).toEqual({ filters: DEFAULT_FEE_REQUEST_FILTERS, page: 1, pageSize: 100, snapshot: null, queryKey: "" });
  });
  it("round trips complete filters and accepts inclusive Eastern dates", () => {
    const parsed = query("tab=exceptions&type=SERVICE_GUARANTEE&status=APPROVED&from=2026-09-01&to=2026-09-17&q=Synthetic&sort=waiver&dir=asc");
    expect(query(feeRequestListHref(parsed.filters).split("?")[1]).filters).toEqual(parsed.filters);
    expect(query(new URL(feeRequestPageUrl(parsed.filters, 2, SNAPSHOT, 200), "https://example.test").search.slice(1)).pageSize).toBe(200);
  });
  it.each(["q=a&q=b", "tab=all", "type=SERVICE_GUARANTEE", "tab=exceptions&sort=amount", "sort=waiver", "status=CLOSED", "dir=sideways", "from=2026-02-30", "from=2026-09-20&to=2026-09-01", "to=2026-9-1", "page=2", "page=0", "pageSize=99", "pageSize=201", "snapshot=bad", "role=ADMIN", `q=${"x".repeat(257)}`])("rejects invalid or ambiguous query %s", (value) => { expect(() => query(value)).toThrow(); });
  it("permits numbered SSR windows only when the caller explicitly omits snapshot enforcement", () => {
    expect(parseFeeRequestQuery(new URLSearchParams("page=51"), false).page).toBe(51);
  });
});

describe("Fee request paging API authorization", () => {
  it("authenticates every read and returns no-store with the current session fingerprint", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
    expect(readMock).toHaveBeenCalledWith({ role: "OPERATIONS", email: "operator@example.test" }, query());
  });
  it.each(["ADVISOR", "VIEWER", "CLIENT_SERVICE", "unknown"])("denies %s before reading", async (role) => {
    authMock.mockResolvedValue({ user: { role } }); expect((await GET(request())).status).toBe(403); expect(readMock).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated and disabled requests before reading", async () => {
    authMock.mockResolvedValue(null); expect((await GET(request())).status).toBe(401);
    authMock.mockResolvedValue({ user: { role: "ADMIN" } }); flagMock.mockReturnValue(false);
    expect((await GET(request())).status).toBe(403); expect(readMock).not.toHaveBeenCalled();
  });
  it("rejects malformed queries before reading", async () => { expect((await GET(request("pageSize=999"))).status).toBe(400); expect(readMock).not.toHaveBeenCalled(); });
  it.each([["fee_request_directory_changed", 409], ["fee_request_page_out_of_range", 416]])("returns the fixed public error for %s", async (message, status) => {
    readMock.mockRejectedValue(new Error(message)); const response = await GET(request()); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
  });
  it.each([
    new Error("database password=synthetic-secret-only; SELECT sensitive_column"),
    new Error("fee_request_directory_changed: token=synthetic-secret-only"),
    { message: "fee_request_page_out_of_range", detail: "token=synthetic-secret-only" },
    "token=synthetic-secret-only",
  ])("never reflects unexpected thrown values in the fixed unavailable response: %j", async (error) => {
    readMock.mockRejectedValue(error);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"fee_request_directory_unavailable"}');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-AOA-Navigation-Scope")).toBe(SCOPE);
  });
});

describe("Fee request client paging guards", () => {
  const fetchPage = (response: Response) => fetchFeeRequestPage(DEFAULT_FEE_REQUEST_FILTERS, 1, null, 100, new AbortController().signal, SCOPE, vi.fn().mockResolvedValue(response));
  const response = (value: unknown = result(), scope = SCOPE) => Response.json(value, { headers: { "X-AOA-Navigation-Scope": scope } });
  it("accepts a bounded full-query response", async () => { expect((await fetchPage(response())).rows).toHaveLength(1); });
  it("rejects a changed login before reading its rows", async () => { await expect(fetchPage(response(result(), "c".repeat(64)))).rejects.toMatchObject({ kind: "unauthorized" }); });
  it.each([401, 403, 409, 416, 503])("classifies HTTP %i", async (status) => {
    await expect(fetchPage(new Response(null, { status }))).rejects.toMatchObject({ kind: [401, 403].includes(status) ? "unauthorized" : [409, 416].includes(status) ? "changed" : "unavailable" });
  });
  it("rejects wrong query, partial rows, or first-page-only counts", async () => {
    for (const value of [{ ...result(), queryKey: "q=other" }, { ...result(), total: 2 }, { ...result(), counts: { ...result().counts, pending: 0 } }]) {
      await expect(fetchPage(response(value))).rejects.toMatchObject({ kind: "changed" });
    }
  });
  it("rejects duplicate boundary rows instead of silently dropping them", () => {
    expect(() => appendFeeRequestRows([row("synthetic_fee_request_001")], [row("synthetic_fee_request_001")])).toThrow("changed");
  });
});
