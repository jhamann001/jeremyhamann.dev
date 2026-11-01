import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET, POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const mockCustodians = [
  { id: "CUST-001", name: "Fidelity", acatFeeAmount: 0, requiresManualReview: false, avgProcessingDays: 5, contactEmail: "acat-support@fidelity.example" },
  { id: "CUST-002", name: "Charles Schwab", acatFeeAmount: 50, requiresManualReview: false, avgProcessingDays: 6, contactEmail: "transfers@schwab.example" },
];

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  // ticket: the GET list handler now calls acatRecord.groupBy unconditionally
  // (to compute hasInboundRecords). Default it to [] so tests that only mock
  // findMany don't hit `undefined.map` → 500.
  (prisma.acatRecord.groupBy as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("GET /api/custodians", () => {
  it("returns all custodians when no id provided", async () => {
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodians);
    const res = await GET(makeRequest("http://localhost/api/custodians"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    expect(data[0]).not.toHaveProperty("requiresManualReview");
    // ticket (L1): the inbound aggregate is skipped unless ?withInbound=1.
    expect(prisma.acatRecord.groupBy).not.toHaveBeenCalled();
  });

  it("annotates each custodian with hasInboundRecords (true only for inbound 'In' contras)", async () => {
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "in-1", name: "Inbound Contra" },
      { id: "out-1", name: "Outbound-only Contra" },
    ]);
    (prisma.acatRecord.groupBy as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { custodianId: "in-1", _count: { _all: 3 } },
    ]);
    const res = await GET(makeRequest("http://localhost/api/custodians?withInbound=1"));
    const data = await res.json();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(data.map((c: { id: string; hasInboundRecords: boolean }) => [c.id, c.hasInboundRecords]));
    expect(byId["in-1"]).toBe(true);
    expect(byId["out-1"]).toBe(false);
    // The groupBy must filter on inbound direction only.
    expect(prisma.acatRecord.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: { equals: "In", mode: "insensitive" },
        }),
      })
    );
  });

  it("annotates custodians with observed completion averages and sample sizes", async () => {
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "cust-1", name: "Measured Contra" },
      { id: "cust-2", name: "No Timing Data" },
    ]);
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        custodianId: "cust-1",
        originalClientRequestDate: "2026-01-01",
        acatDate: "2026-01-02",
        apexCompletionDate: "2026-01-11",
        type: "Full",
      },
      {
        custodianId: "cust-1",
        originalClientRequestDate: "2026-01-01",
        acatDate: "2026-01-02",
        apexCompletionDate: "2026-01-21",
        type: "Full",
      },
      {
        custodianId: "cust-1",
        originalClientRequestDate: "2026-01-01",
        acatDate: "2026-01-02",
        apexCompletionDate: "2026-01-03",
        type: "Residual Credit",
      },
    ]);

    const res = await GET(makeRequest("http://localhost/api/custodians?withInbound=1"));
    const data = await res.json();

    expect(data[0]).toEqual(
      expect.objectContaining({
        observedAvgProcessingBusinessDays: 10,
        observedCompletedTransfers: 2,
      })
    );
    expect(data[1]).toEqual(
      expect.objectContaining({
        observedAvgProcessingBusinessDays: null,
        observedCompletedTransfers: 0,
      })
    );
    expect(prisma.acatRecord.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        direction: { equals: "In", mode: "insensitive" },
        custodianId: { not: null },
        apexCompletionDate: { not: null },
      },
      select: {
        custodianId: true,
        originalClientRequestDate: true,
        acatDate: true,
        apexCompletionDate: true,
        type: true,
      },
    });
  });

  it("returns a specific custodian by id", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodians[0]);
    const res = await GET(makeRequest("http://localhost/api/custodians?id=CUST-001"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.name).toBe("Fidelity");
    expect(data).not.toHaveProperty("requiresManualReview");
  });

  it("returns 404 for unknown custodian", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(makeRequest("http://localhost/api/custodians?id=CUST-999"));
    expect(res.status).toBe(404);
  });

  it("returns 500 on database error", async () => {
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const res = await GET(makeRequest("http://localhost/api/custodians"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/custodians", () => {
  it("creates a new custodian for admins", async () => {
    const created = {
      id: "CUST-999",
      name: "Raymond James",
      acatFeeAmount: 0,
      requiresManualReview: false,
      avgProcessingDays: 7,
      contactEmail: null,
    };
    (prisma.custodian.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "Raymond James" }),
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("Raymond James");
    expect(data).not.toHaveProperty("requiresManualReview");
    expect(prisma.custodian.upsert).toHaveBeenCalledWith({
      where: { name: "Raymond James" },
      update: { reviewStatus: "VERIFIED" },
      create: { name: "Raymond James", reviewStatus: "VERIFIED" },
    });
  });

  it("trims the submitted name before upserting", async () => {
    (prisma.custodian.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-999",
      name: "Raymond James",
    });
    await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "  Raymond James  " }),
      })
    );
    expect(prisma.custodian.upsert).toHaveBeenCalledWith({
      where: { name: "Raymond James" },
      update: { reviewStatus: "VERIFIED" },
      create: { name: "Raymond James", reviewStatus: "VERIFIED" },
    });
  });

  // ticket (Minor B): re-adding an existing NEEDS_SETUP contra by name marks
  // it reviewed (VERIFIED) via the upsert's update branch.
  it("clears NEEDS_SETUP to VERIFIED when an admin re-adds an existing contra", async () => {
    (prisma.custodian.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-050",
      name: "Apex Clearing",
      reviewStatus: "VERIFIED",
    });
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "Apex Clearing" }),
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.reviewStatus).toBe("VERIFIED");
    expect(prisma.custodian.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: "Apex Clearing" },
        update: { reviewStatus: "VERIFIED" },
      })
    );
  });

  it("is idempotent when the custodian already exists", async () => {
    (prisma.custodian.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(mockCustodians[0]);
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "Fidelity" }),
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("CUST-001");
  });

  it("returns 400 when name is empty", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "" }),
      })
    );
    expect(res.status).toBe(400);
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when name is only whitespace", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "   " }),
      })
    );
    expect(res.status).toBe(400);
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "Raymond James" }),
      })
    );
    expect(res.status).toBe(403);
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "Raymond James" }),
      })
    );
    expect(res.status).toBe(401);
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
  });

  it("returns 500 on database error", async () => {
    (prisma.custodian.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));
    const res = await POST(
      makeRequest("http://localhost/api/custodians", {
        method: "POST",
        body: JSON.stringify({ name: "Raymond James" }),
      })
    );
    expect(res.status).toBe(500);
  });
});

describe("POST /api/custodians in the public demo", () => {
  const add = (name: string) =>
    POST(makeRequest("http://localhost/api/custodians", { method: "POST", body: JSON.stringify({ name }) }));
  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a new custodian once the demo holds its cap", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.custodian.count).mockResolvedValue(60);
    const res = await add("Raymond James");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^The demo holds up to 60 custodians/);
    expect(prisma.custodian.upsert).not.toHaveBeenCalled();
  });

  it("still lets an admin re-add an existing name at the cap, which adds no row", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ id: "CUST-1" } as never);
    vi.mocked(prisma.custodian.count).mockResolvedValue(60);
    vi.mocked(prisma.custodian.upsert).mockResolvedValue({ id: "CUST-1", name: "Raymond James" } as never);
    expect((await add("Raymond James")).status).toBe(201);
  });
});
