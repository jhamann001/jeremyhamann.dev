import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { markCase } from "@/lib/test-flywheel";

const verifySecurityReconCaller = vi.fn();
const applyAcatPatch = vi.fn();
const mockRequest = vi.fn();
vi.mock("@/lib/machine-auth", () => ({ verifySecurityReconCaller }));
vi.mock("@/lib/acat-record-write", () => ({ applyAcatPatch }));
vi.mock("@/lib/gcp-auth", () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({
    request: (...args: unknown[]) => mockRequest(...args),
  }),
}));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET, POST } = await import("./route");
const accounts = await import("./accounts/route");
const { prisma } = await import("@/lib/prisma");
const { rateLimit } = await import("@/lib/rate-limit-redis");

const CALLER = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const RECORD_ID = "REC-1";
const SUITE = "machine-security-recon";
const params = { params: Promise.resolve({ id: RECORD_ID }) };
const findUnique = prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>;

const baseRecord = {
  id: RECORD_ID,
  clientName: "Secret Client Name",
  mappingSource: "GCP Project API",
  apexSource: "Not uploaded",
  mappingSyncedAt: "2026-10-12T14:00:00.000Z",
  statementAccountNumber: "PIN-10000098" as string | null,
  mappingAccountId: null,
  mappingAccountSummary: {
    id: "11111111-1111-4111-8111-111111111111",
    clientName: "Jane Doe",
    holder: "Jane Doe",
    custodian: "Schwab",
    registration: "Individual",
    accountNumberLast4: "0098",
    investorNumberLast4: "7777",
    statementDate: "2026-09-30",
    processedAt: "2026-10-01T00:00:00Z",
    isHistorical: false,
    positionCount: 3,
  },
  assets: [
    { id: "A1", symbol: "AAPL", description: "Apple", cusip: "037833100", expectedQty: 10, actualQty: 10, mapStatus: "Mapped", issue: null, notes: null, amount: null, assetClass: null },
    { id: "A2", symbol: "MSFT", description: "Microsoft", cusip: null, expectedQty: 5, actualQty: 0, mapStatus: "Expected", issue: null, notes: "watch", amount: 900, assetClass: "Equity" },
    { id: "A3", symbol: "TSLA", description: "Tesla", cusip: null, expectedQty: 3, actualQty: 1, mapStatus: "Unmapped", issue: "Qty Mismatch", notes: null, amount: null, assetClass: null },
  ],
};

function req(method: "GET" | "POST", body?: unknown, path = "security-recon") {
  return new Request(`http://localhost/api/machine/acats/by-record/${RECORD_ID}/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function storedSnapshot(record = baseRecord) {
  findUnique.mockResolvedValue(record);
  const response = await GET(req("GET"), params);
  return response.json();
}

const apexCsv = "Symbol,CUSIP,Quantity\nAAPL,037833100,10\n";
const mappingCsv =
  "Account Number,Symbol,CUSIP,Description,Quantity\nPIN-10000098,AAPL,037833100,Apple,12\n";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EPIC_ACAT_SECURITY_RECON = "1";
  process.env.ROLLOUT_ACAT_SECURITY_RECON = "1";
  process.env.GCP_ASSET_MAPPING_URL = "https://mapping.test";
  verifySecurityReconCaller.mockResolvedValue({ email: CALLER });
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 29 });
  findUnique.mockReset();
  findUnique.mockResolvedValue(baseRecord);
  mockRequest.mockReset();
});

describe("/api/machine/acats/by-record/[id]/security-recon", () => {
  it("returns 404 while either security recon flag is off", async () => {
    for (const [epic, rollout] of [["0", "1"], ["1", "0"]]) {
      process.env.EPIC_ACAT_SECURITY_RECON = epic;
      process.env.ROLLOUT_ACAT_SECURITY_RECON = rollout;
      for (const response of [
        await GET(req("GET"), params),
        await POST(req("POST", { action: "refresh" }), params),
      ]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    }
    expect(verifySecurityReconCaller).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    markCase(SUITE, "returns 404 while either security recon flag is off");
  });

  it("returns unauthorized without querying Prisma", async () => {
    verifySecurityReconCaller.mockResolvedValue(null);
    const read = await GET(req("GET"), params);
    const write = await POST(req("POST", { action: "refresh" }), params);
    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(await read.json()).toEqual({ error: "unauthorized" });
    expect(findUnique).not.toHaveBeenCalled();
    markCase(SUITE, "returns unauthorized without querying Prisma");
  });

  it("returns the stored snapshot with stored counts", async () => {
    const response = await GET(req("GET"), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: RECORD_ID, deletedAt: null },
      include: { assets: true },
    });
    expect(body.counts).toEqual({ total: 3, matched: 2, issues: 1, reconRate: 67 });
    expect(body.positions.map((p: { status: string }) => p.status)).toEqual(["Matched", "Expected", "Mismatch"]);
    expect(body.sourceAccount.clientName).toBe("Jane Doe");
    expect(body.sourceAccount).not.toHaveProperty("investorNumberLast4");
    expect(body.hasStatementAccount).toBe(true);
    expect(body).not.toHaveProperty("clientName");
    expect(body).not.toHaveProperty("statementAccountNumber");
    expect(JSON.stringify(body)).not.toContain("10000098");
    expect(JSON.stringify(body)).not.toContain("Secret Client Name");
    markCase(SUITE, "returns the stored snapshot with stored counts");
  });

  it("refresh returns the synced snapshot", async () => {
    const updated = { ...baseRecord, mappingSyncedAt: "2026-10-13T15:00:00.000Z" };
    findUnique.mockReset();
    findUnique.mockResolvedValueOnce(baseRecord).mockResolvedValueOnce(updated);
    mockRequest.mockResolvedValue({
      status: 200,
      data: {
        account_number: "PIN-10000098",
        positions: [{ symbol: "AAPL", description: "Apple", quantity: 10, asset_type: "Equity", market_value: 1000 }],
      },
    });
    const response = await POST(req("POST", { action: "refresh" }), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lastSynced).toBe("2026-10-13T15:00:00.000Z");
    expect(body.counts).toEqual({ total: 3, matched: 2, issues: 1, reconRate: 67 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    markCase(SUITE, "refresh returns the synced snapshot");
  });

  it("refresh refusal returns the stored snapshot as the whole body", async () => {
    const before = await storedSnapshot();
    mockRequest.mockRejectedValue({ response: { status: 404 } });
    const response = await POST(req("POST", { action: "refresh" }), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(before);
    expect(response.headers.get("x-recon-refusal")).toBe(
      "This account is not available in asset mapping. Choose a mapping account, verify the statement number, or upload the mapping CSV.",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    markCase(SUITE, "refresh refusal returns the stored snapshot as the whole body");
  });

  it("apex upload returns a preview without writing", async () => {
    const response = await POST(req("POST", { action: "upload", kind: "apex", filename: "apex.csv", text: apexCsv }), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.preview.apexFormat).toBe("activities");
    expect(body.preview.positions.map((p: { symbol: string; status: string }) => [p.symbol, p.status])).toEqual(
      expect.arrayContaining([["AAPL", "Matched"]]),
    );
    expect(body.preview.counts.total).toBe(body.preview.positions.length);
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(body.positions).toEqual((await storedSnapshot()).positions);
    markCase(SUITE, "apex upload returns a preview without writing");
  });

  it("mapping spreadsheet upload persists and returns the stored snapshot", async () => {
    const updated = { ...baseRecord, mappingSource: "Spreadsheet Upload" };
    findUnique.mockReset();
    findUnique.mockResolvedValueOnce(baseRecord).mockResolvedValueOnce(updated);
    const response = await POST(req("POST", { action: "upload", kind: "mapping", filename: "map.csv", text: mappingCsv }), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mappingSource).toBe("Spreadsheet Upload");
    expect(body).not.toHaveProperty("preview");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    markCase(SUITE, "mapping spreadsheet upload persists and returns the stored snapshot");
  });

  it("mapping upload with Apex-compatible headers is persisted, not previewed", async () => {
    // These headers also satisfy detectApexFormat's Activities requirement.
    const updated = { ...baseRecord, mappingSource: "Spreadsheet Upload" };
    findUnique.mockReset();
    findUnique.mockResolvedValueOnce(baseRecord).mockResolvedValueOnce(updated);
    const response = await POST(req("POST", { action: "upload", kind: "mapping", filename: "both.csv", text: mappingCsv }), params);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("preview");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    markCase(SUITE, "mapping upload with Apex-compatible headers is persisted, not previewed");
  });

  it("mapping upload over 2 MB is refused with stored positions unchanged", async () => {
    const before = await storedSnapshot();
    const text = `Account Number,Symbol,CUSIP,Description,Quantity\n${"x".repeat(2 * 1024 * 1024)}`;
    const response = await POST(req("POST", { action: "upload", kind: "mapping", filename: "big.csv", text }), params);
    expect(response.status).toBe(422);
    expect(response.headers.get("x-recon-refusal")).toBe("Mapping CSV must be 2 MB or smaller.");
    expect(await response.json()).toEqual(before);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    markCase(SUITE, "mapping upload over 2 MB is refused with stored positions unchanged");
  });

  it("unparsable upload is refused with stored positions unchanged", async () => {
    const before = await storedSnapshot();
    for (const kind of ["apex", "mapping"] as const) {
      const response = await POST(req("POST", { action: "upload", kind, filename: "bad.csv", text: "Name,Price\nAAPL,175\n" }), params);
      expect(response.status).toBe(422);
      expect(response.headers.get("x-recon-refusal")).toBeTruthy();
      expect(await response.json()).toEqual(before);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    markCase(SUITE, "unparsable upload is refused with stored positions unchanged");
  });

  it("non-csv upload is refused with the tracker message", async () => {
    const before = await storedSnapshot();
    const response = await POST(req("POST", { action: "upload", kind: "apex", filename: "apex.txt", text: apexCsv }), params);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-recon-refusal")).toBe("Please upload a .csv file.");
    expect(await response.json()).toEqual(before);
    markCase(SUITE, "non-csv upload is refused with the tracker message");
  });

  it("mapping upload without a statement account is refused", async () => {
    const record = { ...baseRecord, statementAccountNumber: null };
    const before = await storedSnapshot(record);
    const response = await POST(req("POST", { action: "upload", kind: "mapping", filename: "map.csv", text: mappingCsv }), params);
    expect(response.status).toBe(422);
    expect(response.headers.get("x-recon-refusal")).toBe("Add the statement account number before uploading a mapping CSV.");
    expect(await response.json()).toEqual(before);
    markCase(SUITE, "mapping upload without a statement account is refused");
  });

  it("invalid request body is refused with the stored snapshot", async () => {
    const before = await storedSnapshot();
    for (const body of [{ action: "nope" }, "not json", { action: "upload", kind: "other", filename: "a.csv", text: "" }]) {
      const response = await POST(req("POST", body), params);
      expect(response.status).toBe(400);
      expect(response.headers.get("x-recon-refusal")).toBe("Invalid security reconciliation request");
      expect(await response.json()).toEqual(before);
    }
    markCase(SUITE, "invalid request body is refused with the stored snapshot");
  });

  it("save refusal returns the stored snapshot as the whole body", async () => {
    const before = await storedSnapshot();
    findUnique.mockClear();
    for (const [status, error] of [[400, "Invalid asset update"], [404, "ACAT record not found"]] as const) {
      applyAcatPatch.mockResolvedValueOnce({
        kind: "response",
        response: NextResponse.json({ error }, { status }),
      });
      const response = await POST(
        req("POST", { action: "save", rows: [], apexUploaded: false, overriddenIds: [] }),
        params,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("x-recon-refusal")).toBe(error);
      expect(await response.json()).toEqual(before);
    }
    // One load per refusal; no re-read after a refused save.
    expect(findUnique).toHaveBeenCalledTimes(2);
    markCase(SUITE, "save refusal returns the stored snapshot as the whole body");
  });

  it("refresh outcomes follow the refusal table", async () => {
    const before = await storedSnapshot();
    const post = () => POST(req("POST", { action: "refresh" }), params);
    const upstream = (status: number) => mockRequest.mockRejectedValue({ response: { status } });

    for (const [status, expected] of [[404, 404], [409, 409], [401, 502]] as const) {
      upstream(status);
      const response = await post();
      expect(response.status).toBe(expected);
      expect(response.headers.get("x-recon-refusal")).toBeTruthy();
      expect(await response.json()).toEqual(before);
    }

    delete process.env.GCP_ASSET_MAPPING_URL;
    const unconfigured = await post();
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual(before);
    process.env.GCP_ASSET_MAPPING_URL = "https://mapping.test";

    const noAccount = { ...baseRecord, statementAccountNumber: "", mappingAccountId: null };
    const noAccountBefore = await storedSnapshot(noAccount);
    const missing = await post();
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual(noAccountBefore);

    findUnique.mockResolvedValue(baseRecord);
    upstream(500);
    const failed = await post();
    expect(failed.status).toBe(500);
    expect(failed.headers.get("x-recon-refusal")).toBeNull();
    const failedBody = await failed.json();
    expect(failedBody).toEqual({ error: "internal_error" });
    expect(failedBody).not.toHaveProperty("positions");
    markCase(SUITE, "refresh outcomes follow the refusal table");
  });

  it("save writes the collapsed statuses and returns stored counts", async () => {
    const updated = { ...baseRecord, apexSource: "Uploaded" };
    findUnique.mockReset();
    findUnique.mockResolvedValueOnce(baseRecord).mockResolvedValueOnce(updated);
    applyAcatPatch.mockResolvedValue({ kind: "record", record: updated });
    const rows = [
      { id: "A1", symbol: "AAPL", description: "Apple", actualQty: 10, status: "Matched", issue: null, notes: null },
      { id: "A3", symbol: "TSLA", description: "Tesla", actualQty: 1, status: "Missing", issue: "Short 2", notes: "called client" },
      { id: "apex-extra-9", symbol: "NVDA", description: "Nvidia", cusip: "67066G104", actualQty: 4, status: "Unexpected", issue: "Not in expected positions", notes: null, amount: 500, assetClass: "Equity" },
      { id: "apex-extra-10", symbol: "IGNORED", description: "Untouched", actualQty: 1, status: "Unexpected" },
    ];
    const response = await POST(
      req("POST", { action: "save", rows, apexUploaded: true, overriddenIds: ["apex-extra-9"] }),
      params,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).counts).toEqual({ total: 3, matched: 2, issues: 1, reconRate: 67 });
    expect(applyAcatPatch).toHaveBeenCalledWith({
      id: RECORD_ID,
      performedBy: CALLER,
      body: {
        apexSource: "Uploaded",
        assets: [
          { id: "A1", actualQty: 10, mapStatus: "Mapped", issue: null, notes: null },
          { id: "A3", actualQty: 1, mapStatus: "Unmapped", issue: "Short 2", notes: "called client" },
        ],
        newAssets: [
          {
            symbol: "NVDA",
            description: "Nvidia",
            cusip: "67066G104",
            expectedQty: 0,
            actualQty: 4,
            mapStatus: "Unmapped",
            issue: "Not in expected positions",
            notes: null,
            amount: 500,
            assetClass: "Equity",
          },
        ],
      },
    });

    applyAcatPatch.mockClear();
    findUnique.mockResolvedValue(baseRecord);
    await POST(req("POST", { action: "save", rows: [rows[0]], apexUploaded: false, overriddenIds: [] }), params);
    expect(applyAcatPatch.mock.calls[0][0].body).toEqual({
      assets: [{ id: "A1", actualQty: 10, mapStatus: "Mapped", issue: null, notes: null }],
    });
    markCase(SUITE, "save writes the collapsed statuses and returns stored counts");
  });

  it("save accepts rows echoed from the snapshot", async () => {
    const snapshotBody = await storedSnapshot();
    applyAcatPatch.mockResolvedValue({ kind: "record", record: baseRecord });
    const rows = snapshotBody.positions.map((p: Record<string, unknown>) => ({ ...p, cusip: p.cusip ?? null }));
    expect(rows[0]).toHaveProperty("expectedQty");
    expect(rows[0]).toHaveProperty("mapping");
    const response = await POST(
      req("POST", { action: "save", rows, apexUploaded: false, overriddenIds: [] }),
      params,
    );
    expect(response.status).toBe(200);
    expect(applyAcatPatch.mock.calls[0][0].body.assets).toHaveLength(3);
    markCase(SUITE, "save accepts rows echoed from the snapshot");
  });

  it("apex upload on a record with no assets previews only the file's rows", async () => {
    findUnique.mockResolvedValue({ ...baseRecord, assets: [] });
    const text = "Symbol,CUSIP,Quantity\nXYZ,123456789,5\n";
    const response = await POST(req("POST", { action: "upload", kind: "apex", filename: "apex.csv", text }), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.positions).toEqual([]);
    expect(body.preview.positions.map((p: { status: string }) => p.status)).toEqual(["Unexpected"]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    markCase(SUITE, "apex upload on a record with no assets previews only the file's rows");
  });

  it("empty save patches with no position rows", async () => {
    const before = await storedSnapshot();
    applyAcatPatch.mockResolvedValue({ kind: "record", record: baseRecord });
    const response = await POST(
      req("POST", { action: "save", rows: [], apexUploaded: true, overriddenIds: [] }),
      params,
    );
    expect(response.status).toBe(200);
    expect(applyAcatPatch.mock.calls[0][0].body).toEqual({ apexSource: "Uploaded", assets: [] });
    expect((await response.json()).positions).toEqual(before.positions);
    markCase(SUITE, "empty save patches with no position rows");
  });

  it("returns rate_limited without querying Prisma", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false, remaining: 0 });
    const read = await GET(req("GET"), params);
    const write = await POST(req("POST", { action: "refresh" }), params);
    expect(read.status).toBe(429);
    expect(write.status).toBe(429);
    expect(await read.json()).toEqual({ error: "rate_limited" });
    expect(findUnique).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith("machine-acat-security-recon-write", CALLER, expect.objectContaining({ failClosed: true }));
    markCase(SUITE, "returns rate_limited without querying Prisma");
  });

  it("returns internal_error when storage fails", async () => {
    findUnique.mockRejectedValue(new Error("db"));
    for (const response of [
      await GET(req("GET"), params),
      await POST(req("POST", { action: "refresh" }), params),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
    }
    markCase(SUITE, "returns internal_error when storage fails");
  });
});

describe("/api/machine/acats/by-record/[id]/security-recon/accounts", () => {
  const search = (q: string) => req("GET", undefined, `security-recon/accounts?q=${encodeURIComponent(q)}`);

  it("accounts search returns masked accounts", async () => {
    findUnique.mockResolvedValue({ id: RECORD_ID });
    mockRequest.mockResolvedValue({
      status: 200,
      data: {
        truncated: true,
        accounts: [
          { id: "11111111-1111-4111-8111-111111111111", client_name: "Jane Doe", account_holder: "Jane Doe", custodian: "Schwab", account_registration: "Individual", account_number: "123456789012", investor_number: "9999999" },
        ],
      },
    });
    const response = await accounts.GET(search("jane"), params);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.truncated).toBe(true);
    expect(body.accounts[0].accountNumberLast4).toBe("9012");
    expect(JSON.stringify(body)).not.toContain("123456789012");

    const short = await accounts.GET(search("j"), params);
    expect(short.status).toBe(400);
    findUnique.mockResolvedValue(null);
    const missing = await accounts.GET(search("jane"), params);
    expect(missing.status).toBe(404);
    markCase(SUITE, "accounts search returns masked accounts");
  });

  it("accounts search 404 while flags are off", async () => {
    process.env.ROLLOUT_ACAT_SECURITY_RECON = "0";
    const response = await accounts.GET(search("jane"), params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(verifySecurityReconCaller).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    markCase(SUITE, "accounts search 404 while flags are off");
  });
});
