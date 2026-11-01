import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { callMcpTool } = await import("./tools");
const { prisma } = await import("@/lib/prisma");

const principal = {
  userEmail: "admin@example.com",
  connectionId: "conn-1",
  clientId: "client-1",
  scopes: ["acats:read"],
  role: "ADMIN" as const,
};

describe("MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.mcpToolAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("filters reconciliation asset summaries through non-deleted ACAT records", async () => {
    (prisma.acatRecord.groupBy as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { status: "Submitted", _count: { _all: 2 } },
    ]);
    (prisma.asset.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { mapStatus: "Mapped", _count: { _all: 3 } },
    ]);

    const result = await callMcpTool(
      "get_reconciliation_summary",
      {},
      principal,
      "req-1"
    );

    expect(prisma.asset.groupBy).toHaveBeenCalledWith({
      by: ["mapStatus"],
      where: { acatRecord: { deletedAt: null } },
      _count: { _all: true },
    });
    expect(result).toEqual({
      byStatus: [{ status: "Submitted", count: 2 }],
      byAssetMapStatus: [{ status: "Mapped", count: 3 }],
    });
  });

  it("lists configured and observed custodian timing with unambiguous field names", async () => {
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "cust-schwab",
        name: "Charles Schwab",
        acatFeeAmount: 50,
        avgProcessingDays: 7,
        contactEmail: null,
      },
      {
        id: "cust-apex",
        name: "Apex",
        acatFeeAmount: 0,
        avgProcessingDays: 7,
        contactEmail: null,
      },
    ]);
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        custodianId: "cust-schwab",
        originalClientRequestDate: "2026-01-05",
        acatDate: "2026-01-06",
        apexCompletionDate: "2026-01-09",
        type: "Full",
      },
      {
        custodianId: "cust-schwab",
        originalClientRequestDate: "2026-01-05",
        acatDate: "2026-01-06",
        apexCompletionDate: "2026-01-06",
        type: "Residual Credit",
      },
    ]);

    const result = await callMcpTool(
      "list_custodians",
      {},
      principal,
      "req-custodian-list"
    );

    expect(prisma.acatRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          custodianId: { not: null },
          deletedAt: null,
          direction: { equals: "In", mode: "insensitive" },
          apexCompletionDate: { not: null },
        },
      })
    );
    expect(result).toEqual({
      items: [
        {
          id: "cust-schwab",
          name: "Charles Schwab",
          acatFeeAmount: 50,
          contactEmail: null,
          configuredExpectedProcessingDays: 7,
          observedAvgProcessingBusinessDays: 4,
          observedCompletedTransfers: 1,
        },
        {
          id: "cust-apex",
          name: "Apex",
          acatFeeAmount: 0,
          contactEmail: null,
          configuredExpectedProcessingDays: 7,
          observedAvgProcessingBusinessDays: null,
          observedCompletedTransfers: 0,
        },
      ],
    });
    expect(result).not.toHaveProperty("items.0.avgProcessingDays");
  });

  it("returns a complete custodian profile with nested fees but no client history", async () => {
    const profile = {
      id: "cust-1",
      name: "Victory Funds",
      reviewStatus: "VERIFIED",
      transferType: "MANUAL",
      documentationStatus: "DOCUMENTED",
      dtcNumber: null,
      receivingAccountNumber: "DEMOOMNI01",
      signature: "Wet signature required",
      letterOfAcceptance: "Required",
      medallionRequired: "Not required",
      liquidationMethod: "Liquidate at contra",
      returnMethod: "Mail original paperwork",
      watchouts: "Manual transfer only",
      paperworkOnFile: true,
      transfersToDate: 4,
      requiresManualReview: true,
      avgProcessingDays: 10,
      contactEmail: null,
      fees: [
        {
          id: "fee-1",
          feeType: "Outgoing Full Account Transfer / Termination",
          accountType: "ANY",
          transferType: "FULL",
          direction: "ANY",
          amount: 195,
          amountText: null,
          notes: null,
          documentation: "Victory Capital fee schedule",
        },
      ],
    };
    (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(profile);
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        custodianId: "cust-1",
        originalClientRequestDate: "2026-01-01",
        acatDate: "2026-01-02",
        apexCompletionDate: "2026-04-11",
        type: "Full",
      },
      {
        custodianId: "cust-1",
        originalClientRequestDate: "2026-01-01",
        acatDate: "2026-01-02",
        apexCompletionDate: "2026-05-11",
        type: "Full",
      },
    ]);

    const result = await callMcpTool(
      "get_custodian_profile",
      { name: "victory funds" },
      principal,
      "req-profile"
    );

    expect(prisma.custodian.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: { equals: "victory funds", mode: "insensitive" } },
        select: expect.not.objectContaining({
          recentClients: true,
          requiresManualReview: true,
        }),
      })
    );
    expect(prisma.custodian.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          receivingAccountNumber: true,
        }),
      })
    );
    expect(prisma.acatRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          custodianId: "cust-1",
          direction: { equals: "In", mode: "insensitive" },
        }),
      })
    );
    const {
      avgProcessingDays: configuredDays,
      requiresManualReview: retiredManualReview,
      ...profileWithoutTiming
    } = profile;
    expect(retiredManualReview).toBe(true);
    expect(result).toEqual({
      ...profileWithoutTiming,
      configuredExpectedProcessingDays: configuredDays,
      observedAvgProcessingBusinessDays: 79,
      observedCompletedTransfers: 2,
    });
    expect(result).not.toHaveProperty("requiresManualReview");
  });

  it("looks up a custodian profile by id", async () => {
    (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "cust-1",
      name: "Charles Schwab",
      fees: [],
    });

    await callMcpTool(
      "get_custodian_profile",
      { id: "cust-1" },
      principal,
      "req-profile-id"
    );

    expect(prisma.custodian.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cust-1" } })
    );
  });

  it("rejects a custodian profile lookup without an id or name", async () => {
    await expect(
      callMcpTool("get_custodian_profile", {}, principal, "req-profile-empty")
    ).rejects.toThrow("Custodian id or name is required");
    expect(prisma.custodian.findFirst).not.toHaveBeenCalled();
  });

  it("reports when a custodian profile is not found", async () => {
    (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      callMcpTool(
        "get_custodian_profile",
        { name: "Missing Custodian" },
        principal,
        "req-profile-missing"
      )
    ).rejects.toThrow("Custodian not found");
  });
});
