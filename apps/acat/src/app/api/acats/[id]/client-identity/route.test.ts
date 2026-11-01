import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { markCase } from "@/lib/test-flywheel";

const mockRequireOperator = vi.fn();
vi.mock("@/lib/client-identity-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-identity-http")>();
  return { ...actual, requireIdentityOperator: () => mockRequireOperator() };
});

const mockRelink = vi.fn();
vi.mock("@/lib/client-identity-relink", () => ({
  relinkAcatClients: (...args: unknown[]) => mockRelink(...args),
}));

const { PUT } = await import("./route");

const body = {
  cedarRidgeUserId: "user-22222222-2222-2222-2222-222222222222",
  expectedIdentityVersion: 5,
  reason: "Wrong person linked",
};

function put(payload: unknown = body) {
  return PUT(
    new NextRequest("http://localhost/api/acats/REC-1/client-identity", { method: "PUT", body: JSON.stringify(payload) }),
    { params: Promise.resolve({ id: "REC-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOperator.mockResolvedValue({ email: "ops.person@example.com" });
});

describe("PUT /api/acats/[id]/client-identity", () => {
  it("relink route: unauthenticated request is 401 and never reaches the helper", async () => {
    markCase("client-identity-route", "unauthenticated request is 401 and never reaches the helper");
    mockRequireOperator.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const res = await put();
    expect(res.status).toBe(401);
    expect(mockRelink).not.toHaveBeenCalled();
  });

  it("relink route: forbidden role is 403", async () => {
    markCase("client-identity-route", "forbidden role is 403");
    mockRequireOperator.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    const res = await put();
    expect(res.status).toBe(403);
    expect(mockRelink).not.toHaveBeenCalled();
  });

  it("relink route: success keeps status 200 and private no-store caching", async () => {
    markCase("client-identity-route", "success keeps status 200 and private no-store caching");
    mockRelink.mockResolvedValue({
      kind: "record",
      record: { id: "REC-1", clientName: "Sarah Selected", clientLinks: [{ cedarRidgeUserId: body.cedarRidgeUserId, client: { canonicalName: "Sarah Selected" } }] },
    });
    const res = await put();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const json = await res.json();
    expect(json.clientName).toBe("Sarah Selected");
    expect(json.cedarRidgeUserId).toBe(body.cedarRidgeUserId);
    expect(json.linkedClients).toEqual([{ cedarRidgeUserId: body.cedarRidgeUserId, displayName: "Sarah Selected" }]);
    expect(mockRelink).toHaveBeenCalledWith({
      id: "REC-1",
      input: expect.objectContaining({ expectedIdentityVersion: 5, reason: "Wrong person linked" }),
      performedBy: "ops.person@example.com",
    });
  });
});
