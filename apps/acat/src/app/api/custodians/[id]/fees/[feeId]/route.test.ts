import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { PATCH, DELETE } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

function makeRequest(url: string, init?: RequestInit) {
  return new Request(url, init) as Parameters<typeof PATCH>[0];
}

function makeParams(id: string, feeId: string) {
  return { params: Promise.resolve({ id, feeId }) };
}

const mockFee = {
  id: "F1",
  custodianId: "CUST-001",
  feeType: "Full Transfer",
  accountType: "ANY" as const,
  transferType: "FULL" as const,
  amount: 75,
  amountText: null,
  notes: null,
  documentation: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

describe("PATCH /api/custodians/[id]/fees/[feeId]", () => {
  it("updates a fee owned by the matching custodian", async () => {
    (prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockFee);
    (prisma.custodianFee.update as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...mockFee, ...data })
    );

    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "PATCH",
        body: JSON.stringify({ amount: 100, notes: "increased" }),
      }),
      makeParams("CUST-001", "F1")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.amount).toBe(100);
    expect(data.notes).toBe("increased");
  });

  it("returns 404 when the fee belongs to a different custodian (URL tamper)", async () => {
    (prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockFee,
      custodianId: "CUST-OTHER",
    });
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "PATCH",
        body: JSON.stringify({ amount: 999 }),
      }),
      makeParams("CUST-001", "F1")
    );
    expect(res.status).toBe(404);
    expect(prisma.custodianFee.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the fee does not exist", async () => {
    (prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/missing", {
        method: "PATCH",
        body: JSON.stringify({ amount: 1 }),
      }),
      makeParams("CUST-001", "missing")
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "PATCH",
        body: JSON.stringify({ amount: 1 }),
      }),
      makeParams("CUST-001", "F1")
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid fields", async () => {
    (prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockFee);
    const res = await PATCH(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "PATCH",
        body: JSON.stringify({ accountType: "WRONG" }),
      }),
      makeParams("CUST-001", "F1")
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/custodians/[id]/fees/[feeId]", () => {
  it("deletes a fee owned by the matching custodian", async () => {
    (prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockFee);
    (prisma.custodianFee.delete as ReturnType<typeof vi.fn>).mockResolvedValue(mockFee);

    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "DELETE",
      }),
      makeParams("CUST-001", "F1")
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(prisma.custodianFee.delete).toHaveBeenCalled();
  });

  it("returns 404 when the fee belongs to a different custodian", async () => {
    (prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockFee,
      custodianId: "CUST-OTHER",
    });
    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "DELETE",
      }),
      makeParams("CUST-001", "F1")
    );
    expect(res.status).toBe(404);
    expect(prisma.custodianFee.delete).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await DELETE(
      makeRequest("http://localhost/api/custodians/CUST-001/fees/F1", {
        method: "DELETE",
      }),
      makeParams("CUST-001", "F1")
    );
    expect(res.status).toBe(403);
  });
});
