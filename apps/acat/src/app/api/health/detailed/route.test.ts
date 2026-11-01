import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const adminSession = { user: { email: "admin@example.com", role: "ADMIN" } };
const userSession = { user: { email: "user@example.com", role: "USER" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health/detailed", () => {
  it("returns detailed health when caller is admin + DB is up", async () => {
    mockAuth.mockResolvedValue(adminSession);
    (prisma as unknown as Record<string, ReturnType<typeof vi.fn>>).$queryRaw =
      vi.fn().mockResolvedValue([{ "?column?": 1 }]);

    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.db).toBe("ok");
    expect(data.status).toBe("healthy");
    expect(data).toHaveProperty("uptime");
    expect(data).toHaveProperty("version");
  });

  it("returns degraded (503) when admin but DB is down", async () => {
    mockAuth.mockResolvedValue(adminSession);
    (prisma as unknown as Record<string, ReturnType<typeof vi.fn>>).$queryRaw =
      vi.fn().mockRejectedValue(new Error("boom"));

    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.db).toBe("error");
  });

  it("returns 403 for non-admin users", async () => {
    mockAuth.mockResolvedValue(userSession);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns 403 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
  });
});
