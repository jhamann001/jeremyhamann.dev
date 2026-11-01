import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const mockVerifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";

function restoreRequest() {
  return new Request("http://localhost/api/machine/acats/by-record/REC-1/restore", {
    method: "POST",
    headers: { authorization: "Bearer good" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({
    getPayload: () => ({ email: ALLOWED_SA, email_verified: true }),
  });
});

describe("machine ACAT restore", () => {
  it("restores a deleted transfer by clearing deletedAt", async () => {
    markCase("machine-acat-restore", "restores a deleted transfer by clearing deletedAt");
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({
      id: "REC-1",
      deletedAt: new Date("2026-07-01T00:00:00Z"),
    } as never);
    vi.mocked(prisma.acatRecord.update).mockResolvedValue({} as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);

    const res = await POST(restoreRequest(), { params: Promise.resolve({ id: "REC-1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const first = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0];
    if (!first) throw new Error("update was not called");
    expect(first.data).toEqual({ deletedAt: null });
  });

  it("returns 404 when the transfer does not exist", async () => {
    markCase("machine-acat-restore", "returns 404 when the transfer does not exist");
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(null);

    const res = await POST(restoreRequest(), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });
});
