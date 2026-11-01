import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const {
  parseAuthorizationRequest,
  refreshAccessToken,
  registerOAuthClient,
  assertMcpEnabledForUser,
  createAuthorizationCode,
  exchangeAuthorizationCode,
} = await import("./oauth");
const { isAllowedRedirectUri } = await import("./config");
const { prisma } = await import("@/lib/prisma");

function authorizationParams(redirectUri: string) {
  return new URLSearchParams({
    response_type: "code",
    client_id: "acat_client_test",
    redirect_uri: redirectUri,
    code_challenge: "test-code-challenge",
    code_challenge_method: "S256",
  });
}

describe("MCP OAuth redirect URI allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.ai:443/api/mcp/auth_callback",
    "http://localhost/callback",
    "http://localhost:49152/callback?client=local",
    "http://127.0.0.1:3000/oauth/callback",
  ])("allows the supported callback %s", (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(true);
  });

  it.each([
    "https://attacker.example/callback",
    "https://evilclaude.ai/api/mcp/auth_callback",
    "https://claude.ai.attacker.example/api/mcp/auth_callback",
    "https://attacker.example@claude.ai/api/mcp/auth_callback",
    "https://claude.ai/other/callback",
    "https://claude.ai/api/mcp/auth_callback?next=https://attacker.example",
    "https://claude.ai/api/mcp/auth_callback#fragment",
    "http://claude.ai/api/mcp/auth_callback",
    "http://localhost.attacker.example/callback",
    "http://attacker.example@localhost/callback",
    "ftp://localhost/callback",
  ])("rejects the unsupported callback %s", (uri) => {
    expect(isAllowedRedirectUri(uri)).toBe(false);
  });

  it("rejects an attacker callback during dynamic client registration", async () => {
    await expect(
      registerOAuthClient({
        client_name: "Claude",
        redirect_uris: ["https://attacker.example/callback"],
      })
    ).rejects.toMatchObject({
      code: "invalid_client_metadata",
      status: 400,
    });
    expect(prisma.mcpOAuthClient.create).not.toHaveBeenCalled();
  });

  it("rejects an attacker callback before an existing client can authorize", () => {
    expect(() =>
      parseAuthorizationRequest(
        authorizationParams("https://attacker.example/callback")
      )
    ).toThrow("Invalid redirect URI");
    expect(prisma.mcpOAuthClient.findUnique).not.toHaveBeenCalled();
  });
});

describe("MCP OAuth current user authorization", () => {
  const user = { email: "operator@example.test", active: true, mcpEnabled: true, role: "USER" };
  const future = new Date("2099-01-01");
  const verifier = "test-pkce-verifier";
  const codeInput = { code: "acat_code_existing", clientId: "client-1", redirectUri: "http://localhost/callback", codeVerifier: verifier };
  const authorization = () => ({
    id: "code-1", userEmail: user.email, clientId: "client-db-1", consumedAt: null, expiresAt: future,
    redirectUri: codeInput.redirectUri, codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    scopes: ["acats:read"], client: { clientId: "client-1", revokedAt: null },
  });
  const refresh = () => ({
    id: "rt-1", connectionId: "connection-1", revokedAt: null, rotatedToId: null, expiresAt: future,
    connection: {
      userEmail: user.email, revokedAt: null, expiresAt: future, scopes: ["acats:read"],
      client: { clientId: "client-1", revokedAt: null }, user: { ...user },
    },
  });
  const refreshInput = { refreshToken: "acat_rt_existing", clientId: "client-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_ENABLED = "1";
    vi.mocked(prisma.mcpSettings.findUnique).mockResolvedValue({ enabled: true } as never);
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...user } as never);
    vi.mocked(prisma.mcpOAuthAuthorizationCode.findUnique).mockResolvedValue(authorization() as never);
    vi.mocked(prisma.mcpOAuthAuthorizationCode.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.mcpConnection.create).mockResolvedValue({ id: "connection-1", expiresAt: future } as never);
    vi.mocked(prisma.mcpConnection.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.mcpRefreshToken.findUnique).mockResolvedValue(refresh() as never);
    vi.mocked(prisma.mcpRefreshToken.create).mockResolvedValue({ id: "rt-new", expiresAt: future } as never);
    vi.mocked(prisma.mcpRefreshToken.updateMany).mockResolvedValue({ count: 1 });
  });

  it.each(["ADMIN", "USER"])("issues and refreshes credentials for eligible %s users", async (role) => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...user, role } as never);
    const token = refresh();
    token.connection.user.role = role;
    vi.mocked(prisma.mcpRefreshToken.findUnique).mockResolvedValue(token as never);
    await expect(exchangeAuthorizationCode(codeInput)).resolves.toMatchObject({ token_type: "Bearer" });
    await expect(refreshAccessToken(refreshInput)).resolves.toMatchObject({ token_type: "Bearer" });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it.each([
    { role: "ADVISOR" },
    { role: "UNKNOWN_FUTURE_ROLE" },
    { active: false },
    { mcpEnabled: false },
  ])("denies approval, code issuance/exchange, and refresh for current state %j", async (change) => {
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ ...user, ...change } as never);
    const token = refresh();
    Object.assign(token.connection.user, change);
    vi.mocked(prisma.mcpRefreshToken.findUnique).mockResolvedValue(token as never);
    await expect(assertMcpEnabledForUser(user.email)).rejects.toMatchObject({ code: "access_denied" });
    await expect(createAuthorizationCode({ userEmail: user.email, clientDbId: "client-db-1", redirectUri: codeInput.redirectUri, scopes: ["acats:read"], codeChallenge: "challenge" })).rejects.toMatchObject({ code: "access_denied" });
    await expect(exchangeAuthorizationCode(codeInput)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(refreshAccessToken(refreshInput)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.mcpOAuthAuthorizationCode.create).not.toHaveBeenCalled();
    expect(prisma.mcpAccessToken.create).not.toHaveBeenCalled();
    expect(prisma.mcpRefreshToken.create).not.toHaveBeenCalled();
  });

  it("rechecks eligibility after waiting for the user lock during approval and refresh", async () => {
    vi.mocked(prisma.allowedUser.findUnique)
      .mockResolvedValueOnce({ ...user } as never)
      .mockResolvedValue({ ...user, role: "ADVISOR" } as never);
    await expect(createAuthorizationCode({ userEmail: user.email, clientDbId: "client-db-1", redirectUri: codeInput.redirectUri, scopes: ["acats:read"], codeChallenge: "challenge" })).rejects.toMatchObject({ code: "access_denied" });
    await expect(refreshAccessToken(refreshInput)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.mcpOAuthAuthorizationCode.create).not.toHaveBeenCalled();
    expect(prisma.mcpAccessToken.create).not.toHaveBeenCalled();
  });

  it("does not exchange a grant revoked while waiting, even after the owner returns to USER", async () => {
    vi.mocked(prisma.mcpOAuthAuthorizationCode.updateMany).mockResolvedValue({ count: 0 });
    await expect(exchangeAuthorizationCode(codeInput)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.mcpConnection.create).not.toHaveBeenCalled();
    expect(prisma.mcpAccessToken.create).not.toHaveBeenCalled();
  });

  it("does not refresh a connection revoked while waiting, even after the owner returns to USER", async () => {
    vi.mocked(prisma.mcpConnection.updateMany).mockResolvedValue({ count: 0 });
    await expect(refreshAccessToken(refreshInput)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.mcpRefreshToken.create).not.toHaveBeenCalled();
    expect(prisma.mcpAccessToken.create).not.toHaveBeenCalled();
  });

  it("commits family revocation when a concurrent refresh already rotated the token", async () => {
    vi.mocked(prisma.mcpRefreshToken.findUnique)
      .mockResolvedValueOnce(refresh() as never)
      .mockResolvedValueOnce({ ...refresh(), rotatedToId: "winner-refresh" } as never);

    await expect(refreshAccessToken(refreshInput)).rejects.toMatchObject({
      code: "invalid_grant", message: "Refresh token reuse detected",
    });
    expect(prisma.mcpConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: {
        revokedAt: expect.any(Date),
        refreshTokens: { update: { where: { id: "rt-1" }, data: { reusedAt: expect.any(Date) } } },
        accessTokens: { updateMany: { where: { revokedAt: null }, data: { revokedAt: expect.any(Date) } } },
      },
    });
    // A resolved transaction proves the revocation was not rolled back by the
    // error returned to the client. Real database race coverage checks locking.
    await expect(vi.mocked(prisma.$transaction).mock.results[0].value).resolves.toBeNull();
    expect(prisma.mcpRefreshToken.create).not.toHaveBeenCalled();
    expect(prisma.mcpAccessToken.create).not.toHaveBeenCalled();
  });

  it("does not revive a consumed grant or revoked refresh token after promotion", async () => {
    vi.mocked(prisma.mcpOAuthAuthorizationCode.findUnique).mockResolvedValue({ ...authorization(), consumedAt: new Date() } as never);
    vi.mocked(prisma.mcpRefreshToken.findUnique).mockResolvedValue({ ...refresh(), revokedAt: new Date() } as never);
    await expect(exchangeAuthorizationCode(codeInput)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(refreshAccessToken(refreshInput)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(prisma.mcpAccessToken.create).not.toHaveBeenCalled();
  });
});

describe("MCP OAuth token refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_ENABLED = "0";
  });

  it("rejects refresh-token exchange when global MCP is disabled", async () => {
    (prisma.mcpSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
    });

    await expect(
      refreshAccessToken({
        refreshToken: "acat_rt_existing",
        clientId: "acat_client_existing",
      })
    ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    expect(prisma.mcpRefreshToken.findUnique).not.toHaveBeenCalled();
  });
});
