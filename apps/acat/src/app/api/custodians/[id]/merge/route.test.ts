import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const mockRateLimit = vi.fn();
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
  rateLimitKey: (email: string) => `user:${email}`,
}));

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const userSession = {
  user: { email: "user@example.com", role: "USER" },
};

const SOURCE = { id: "CUST-DUPE", name: "E*Trade" };
const TARGET = { id: "CUST-CANON", name: "E*Trade" };

function makeRequest(body: unknown, opts?: { raw?: string }) {
  return new Request("http://localhost/api/custodians/CUST-DUPE/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: opts?.raw ?? JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 19 });
  (prisma.custodian.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
    ({ where }: { where: { id: string } }) => {
      if (where.id === SOURCE.id) return Promise.resolve(SOURCE);
      if (where.id === TARGET.id) return Promise.resolve(TARGET);
      return Promise.resolve(null);
    }
  );
});

describe("POST /api/custodians/[id]/merge", () => {
  it("repoints records onto the target, writes audit rows, and deletes the source", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "R1", transferringContra: "E*Trade", custodianName: "E*Trade" },
      { id: "R2", transferringContra: null, custodianName: "E*Trade" },
    ]);
    (prisma.acatRecord.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
    (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
    (prisma.custodian.delete as ReturnType<typeof vi.fn>).mockResolvedValue(SOURCE);

    const res = await POST(
      makeRequest({ targetCustodianId: TARGET.id }),
      makeParams(SOURCE.id)
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.reassigned).toBe(2);
    expect(data.deletedCustodianId).toBe(SOURCE.id);

    expect(prisma.acatRecord.updateMany).toHaveBeenCalledWith({
      where: { custodianId: SOURCE.id },
      data: {
        custodianId: TARGET.id,
        custodianName: TARGET.name,
        transferringContra: TARGET.name,
      },
    });

    const auditCall = (prisma.auditLog.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Audit rows now capture reversibility columns (field/oldValue/newValue).
    expect(auditCall.data).toEqual([
      expect.objectContaining({
        acatRecordId: "R1",
        action: "custodian-merge",
        field: "transferringContra",
        oldValue: "E*Trade",
        newValue: TARGET.name,
      }),
      expect.objectContaining({
        acatRecordId: "R2",
        action: "custodian-merge",
        field: "transferringContra",
        // falls back to custodianName when transferringContra is null
        oldValue: "E*Trade",
        newValue: TARGET.name,
      }),
    ]);

    expect(prisma.custodian.delete).toHaveBeenCalledWith({ where: { id: SOURCE.id } });
    expect(prisma.custodianFeeScheduleDocument.updateMany).toHaveBeenCalledWith({
      where: { custodianId: SOURCE.id }, data: { custodianId: TARGET.id },
    });
    expect(vi.mocked(prisma.custodianFeeScheduleDocument.updateMany).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(prisma.custodian.delete).mock.invocationCallOrder[0]);
  });

  it("returns 429 when the merge rate limit is exceeded", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const res = await POST(
      makeRequest({ targetCustodianId: TARGET.id }),
      makeParams(SOURCE.id)
    );
    expect(res.status).toBe(429);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("returns 400 when merging a custodian into itself", async () => {
    const res = await POST(
      makeRequest({ targetCustodianId: SOURCE.id }),
      makeParams(SOURCE.id)
    );
    expect(res.status).toBe(400);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when the target custodian does not exist", async () => {
    const res = await POST(
      makeRequest({ targetCustodianId: "CUST-GONE" }),
      makeParams(SOURCE.id)
    );
    expect(res.status).toBe(404);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when the source custodian does not exist", async () => {
    const res = await POST(
      makeRequest({ targetCustodianId: TARGET.id }),
      makeParams("CUST-GONE")
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on an invalid body", async () => {
    const res = await POST(makeRequest({}), makeParams(SOURCE.id));
    expect(res.status).toBe(400);
    expect(prisma.custodian.delete).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await POST(
      makeRequest({ targetCustodianId: TARGET.id }),
      makeParams(SOURCE.id)
    );
    expect(res.status).toBe(403);
  });
});
