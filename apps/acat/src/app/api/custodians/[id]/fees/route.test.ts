import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof POST>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

describe("POST /api/custodians/[id]/fees", () => {
  it("creates a fee and returns 201", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-001",
      name: "E*TRADE",
    });
    (prisma.custodianFee.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "F1",
      custodianId: "CUST-001",
      feeType: "Full Transfer",
      accountType: "ANY",
      transferType: "FULL",
      amount: 75,
    });

    const res = await POST(
      makeRequest("http://localhost/api/custodians/CUST-001/fees", {
        method: "POST",
        body: JSON.stringify({
          feeType: "Full Transfer",
          accountType: "ANY",
          transferType: "FULL",
          amount: 75,
        }),
      }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.feeType).toBe("Full Transfer");
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await POST(
      makeRequest("http://localhost/api/custodians/CUST-001/fees", {
        method: "POST",
        body: JSON.stringify({ feeType: "X" }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(403);
    expect(prisma.custodianFee.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the custodian does not exist", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(
      makeRequest("http://localhost/api/custodians/missing/fees", {
        method: "POST",
        body: JSON.stringify({ feeType: "X" }),
      }),
      makeParams("missing")
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when feeType is missing", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-001",
      name: "E*TRADE",
    });
    const res = await POST(
      makeRequest("http://localhost/api/custodians/CUST-001/fees", {
        method: "POST",
        body: JSON.stringify({ amount: 75 }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(400);
    expect(prisma.custodianFee.create).not.toHaveBeenCalled();
  });

  it("defaults accountType and transferType to ANY when omitted", async () => {
    (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "CUST-001",
    });
    (prisma.custodianFee.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "F1", ...data })
    );

    const res = await POST(
      makeRequest("http://localhost/api/custodians/CUST-001/fees", {
        method: "POST",
        body: JSON.stringify({ feeType: "Basic", amount: 50 }),
      }),
      makeParams("CUST-001")
    );
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data.accountType).toBe("ANY");
    expect(data.transferType).toBe("ANY");
  });
});

describe("POST /api/custodians/[id]/fees in the public demo", () => {
  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a new fee once the demo holds its cap", async () => {
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ id: "CUST-001", name: "E*TRADE" } as never);
    vi.mocked(prisma.custodianFee.count).mockResolvedValue(150);
    const res = await POST(
      makeRequest("http://localhost/api/custodians/CUST-001/fees", {
        method: "POST",
        body: JSON.stringify({ feeType: "Full Transfer", accountType: "ANY", transferType: "FULL", amount: 75 }),
      }),
      makeParams("CUST-001")
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^The demo holds up to 150 custodian fees/);
    expect(prisma.custodianFee.create).not.toHaveBeenCalled();
  });
});
