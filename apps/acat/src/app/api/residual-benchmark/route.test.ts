import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "ops@example.com" } });
});

describe("GET /api/residual-benchmark", () => {
  it("returns the fallback when no linked history exists", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const response = await GET(new Request("http://localhost/api/residual-benchmark?contra=Fidelity") as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ days: 27, sampleSize: 0, source: "fallback" });
  });

  it("requires authentication", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/residual-benchmark") as Parameters<typeof GET>[0]);
    expect(response.status).toBe(401);
  });
});
