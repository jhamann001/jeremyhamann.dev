import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const verifyDashboardCaller = vi.fn();
vi.mock("@/lib/machine-auth", () => ({ verifyDashboardCaller }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { POST } = await import("./route");
const { prisma } = await import("@/lib/prisma");
const { rateLimit } = await import("@/lib/rate-limit-redis");

const validBody = {
  acatRecordId: "rec-1",
  ruleKey: "completed_missing_date",
  fingerprint: "fingerprint",
  status: "CLOSED",
  resolution: "CORRECTED",
  note: null,
};
const request = (body = validBody) =>
  new Request("http://localhost/api/machine/dashboard/reviews", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EPIC_ACAT_TRANSFER_DASHBOARD = "1";
  process.env.SHOW_ACAT_TRANSFER_DASHBOARD = "1";
  verifyDashboardCaller.mockResolvedValue({ email: "ops-portal-run@ops-portal.iam.gserviceaccount.com" });
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 29 });
  vi.mocked(prisma.acatRecord.findFirst).mockResolvedValue({ id: "rec-1" } as never);
  vi.mocked(prisma.dataQualityReview.upsert).mockResolvedValue({ id: "review-1", ...validBody } as never);
});

describe("POST /api/machine/dashboard/reviews", () => {
  it("denies the scoped dev identity a review write", async () => {
    verifyDashboardCaller.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });

  it("allows the production identity to write a review", async () => {
    expect((await POST(request())).status).toBe(200);
  });

  it("rejects a required-note close with status 400", async () => {
    const response = await POST(request({ ...validBody, resolution: "FALSE_POSITIVE", note: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "note: A note is required for this resolution" });
    markCase("machine-dashboard-review", "rejects a required-note close with status 400");
  });

  it("upserts a review without updating the transfer", async () => {
    await POST(request());
    expect(prisma.dataQualityReview.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    markCase("machine-dashboard-review", "upserts a review without updating the transfer");
  });

  it("returns transfer not found for a removed or missing record", async () => {
    vi.mocked(prisma.acatRecord.findFirst).mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "transfer_not_found" });
  });

  it("returns rate_limited without querying Prisma", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false, remaining: 0 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });
});
