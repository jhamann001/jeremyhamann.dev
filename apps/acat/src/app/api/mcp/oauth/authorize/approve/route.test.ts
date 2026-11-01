import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

function makeFormRequest(body: Record<string, string>) {
  const form = new URLSearchParams(body);
  return new Request("http://localhost/api/mcp/oauth/authorize/approve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }) as Parameters<typeof POST>[0];
}

const baseBody = {
  client_id: "client-1",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: "challenge",
  scope: "acats:read",
  state: "state-1",
};

describe("POST /api/mcp/oauth/authorize/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_ENABLED = "1";
    mockAuth.mockResolvedValue({
      user: { email: "admin@example.com", role: "ADMIN" },
    });
  });

  it("returns JSON instead of redirecting to an unregistered redirect_uri", async () => {
    (prisma.mcpOAuthClient.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "client-db-id",
      clientId: "client-1",
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      scopes: ["acats:read"],
      revokedAt: null,
    });

    const res = await POST(
      makeFormRequest({
        ...baseBody,
        redirect_uri: "https://evil.example/callback",
      })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("invalid_request");
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects OAuth errors only after redirect_uri is validated", async () => {
    (prisma.mcpOAuthClient.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "client-db-id",
      clientId: "client-1",
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      scopes: ["acats:read"],
      revokedAt: null,
    });
    (prisma.mcpSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
    });

    const res = await POST(makeFormRequest(baseBody));
    const location = res.headers.get("location");

    expect(res.status).toBe(307);
    expect(location).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(location).toContain("error=temporarily_unavailable");
    expect(location).toContain("state=state-1");
  });
});
