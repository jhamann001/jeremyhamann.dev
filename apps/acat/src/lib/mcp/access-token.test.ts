import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { validateMcpBearerToken } = await import("./access-token");
const { prisma } = await import("@/lib/prisma");

describe("validateMcpBearerToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_ENABLED = "0";
  });

  it("rejects existing access tokens when global MCP is disabled", async () => {
    (prisma.mcpSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
    });

    await expect(
      validateMcpBearerToken("Bearer acat_at_existing", ["acats:read"])
    ).rejects.toThrow("MCP is globally disabled");
    expect(prisma.mcpAccessToken.findUnique).not.toHaveBeenCalled();
  });
});

describe("MCP bearer current user authorization", () => {
  const user = { email: "operator@example.test", active: true, mcpEnabled: true, role: "USER" };
  const future = new Date("2099-01-01");
  const personalToken = () => ({ id: "pat-1", userEmail: user.email, revokedAt: null, scopes: ["acats:read"], user: { ...user } });
  const oauthToken = () => ({
    id: "at-1", connectionId: "connection-1", revokedAt: null, expiresAt: future, scopes: ["acats:read"],
    connection: {
      userEmail: user.email, revokedAt: null, expiresAt: future,
      client: { clientId: "client-1", revokedAt: null }, user: { ...user },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_ENABLED = "1";
    vi.mocked(prisma.mcpSettings.findUnique).mockResolvedValue({ enabled: true } as never);
  });

  it.each(["ADMIN", "USER"])("accepts currently eligible %s PAT and OAuth tokens", async (role) => {
    const pat = personalToken();
    pat.user.role = role;
    const oauth = oauthToken();
    oauth.connection.user.role = role;
    vi.mocked(prisma.mcpPersonalToken.findUnique).mockResolvedValue(pat as never);
    vi.mocked(prisma.mcpAccessToken.findUnique).mockResolvedValue(oauth as never);

    await expect(validateMcpBearerToken("Bearer mcp_pat_existing", ["acats:read"])).resolves.toMatchObject({ role });
    await expect(validateMcpBearerToken("Bearer acat_at_existing", ["acats:read"])).resolves.toMatchObject({ role });
  });

  it.each([
    { role: "ADVISOR" },
    { role: "UNKNOWN_FUTURE_ROLE" },
    { active: false },
    { mcpEnabled: false },
  ])("rejects existing PAT and OAuth credentials for current user state %j", async (change) => {
    const pat = personalToken();
    Object.assign(pat.user, change);
    const oauth = oauthToken();
    Object.assign(oauth.connection.user, change);
    vi.mocked(prisma.mcpPersonalToken.findUnique).mockResolvedValue(pat as never);
    vi.mocked(prisma.mcpAccessToken.findUnique).mockResolvedValue(oauth as never);

    await expect(validateMcpBearerToken("Bearer mcp_pat_existing")).rejects.toThrow("Invalid bearer token");
    await expect(validateMcpBearerToken("Bearer acat_at_existing")).rejects.toThrow("Invalid bearer token");
    expect(prisma.mcpPersonalToken.update).not.toHaveBeenCalled();
    expect(prisma.mcpAccessToken.update).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.update).not.toHaveBeenCalled();
  });

  it("does not revive revoked credentials after their owner returns to USER", async () => {
    vi.mocked(prisma.mcpPersonalToken.findUnique).mockResolvedValue({ ...personalToken(), revokedAt: new Date() } as never);
    const oauth = oauthToken();
    vi.mocked(prisma.mcpAccessToken.findUnique).mockResolvedValue({ ...oauth, connection: { ...oauth.connection, revokedAt: new Date() } } as never);
    await expect(validateMcpBearerToken("Bearer mcp_pat_existing")).rejects.toThrow("Invalid bearer token");
    await expect(validateMcpBearerToken("Bearer acat_at_existing")).rejects.toThrow("Invalid bearer token");
  });
});
