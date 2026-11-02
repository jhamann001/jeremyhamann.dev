import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, flagSpy, roleSpy, workspaceSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  flagSpy: vi.fn(),
  roleSpy: vi.fn(),
  workspaceSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/flags", () => ({ crmRelationshipsEnabled: flagSpy }));
vi.mock("@/lib/data/crm-relationships", () => ({ canReadCrmRelationships: roleSpy }));
vi.mock("@/lib/data/crm-relationship-workspace", () => ({
  getCrmRelationshipWorkspace: workspaceSpy,
}));

import { GET } from "@/app/api/crm/relationships/route";

const request = (root = "con_example") =>
  new Request(`https://ops-portal.example/api/crm/relationships?root=${root}`);

describe("client relationship workspace API", () => {
  beforeEach(() => {
    authSpy.mockReset();
    flagSpy.mockReset();
    roleSpy.mockReset();
    workspaceSpy.mockReset();
    authSpy.mockResolvedValue({
      user: { email: "operations@example.com", role: "OPERATIONS" },
    });
    flagSpy.mockReturnValue(true);
    roleSpy.mockReturnValue(true);
    workspaceSpy.mockResolvedValue({
      ok: true,
      data: {
        rootIdentityId: "con_example",
        nodes: [],
        edges: [],
        totalNodeCount: 1,
      },
    });
  });

  it("requires an authenticated user", async () => {
    authSpy.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(workspaceSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the feature or role is unavailable", async () => {
    roleSpy.mockReturnValue(false);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(workspaceSpy).not.toHaveBeenCalled();
  });

  it("returns only the scoped workspace without shared caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(workspaceSpy).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "operations@example.com" },
      "con_example",
    );
    expect(await response.json()).toEqual({
      data: {
        rootIdentityId: "con_example",
        nodes: [],
        edges: [],
        totalNodeCount: 1,
      },
    });
  });

  it("preserves traversal overflow as a bounded response", async () => {
    workspaceSpy.mockResolvedValue({ ok: false, reason: "row_limit_exceeded" });
    expect((await GET(request())).status).toBe(422);
  });
});
