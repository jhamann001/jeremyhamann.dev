import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const SELECTED_CLIENT = "user-11111111-1111-1111-1111-111111111111";

vi.mock("@/lib/client-directory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-directory")>();
  return {
    ...actual,
    lockDirectory: vi.fn().mockResolvedValue(undefined),
    resolveClientIdentities: vi.fn().mockResolvedValue({
      canonicalName: "Sarah",
      cedarRidgeUserIds: ["user-11111111-1111-1111-1111-111111111111"],
      snapshotId: "snap",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest",
    }),
    replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 1 }),
  };
});

const { GET, POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

const mockRecord = {
  id: "REC-001",
  clientName: "Sarah Jenkins",
  controlNumber: "CTL-10421",
  apexAccountId: "APX-1049201",
  status: "PendingReview",
  crmDealId: "OPP-9812",
  transferringContra: "Charles Schwab",
  custodianId: null,
  custodianName: "Charles Schwab",
  wealthAdvisor: "Jeremy H.",
  direction: "In",
  acatDate: "2026-04-10",
  lastUpdated: "2026-04-12T14:32:00Z",
  deletedAt: null,
  assets: [],
  clientLinks: [],
};

function stubCreated(record: unknown) {
  (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mockResolvedValue(record);
  (prisma.acatRecord.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(record);
}

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

describe("GET /api/acats", () => {
  it("returns all ACAT records", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([mockRecord]);
    const res = await GET(makeRequest("http://localhost/api/acats"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].clientName).toBe("Sarah Jenkins");
  });

  it("passes status filter to Prisma", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await GET(makeRequest("http://localhost/api/acats?status=Completed"));
    const call = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe("Completed");
  });

  it("passes search query to Prisma OR filter", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await GET(makeRequest("http://localhost/api/acats?q=sarah"));
    const call = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.OR).toBeDefined();
    expect(call.where.OR.length).toBeGreaterThan(0);
    expect(call.where.OR).toContainEqual({
      tradeRequestId: { contains: "sarah", mode: "insensitive" },
    });
    expect(call.where.OR.some((entry: Record<string, unknown>) => "tradeRequestUrl" in entry)).toBe(false);
  });

  it("returns 500 on database error", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const res = await GET(makeRequest("http://localhost/api/acats"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to fetch ACAT records");
  });

  it("defaults to filtering out deleted records", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await GET(makeRequest("http://localhost/api/acats"));
    const call = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.deletedAt).toBeNull();
  });

  it("returns 403 when non-admin requests includeDeleted=true", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await GET(
      makeRequest("http://localhost/api/acats?includeDeleted=true")
    );
    expect(res.status).toBe(403);
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 403 when unauthenticated caller requests includeDeleted=true", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(
      makeRequest("http://localhost/api/acats?includeDeleted=true")
    );
    expect(res.status).toBe(403);
  });

  it("omits deletedAt filter when admin calls with includeDeleted=true", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await GET(
      makeRequest("http://localhost/api/acats?includeDeleted=true")
    );
    const call = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.deletedAt).toBeUndefined();
  });
});

describe("POST /api/acats", () => {
  it("browser create without a selected client returns IDENTITY_REQUIRED", async () => {
    markCase("acat-create", "browser create without a selected client returns IDENTITY_REQUIRED");
    const res = await POST(makeRequest("http://localhost/api/acats", {
      method: "POST",
      body: JSON.stringify({ clientName: "Ada", apexAccountId: "APEX1" }),
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "IDENTITY_REQUIRED" });
    expect(prisma.acatRecord.create).not.toHaveBeenCalled();
  });

  it("creates a new ACAT record with valid data", async () => {
    const created = { ...mockRecord, id: "new-id", clientName: "Test Client" };
    stubCreated(created);

    const res = await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Test Client",
          apexAccountId: "APX-0000001",
          tradeRequestId: "TRQ-456",
          tradeRequestUrl: "https://trades.example.com/requests/TRQ-456",
          transferWorkflow: "ACAT",
        }),
      })
    );
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.clientName).toBe("Test Client");
    const call = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.tradeRequestId).toBe("TRQ-456");
    expect(call.data.tradeRequestUrl).toBe("https://trades.example.com/requests/TRQ-456");
    expect(call.data.transferWorkflow).toBe("ACAT");
  });

  it.each([
    ["In", "Full", undefined, "No"],
    ["Out", "Full", undefined, "No"],
    ["In", "Partial", "", "No"],
    ["Out", "Partial", " ", "No"],
    ["Out", "Full", "Yes", "Yes"],
    ["In", "Full", "No", "No"],
  ])("creates %s %s DRS with fee answer %s as %s", async (direction, type, feeCharged, expected) => {
    stubCreated(mockRecord);
    const res = await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "DRS Client",
          apexAccountId: "APX-DRS",
          transferWorkflow: "DRS",
          direction,
          type,
          feeCharged,
        }),
      })
    );
    expect(res.status).toBe(201);
    const data = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toMatchObject({ transferWorkflow: "DRS", feeCharged: expected });
  });

  it.each([undefined, "", "Full", "Partial", "Residual Credit"])("normalizes residual workflow with input type %s before applying defaults", async (type) => {
    vi.mocked(prisma.acatRecord.create).mockImplementation(
      ({ data }) => {
        const row = { ...mockRecord, ...data };
        vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue(row as never);
        return Promise.resolve(row) as never;
      }
    );
    const res = await POST(makeRequest("http://localhost/api/acats", {
      method: "POST",
      body: JSON.stringify({ cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Residual Client", apexAccountId: "APX-RESIDUAL", direction: "Out", transferWorkflow: "RESIDUAL", type }),
    }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ transferWorkflow: "RESIDUAL", type: "Residual Credit" });
    const data = vi.mocked(prisma.acatRecord.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ type: "Residual Credit", transferWorkflow: "RESIDUAL", residualMonitoringRequired: false });
    expect(data.feeCharged).toBeUndefined();
    expect(data.residualFollowUpDate).toBeUndefined();
  });

  it("keeps the existing type-to-workflow residual default", async () => {
    stubCreated(mockRecord);
    const res = await POST(makeRequest("http://localhost/api/acats", {
      method: "POST",
      body: JSON.stringify({ cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Residual Client", apexAccountId: "APX-RESIDUAL", type: "Residual Credit" }),
    }));
    expect(res.status).toBe(201);
    expect(vi.mocked(prisma.acatRecord.create).mock.calls[0][0].data).toMatchObject({ type: "Residual Credit", transferWorkflow: "RESIDUAL" });
  });

  it("stores outgoing statement amounts as negative cents", async () => {
    stubCreated(mockRecord);
    await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Outgoing Client",
          apexAccountId: "APX-OUT",
          direction: "Out",
          statementAmount: 125050,
        }),
      })
    );
    const call = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.statementAmount).toBe(-125050);
  });

  it("defaults full ACAT Outs into fee checking and one-week residual monitoring", async () => {
    stubCreated(mockRecord);
    await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Outgoing Client",
          apexAccountId: "APX-OUT",
          direction: "Out",
          type: "Full",
        }),
      })
    );

    const data = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.feeCharged).toBe("Yes");
    expect(data.residualMonitoringRequired).toBe(true);
    expect(data.residualFollowUpDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 400 when clientName is missing", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({ apexAccountId: "APX-0000001" }),
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("clientName");
  });

  it("returns 400 when apexAccountId is missing", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({ clientName: "Test" }),
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("apexAccountId");
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("resolves custodianId from transferringContra and ignores legacy fields", async () => {
    stubCreated(mockRecord);
    (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-001",
      name: "Charles Schwab",
    });

    await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Test Client",
          apexAccountId: "APX-0000001",
          transferringContra: "Charles Schwab",
          // These legacy fields are intentionally ignored now:
          custodianId: "CUST-OLD",
          custodianName: "Stale Name",
        }),
      })
    );

    const call = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prisma.custodian.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: "Charles Schwab", mode: "insensitive" } },
      select: { id: true, name: true },
    });
    expect(call.data.transferringContra).toBe("Charles Schwab");
    expect(call.data.custodianId).toBe("CUST-001");
    expect(call.data.custodianName).toBe("Charles Schwab");
  });

  it("creates a custodian when transferringContra is new", async () => {
    stubCreated(mockRecord);
    (prisma.custodian.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.custodian.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-NEW",
      name: "New Contra",
    });

    await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Test Client",
          apexAccountId: "APX-0000001",
          transferringContra: " New Contra ",
        }),
      })
    );

    expect(prisma.custodian.create).toHaveBeenCalledWith({
      data: { name: "New Contra", reviewStatus: "NEEDS_SETUP" },
      select: { id: true, name: true },
    });
    const call = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.custodianId).toBe("CUST-NEW");
    expect(call.data.custodianName).toBe("New Contra");
  });

  it("writes an empty custodianName when transferringContra is omitted", async () => {
    stubCreated(mockRecord);

    await POST(
      makeRequest("http://localhost/api/acats", {
        method: "POST",
        body: JSON.stringify({
          cedarRidgeUserId: SELECTED_CLIENT,
          clientName: "Test Client",
          apexAccountId: "APX-0000001",
        }),
      })
    );

    const call = (prisma.acatRecord.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prisma.custodian.findFirst).not.toHaveBeenCalled();
    expect(call.data.custodianId).toBeNull();
    expect(call.data.custodianName).toBe("");
  });
});

describe("POST /api/acats in the public demo", () => {
  const body = (extra: Record<string, unknown> = {}) => JSON.stringify({
    cedarRidgeUserId: SELECTED_CLIENT, clientName: "Test Client", apexAccountId: "APX-0000001", ...extra,
  });
  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a new transfer once the demo holds its cap, inside the create's transaction", async () => {
    stubCreated(mockRecord);
    vi.mocked(prisma.acatRecord.count).mockResolvedValue(400);
    const res = await POST(makeRequest("http://localhost/api/acats", { method: "POST", body: body() }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^The demo holds up to 400 transfers until its nightly reset/);
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    expect(prisma.acatRecord.create).not.toHaveBeenCalled();
  });

  it("creates under the cap", async () => {
    stubCreated(mockRecord);
    vi.mocked(prisma.acatRecord.count).mockResolvedValue(124);
    const res = await POST(makeRequest("http://localhost/api/acats", { method: "POST", body: body() }));
    expect(res.status).toBe(201);
  });

  it("refuses a typed delivering firm that isn't on the custodian list, and mints no card", async () => {
    stubCreated(mockRecord);
    vi.mocked(prisma.acatRecord.count).mockResolvedValue(124);
    vi.mocked(prisma.custodian.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.custodian.findMany).mockResolvedValue([]);
    const res = await POST(makeRequest("http://localhost/api/acats", { method: "POST", body: body({ transferringContra: "Anything A Visitor Types" }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("In the demo, pick the delivering firm from the list. An admin adds new firms on the Custodians page.");
    expect(prisma.custodian.create).not.toHaveBeenCalled();
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
    expect(prisma.acatRecord.create).not.toHaveBeenCalled();
  });

  it("accepts a firm already on the list", async () => {
    stubCreated(mockRecord);
    vi.mocked(prisma.acatRecord.count).mockResolvedValue(124);
    vi.mocked(prisma.custodian.findFirst).mockResolvedValue({ id: "CUST-1", name: "Charles Schwab" } as never);
    const res = await POST(makeRequest("http://localhost/api/acats", { method: "POST", body: body({ transferringContra: "Charles Schwab" }) }));
    expect(res.status).toBe(201);
    expect(vi.mocked(prisma.acatRecord.create).mock.calls[0][0].data).toMatchObject({ custodianId: "CUST-1" });
  });
});
