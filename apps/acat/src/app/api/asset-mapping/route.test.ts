import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET, POST } from "./route";
import {
  isCusipFormat,
  normalizePipelineAccountNumber,
} from "@/lib/asset-mapping";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

const mockRequest = vi.fn();
vi.mock("@/lib/gcp-auth", () => ({
  getAuthenticatedClient: vi.fn().mockResolvedValue({ request: (...args: unknown[]) => mockRequest(...args) }),
}));

const { prisma } = await import("@/lib/prisma");
const { getAuthenticatedClient } = await import("@/lib/gcp-auth");

const mockAcat = {
  id: "REC-001",
  mappingSource: "GCP Project API",
  apexSource: "Uploaded",
  apexAccountId: "APEX-123",
  custodianName: "Schwab",
  transferringContra: "Charles Schwab",
  statementAccountNumber: "PIN-10000098",
  deletedAt: null,
  lastUpdated: "2025-01-01T00:00:00.000Z",
  assets: [
    { id: "A1", symbol: "AAPL", description: "Apple Inc.", cusip: "037833100", expectedQty: 1000, actualQty: 1000, mapStatus: "Mapped" },
    { id: "A2", symbol: "TSLA", description: "Tesla Inc.", cusip: "88160R101", expectedQty: 200, actualQty: 190, mapStatus: "Mapped", issue: "Qty Mismatch" },
  ],
};

const pipelinePositions = [
  { symbol: "AAPL", description: "Apple Inc.", quantity: 1050, asset_type: "Equity", market_value: 150000 },
  { symbol: "MSFT", description: "Microsoft Corp.", quantity: 300, asset_type: "Equity", market_value: 90000 },
];

const mappingContext = {
  mappingTransferStatus: "LIQUIDATE",
  mappingTransferNotes: "Reviewed: liquidate before transfer",
  mappingTransferring: false,
  mappingStatementDate: "June 1-30, 2026",
  mappingStatementAgeDays: 77,
  mappingStatementIsStale: true,
  mappingSyncedAt: "2026-09-15T14:00:00.000Z",
};

function makeGetRequest(url: string) {
  return new Request(url) as Parameters<typeof GET>[0];
}

function makePostRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/asset-mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "ops@example.com", role: "USER" } });
  vi.stubEnv("GCP_ASSET_MAPPING_URL", "https://statement-pipeline-test.run.app");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/asset-mapping", () => {
  it("returns saved source context and the actual sync timestamp without calling GCP", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockAcat,
      mappingSyncedAt: mappingContext.mappingSyncedAt,
      assets: [{ ...mockAcat.assets[0], ...mappingContext }],
    });
    const data = await (await GET(makeGetRequest("http://localhost/api/asset-mapping?acatId=REC-001"))).json();
    expect(data.lastSynced).toBe(mappingContext.mappingSyncedAt);
    expect(data.assets[0]).toMatchObject(mappingContext);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("does not invent a sync timestamp for legacy records", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    const data = await (await GET(makeGetRequest("http://localhost/api/asset-mapping?acatId=REC-001"))).json();
    expect(data.lastSynced).toBeNull();
  });
  it("returns 400 when acatId is missing", async () => {
    const res = await GET(makeGetRequest("http://localhost/api/asset-mapping"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("acatId is required");
  });

  it("returns 404 for unknown acatId", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(makeGetRequest("http://localhost/api/asset-mapping?acatId=REC-999"));
    expect(res.status).toBe(404);
  });

  it("returns asset mapping for a valid acatId", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    const res = await GET(makeGetRequest("http://localhost/api/asset-mapping?acatId=REC-001"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.acatId).toBe("REC-001");
    expect(data.mappingSource).toBe("GCP Project API");
    expect(data.assets.length).toBe(2);
    expect(data).toHaveProperty("lastSynced");
  });
});

describe("POST /api/asset-mapping", () => {
  it("links a numberless registration and saves masked provenance atomically with positions", async () => {
    const id = "aab63872-c77f-4791-8000-dd876b012345";
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({ ...mockAcat, statementAccountNumber: null } as never);
    mockRequest.mockResolvedValue({ status: 200, data: { id, account_number: null, investor_number: "INV123456", account_holder: "Synthetic Owner", account_registration: "Roth IRA", statement_date: "2026-08-31", is_historical: false, positions: pipelinePositions } });
    const res = await POST(makePostRequest({ acatId: mockAcat.id, sourceAccountId: id }));
    expect(res.status).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith({ url: `https://statement-pipeline-test.run.app/api/v1/positions?account_id=${id}` });
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mappingAccountId: id, mappingAccountSummary: expect.objectContaining({ holder: "Synthetic Owner", registration: "Roth IRA", investorNumberLast4: "3456" }), reconCompletedAt: null }) }));
    const data = vi.mocked(prisma.acatRecord.update).mock.calls[0][0].data;
    expect(JSON.stringify(data)).not.toContain("INV123456");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "A2" }, data: expect.objectContaining({ expectedQty: 0, amount: 0 }) });
    for (const [args] of vi.mocked(prisma.asset.update).mock.calls) {
      expect(args.data).not.toHaveProperty("actualQty");
      expect(args.data).not.toHaveProperty("notes");
      expect(args.data).not.toHaveProperty("includeInTransfer");
    }
  });

  it("refreshes a saved source link and accepts its newer resolved ID", async () => {
    const oldId = "aab63872-c77f-4791-8000-dd876b012345";
    const newId = "aab63872-c77f-4791-8000-dd876b067890";
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({ ...mockAcat, mappingAccountId: oldId } as never);
    mockRequest.mockResolvedValue({ status: 200, data: { id: newId, account_number: mockAcat.statementAccountNumber, is_historical: true, positions: pipelinePositions } });
    expect((await POST(makePostRequest({ acatId: mockAcat.id }))).status).toBe(200);
    expect(mockRequest).toHaveBeenCalledWith({ url: `https://statement-pipeline-test.run.app/api/v1/positions?account_id=${oldId}` });
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mappingAccountId: newId, mappingAccountSummary: expect.objectContaining({ isHistorical: true }) }) }));
  });

  it.each([[404, "SOURCE_ACCOUNT_NOT_FOUND"], [409, "SOURCE_ACCOUNT_SELECTION_REQUIRED"]])("returns actionable source error %i without changing saved holdings", async (status, code) => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(mockAcat as never);
    mockRequest.mockRejectedValue({ response: { status } });
    const res = await POST(makePostRequest({ acatId: mockAcat.id }));
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid source ID before contacting either database or mapping service", async () => {
    expect((await POST(makePostRequest({ acatId: mockAcat.id, sourceAccountId: "not-a-uuid" }))).status).toBe(400);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("preserves saved holdings when the source returns a different account or an unidentified holding", async () => {
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(mockAcat as never);
    mockRequest.mockResolvedValue({ status: 200, data: { account_number: "DIFFERENT", positions: pipelinePositions } });
    expect((await POST(makePostRequest({ acatId: mockAcat.id }))).status).toBe(500);
    mockRequest.mockResolvedValue({ status: 200, data: { account_number: mockAcat.statementAccountNumber, positions: [{ symbol: null, quantity: 12, market_value: 500 }] } });
    expect((await POST(makePostRequest({ acatId: mockAcat.id }))).status).toBe(422);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists effective decisions and statement context on new and existing positions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(mappingContext.mappingSyncedAt));
    try {
      (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockAcat,
        mappingSyncedAt: mappingContext.mappingSyncedAt,
        assets: mockAcat.assets.map((asset) => ({ ...asset, includeInTransfer: true })),
      });
      mockRequest.mockResolvedValue({
        status: 200,
        data: {
          account_number: "PIN-10000098",
          statement_date: "June 1-30, 2026",
          statement_age_days: "77",
          is_stale: true,
          positions: pipelinePositions.map((position) => ({
            ...position,
            transfer_eligible: "ACAT",
            transfer_notes: "Engine decision",
            effective_status: "LIQUIDATE",
            effective_notes: mappingContext.mappingTransferNotes,
            transferring: "NO",
          })),
        },
      });
      const response = await POST(makePostRequest({ acatId: "REC-001" }));
      expect(response.status).toBe(200);
      const update = (prisma.asset.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(update.data).toMatchObject(mappingContext);
      // Source decisions must not overwrite recon work or paperwork choices.
      for (const field of ["includeInTransfer", "notes", "issue", "mapStatus", "actualQty"]) {
        expect(update.data).not.toHaveProperty(field);
      }
      expect(prisma.asset.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ ...mappingContext, symbol: "MSFT", includeInTransfer: null })],
      });
      expect(prisma.acatRecord.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ mappingSyncedAt: mappingContext.mappingSyncedAt }),
      }));
      expect((await response.json()).lastSynced).toBe(mappingContext.mappingSyncedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["YES", "NO", null, "unknown"])("handles the source transferring selection %s without conflating unset with No", async (transferring) => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    mockRequest.mockResolvedValue({ status: 200, data: {
      account_number: "PIN-10000098",
      statement_age_days: 0,
      is_stale: false,
      positions: [{ ...pipelinePositions[0], transferring, effective_notes: "", transfer_notes: "Superseded note" }],
    } });
    expect((await POST(makePostRequest({ acatId: "REC-001" }))).status).toBe(200);
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mappingTransferring: transferring === "YES" ? true : transferring === "NO" ? false : null,
        mappingTransferNotes: "",
        mappingStatementAgeDays: 0,
        mappingStatementIsStale: false,
      }),
    }));
  });

  it("clears previously imported context when the source clears it", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockAcat, assets: [{ ...mockAcat.assets[0], ...mappingContext }],
    });
    mockRequest.mockResolvedValue({ status: 200, data: {
      account_number: "PIN-10000098", positions: [pipelinePositions[0]],
      statement_age_days: "invalid",
    } });
    expect((await POST(makePostRequest({ acatId: "REC-001" }))).status).toBe(200);
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mappingTransferStatus: null, mappingTransferNotes: null, mappingTransferring: null,
        mappingStatementDate: null, mappingStatementAgeDays: null, mappingStatementIsStale: null,
      }),
    }));
  });

  it("falls back to engine values when effective fields are absent", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    mockRequest.mockResolvedValue({ status: 200, data: {
      account_number: "PIN-10000098", positions: [{ ...pipelinePositions[0], transfer_eligible: "REVIEW", transfer_notes: "Needs review" }],
    } });
    await POST(makePostRequest({ acatId: "REC-001" }));
    expect(prisma.asset.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mappingTransferStatus: "REVIEW", mappingTransferNotes: "Needs review" }),
    }));
  });

  it("preserves GCP context and its sync time during a spreadsheet import", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockAcat, mappingSyncedAt: mappingContext.mappingSyncedAt,
      assets: [{ ...mockAcat.assets[0], ...mappingContext }],
    });
    const response = await POST(makePostRequest({
      acatId: "REC-001", source: "spreadsheet", sourceAccountNumber: "PIN-10000098",
      positions: [{ symbol: "AAPL", description: "Apple", qty: 100, includeInTransfer: true }],
    }));
    expect(response.status).toBe(200);
    const update = (prisma.asset.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    for (const key of Object.keys(mappingContext)) expect(update).not.toHaveProperty(key);
    expect(update.includeInTransfer).toBe(true);
    expect((prisma.acatRecord.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data).not.toHaveProperty("mappingSyncedAt");
    expect((await response.json()).lastSynced).toBe(mappingContext.mappingSyncedAt);
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it("returns 503 when GCP_ASSET_MAPPING_URL is not set", async () => {
    vi.stubEnv("GCP_ASSET_MAPPING_URL", "");
    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(503);
  });

  it("returns 400 when acatId is missing", async () => {
    const res = await POST(makePostRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("acatId is required");
  });

  it("returns 404 for unknown acatId", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(makePostRequest({ acatId: "REC-999" }));
    expect(res.status).toBe(404);
  });

  it("calls getAuthenticatedClient with the pipeline URL as audience", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockAcat)
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: [] },
    });

    await POST(makePostRequest({ acatId: "REC-001" }));

    expect(getAuthenticatedClient).toHaveBeenCalledWith("https://statement-pipeline-test.run.app");
  });

  it("calls /api/v1/positions with the statement account number", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockAcat)
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: [] },
    });

    await POST(makePostRequest({ acatId: "REC-001" }));

    expect(mockRequest).toHaveBeenCalledWith({
      url: "https://statement-pipeline-test.run.app/api/v1/positions?account_number=PIN-10000098",
    });
  });

  it("returns 422 when statement account number is missing", async () => {
    const acatNoStatement = { ...mockAcat, statementAccountNumber: null };
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(acatNoStatement);

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toContain("statement account number");
  });

  it("imports spreadsheet positions without calling the GCP service", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...mockAcat, assets: [] })
      .mockResolvedValueOnce({
        ...mockAcat,
        mappingSource: "Spreadsheet Upload",
        assets: [{ id: "A3", symbol: "AAPL", includeInTransfer: true }],
      });
    (prisma.asset.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    const res = await POST(
      makePostRequest({
        acatId: "REC-001",
        source: "spreadsheet",
        sourceAccountNumber: "••••••0098",
        filename: "synthetic-mapping.csv",
        positions: [
          {
            symbol: "AAPL",
            description: "Apple Inc.",
            cusip: "037833100",
            qty: 10,
            amount: 1900,
            assetClass: "Equity",
            includeInTransfer: true,
          },
        ],
      })
    );

    expect(res.status).toBe(200);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(prisma.asset.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          acatRecordId: "REC-001",
          symbol: "AAPL",
          includeInTransfer: true,
        }),
      ],
    });
    expect(prisma.acatRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mappingSource: "Spreadsheet Upload",
          documents: { create: expect.objectContaining({
            kind: "MAPPING_CSV", filename: "synthetic-mapping.csv",
            positionCount: 1, includedCount: 1, excludedCount: 0, undecidedCount: 0,
            inputCsv: expect.stringContaining('"Include in Partial Transfer"'),
            content: expect.any(Buffer),
          }) },
        }),
      })
    );
  });

  it("upserts positions from the pipeline response", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockAcat)
      .mockResolvedValueOnce({
        ...mockAcat,
        mappingSource: "GCP Project API",
        assets: [...mockAcat.assets, { id: "A3", symbol: "MSFT", description: "Microsoft Corp.", cusip: "594918104", expectedQty: 300, actualQty: 0, mapStatus: "Pending" }],
      });
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.asset.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: pipelinePositions },
    });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(200);

    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "A1" },
        data: expect.objectContaining({ expectedQty: 1050 }),
      })
    );

    expect(prisma.asset.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ symbol: "MSFT", cusip: "", expectedQty: 300 }),
        ]),
      })
    );
  });

  it("coerces string-typed quantity and market_value from pipeline to numbers", async () => {
    const stringPositions = [
      { symbol: "QQQ", description: "INVESCO QQQ TR UNIT SER 1", quantity: "16.0000", asset_type: "ETF", market_value: "9716.64" },
      { symbol: "AAPL", description: "Apple Inc.", quantity: "1050", asset_type: "Equity", market_value: "150000" },
    ];
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockAcat)
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.asset.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: stringPositions },
    });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(200);

    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "A1" },
        data: expect.objectContaining({ expectedQty: 1050 }),
      })
    );

    expect(prisma.asset.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            symbol: "QQQ",
            expectedQty: 16,
            amount: 9716.64,
          }),
        ]),
      })
    );
  });

  it("detects CUSIP in pipeline symbol field and stores it in cusip", async () => {
    const cusipPositions = [
      { symbol: "037833100", description: "Apple Inc.", quantity: 1050, asset_type: "Equity", market_value: 150000 },
    ];
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...mockAcat, assets: [] })
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    (prisma.asset.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: cusipPositions },
    });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(200);

    expect(prisma.asset.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            symbol: "037833100",
            cusip: "037833100",
            expectedQty: 1050,
          }),
        ]),
      })
    );
  });

  it("persists detected cusip on existing asset during upsert", async () => {
    const existingAssets = [
      { id: "A1", symbol: "037833100", description: "Apple Inc.", cusip: null, expectedQty: 1000, actualQty: 0, mapStatus: "Pending" },
    ];
    const cusipPositions = [
      { symbol: "037833100", description: "Apple Inc.", quantity: 1050, asset_type: "Equity", market_value: 150000 },
    ];
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...mockAcat, assets: existingAssets })
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: cusipPositions },
    });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(200);

    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "A1" },
        data: expect.objectContaining({
          cusip: "037833100",
          expectedQty: 1050,
        }),
      })
    );
  });

  it("skips pipeline positions with null symbol and no CUSIP instead of failing the sync", async () => {
    // Reproduces the CPL-000492 bug where pipeline returned a position with
    // symbol: null and the mapper crashed trying to call .trim() on null.
    const positionsWithNullSymbol = [
      { symbol: null, description: "Unmapped position", quantity: 0, asset_type: null, market_value: null },
      { symbol: "AAPL", description: "Apple Inc.", quantity: 1050, asset_type: "Equity", market_value: 150000 },
    ];
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockAcat)
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    (prisma.asset.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.asset.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: positionsWithNullSymbol },
    });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(200);

    // The zero-value null-symbol row is dropped; AAPL updates and obsolete TSLA expectations retire.
    expect(prisma.asset.createMany).not.toHaveBeenCalled();
    expect(prisma.asset.update).toHaveBeenCalledTimes(2);
    expect(prisma.asset.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "A1" },
        data: expect.objectContaining({ expectedQty: 1050 }),
      })
    );
  });

  it("handles pipeline positions with null description without crashing", async () => {
    const positionsWithNullDescription = [
      { symbol: "MSFT", description: null, quantity: 300, asset_type: null, market_value: null },
    ];
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...mockAcat, assets: [] })
      .mockResolvedValueOnce({ ...mockAcat, mappingSource: "GCP Project API" });
    (prisma.asset.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "PIN-10000098", positions: positionsWithNullDescription },
    });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(200);

    expect(prisma.asset.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            symbol: "MSFT",
            description: "",
            expectedQty: 300,
          }),
        ]),
      })
    );
  });

  it("returns error when the pipeline returns a non-200 status", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    mockRequest.mockResolvedValue({ status: 502, data: {} });

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toContain("Failed to fetch positions from statement-pipeline");
  });

  it("returns 500 when OIDC authentication fails", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    (getAuthenticatedClient as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Could not fetch ID token")
    );

    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Failed to sync");
  });

  it("normalizes account number without hyphen before calling pipeline", async () => {
    const acatNoHyphen = { ...mockAcat, statementAccountNumber: "CPL000915" };
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(acatNoHyphen)
      .mockResolvedValueOnce({ ...acatNoHyphen, mappingSource: "GCP Project API" });
    mockRequest.mockResolvedValue({
      status: 200,
      data: { account_number: "CPL-000915", positions: [] },
    });

    await POST(makePostRequest({ acatId: "REC-001" }));

    expect(mockRequest).toHaveBeenCalledWith({
      url: "https://statement-pipeline-test.run.app/api/v1/positions?account_number=CPL-000915",
    });
  });
});

describe("normalizePipelineAccountNumber", () => {
  it("returns already-hyphenated numbers unchanged", () => {
    expect(normalizePipelineAccountNumber("PIN-10000098")).toBe("PIN-10000098");
    expect(normalizePipelineAccountNumber("CPL-000915")).toBe("CPL-000915");
  });

  it("inserts hyphen for alpha prefix followed by digits", () => {
    expect(normalizePipelineAccountNumber("CPL000915")).toBe("CPL-000915");
    expect(normalizePipelineAccountNumber("BAY100142")).toBe("BAY-100142");
    expect(normalizePipelineAccountNumber("LKS901550")).toBe("LKS-901550");
    expect(normalizePipelineAccountNumber("PIN10000098")).toBe("PIN-10000098");
  });

  it("leaves pure-digit account numbers unchanged", () => {
    expect(normalizePipelineAccountNumber("263352917")).toBe("263352917");
    expect(normalizePipelineAccountNumber("42603192")).toBe("42603192");
  });

  it("leaves complex alphanumeric formats unchanged", () => {
    expect(normalizePipelineAccountNumber("CRWD001DMZY000001")).toBe("CRWD001DMZY000001");
    expect(normalizePipelineAccountNumber("949307D1058D2")).toBe("949307D1058D2");
  });

  it("trims whitespace", () => {
    expect(normalizePipelineAccountNumber("  CPL000915  ")).toBe("CPL-000915");
  });
});

describe("isCusipFormat", () => {
  it("recognizes standard numeric CUSIPs", () => {
    expect(isCusipFormat("037833100")).toBe(true);
    expect(isCusipFormat("88160R101")).toBe(true);
    expect(isCusipFormat("594918104")).toBe(true);
    expect(isCusipFormat("02079K305")).toBe(true);
  });

  it("rejects typical ticker symbols", () => {
    expect(isCusipFormat("AAPL")).toBe(false);
    expect(isCusipFormat("TSLA")).toBe(false);
    expect(isCusipFormat("GOOGL")).toBe(false);
    expect(isCusipFormat("QQQ")).toBe(false);
    expect(isCusipFormat("BRK.B")).toBe(false);
  });

  it("handles case-insensitive input", () => {
    expect(isCusipFormat("02079k305")).toBe(true);
  });

  it("trims whitespace before checking", () => {
    expect(isCusipFormat("  037833100  ")).toBe(true);
  });

  it("rejects strings that are not exactly 9 alphanumeric characters", () => {
    expect(isCusipFormat("03783310")).toBe(false);
    expect(isCusipFormat("0378331001")).toBe(false);
    expect(isCusipFormat("")).toBe(false);
  });

  it("returns false for null or undefined without throwing", () => {
    expect(isCusipFormat(null)).toBe(false);
    expect(isCusipFormat(undefined)).toBe(false);
  });
});

describe("POST /api/asset-mapping sync in the public demo", () => {
  beforeEach(() => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAcat);
    mockRequest.mockResolvedValue({ status: 200, data: { account_number: "PIN-10000098", positions: pipelinePositions } });
  });

  it("takes the transfer's row lock before the positions cap, then refuses at the cap", async () => {
    const order: string[] = [];
    vi.mocked(prisma.$queryRaw).mockImplementation((async () => (order.push("row lock"), [])) as never);
    vi.mocked(prisma.$executeRaw).mockImplementation((async () => (order.push("cap lock"), 1)) as never);
    vi.mocked(prisma.asset.count).mockImplementation(((args?: { where?: unknown }) =>
      Promise.resolve(args?.where ? 2 : 2500)) as never);
    const res = await POST(makePostRequest({ acatId: "REC-001" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^The demo holds up to 2500 positions/);
    expect(order).toEqual(["row lock", "cap lock"]);
    expect(prisma.asset.createMany).not.toHaveBeenCalled();
  });
});
