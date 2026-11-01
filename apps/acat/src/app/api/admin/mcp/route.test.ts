import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { PATCH } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const toggle = (enabled: boolean) =>
  PATCH(new NextRequest("http://localhost/api/admin/mcp", { method: "PATCH", body: JSON.stringify({ enabled }) }));

describe("PATCH /api/admin/mcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { email: "admin@example.com", role: "ADMIN" } });
    vi.mocked(prisma.mcpSettings.upsert).mockResolvedValue({ id: "global", enabled: true } as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to turn MCP on in the demo, which runs no MCP server", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    const res = await toggle(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Claude MCP is off in this demo." });
    expect(prisma.mcpSettings.upsert).not.toHaveBeenCalled();
  });

  it("lets an admin change the global switch outside the demo", async () => {
    expect((await toggle(true)).status).toBe(200);
    expect(prisma.mcpSettings.upsert).toHaveBeenCalledOnce();
  });

  it("is for admins only", async () => {
    mockAuth.mockResolvedValue({ user: { email: "ops@example.com", role: "USER" } });
    expect((await toggle(true)).status).toBe(403);
    expect(prisma.mcpSettings.upsert).not.toHaveBeenCalled();
  });
});
