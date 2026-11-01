import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const params = { params: Promise.resolve({ id: "REC-001" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "user@example.com" } });
});

describe("GET /api/acats/[id]/history", () => {
  it("returns the newest 100 non-read audit entries", async () => {
    const entries = [{
      id: "AUD-1",
      action: "update",
      field: "clientName",
      oldValue: "Sara",
      newValue: "Sarah",
      performedBy: "user@example.com",
      timestamp: new Date("2026-09-09T14:00:00Z"),
    }];
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "REC-001" });
    (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(entries);

    const response = await GET(new Request("http://localhost/api/acats/REC-001/history") as Parameters<typeof GET>[0], params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ...entries[0], timestamp: "2026-09-09T14:00:00.000Z" }]);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { acatRecordId: "REC-001", action: { not: "read" } },
      orderBy: { timestamp: "desc" },
      take: 100,
    }));
  });

  it("requires authentication", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/acats/REC-001/history") as Parameters<typeof GET>[0], params);
    expect(response.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the live record does not exist", async () => {
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/acats/REC-001/history") as Parameters<typeof GET>[0], params);
    expect(response.status).toBe(404);
  });
});
