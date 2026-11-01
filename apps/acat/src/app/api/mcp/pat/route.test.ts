import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
const { prisma } = await import("@/lib/prisma");
const { POST } = await import("./route");

const user = { email: "operator@example.test", active: true, mcpEnabled: true, role: "USER" };
const request = () => new NextRequest("http://localhost/api/mcp/pat", {
  method: "POST", body: JSON.stringify({ name: "Test token", scopes: ["acats:read"] }),
});

describe("PAT issuance current user authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { email: user.email, role: "USER" } });
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...user } as never);
  });

  it("refuses to issue a token in the demo, where the MCP server isn't run", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    try {
      const response = await POST(request());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Claude MCP is off in this demo." });
      expect(prisma.mcpPersonalToken.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["ADMIN", "USER"])("allows currently eligible %s users", async (role) => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...user, role } as never);
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect((await response.json()).token).toMatch(/^mcp_pat_/);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.mcpPersonalToken.create).toHaveBeenCalledOnce();
  });

  it.each([
    { role: "ADVISOR" }, { role: "UNKNOWN" }, { active: false }, { mcpEnabled: false },
  ])("denies issuance despite a cached USER session for state %j", async (change) => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...user, ...change } as never);
    expect((await POST(request())).status).toBe(403);
    expect(prisma.mcpPersonalToken.create).not.toHaveBeenCalled();
  });

  it("rechecks eligibility after waiting for a concurrent privilege update", async () => {
    vi.mocked(prisma.allowedUser.findUnique)
      .mockResolvedValueOnce({ ...user } as never)
      .mockResolvedValue({ ...user, role: "ADVISOR" } as never);
    expect((await POST(request())).status).toBe(403);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.mcpPersonalToken.create).not.toHaveBeenCalled();
  });
});
