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

describe("GET /api/dtcc-suggestion", () => {
  it("returns an agreed historical suggestion", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { transferringContra: "Fidelity", dtccNumber: "0226" },
      { transferringContra: "Fidelity", dtccNumber: "0226" },
    ]);
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const response = await GET(new Request("http://localhost/api/dtcc-suggestion?contra=Fidelity") as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "suggested", dtccNumber: "0226" });
  });

  it("leaves conflicting values for human review", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { transferringContra: "Example", dtccNumber: "0001" },
      { transferringContra: "Example", dtccNumber: "0002" },
    ]);
    (prisma.custodian.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const response = await GET(new Request("http://localhost/api/dtcc-suggestion?contra=Example") as Parameters<typeof GET>[0]);
    expect(await response.json()).toMatchObject({ status: "ambiguous", dtccNumber: null });
  });

  it("requires authentication", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/dtcc-suggestion?contra=Fidelity") as Parameters<typeof GET>[0]);
    expect(response.status).toBe(401);
  });
});
