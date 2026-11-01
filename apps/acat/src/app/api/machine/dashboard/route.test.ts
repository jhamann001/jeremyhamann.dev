import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const verifyDashboardCaller = vi.fn();
const composeDashboardContract = vi.fn();
vi.mock("@/lib/machine-auth", () => ({ verifyDashboardCaller }));
vi.mock("@/lib/dashboard-contract", () => ({ composeDashboardContract }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");
const { rateLimit } = await import("@/lib/rate-limit-redis");

const request = () => new Request("http://localhost/api/machine/dashboard");
const contract = {
  summary: { total: 1 },
  workflowTimings: [],
  monthlyVolume: [{ month: "2025-06", total: 1 }],
  flow: { netAmount: 100 },
  topContras: { acat: [{ contra: "Fidelity" }], manual: [] },
  residuals: { queue: [{ record: { id: "r1" } }], benchmarks: [{ contra: "Fidelity", sampleSize: 1, medianDays: 2, p75Days: 2, p90Days: 2 }] },
  quality: { rules: Array.from({ length: 18 }, (_, index) => ({ ruleKey: `r${index}` })), exceptions: [{ ruleKey: "x" }] },
  reconciliation: { eligible: 1, tracked: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EPIC_ACAT_TRANSFER_DASHBOARD = "1";
  process.env.SHOW_ACAT_TRANSFER_DASHBOARD = "1";
  verifyDashboardCaller.mockResolvedValue({ email: "ops-portal-run@ops-portal.iam.gserviceaccount.com" });
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 29 });
  vi.mocked(prisma.acatRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.dataQualityReview.findMany).mockResolvedValue([] as never);
  composeDashboardContract.mockReturnValue(contract);
});

describe("GET /api/machine/dashboard", () => {
  it("returns 404 while either dashboard flag is off", async () => {
    for (const [epic, show] of [["0", "1"], ["1", "0"]]) {
      process.env.EPIC_ACAT_TRANSFER_DASHBOARD = epic;
      process.env.SHOW_ACAT_TRANSFER_DASHBOARD = show;
      const response = await GET(request());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
    markCase("machine-dashboard", "returns 404 while either dashboard flag is off");
  });

  it("returns the composed dashboard contract for an authorized production caller", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(contract);
    expect(Object.keys(contract)).toEqual(["summary", "workflowTimings", "monthlyVolume", "flow", "topContras", "residuals", "quality", "reconciliation"]);
    expect(contract.quality.rules).toHaveLength(18);
    markCase("machine-dashboard", "returns the composed dashboard contract for an authorized production caller");
  });

  it("queries the same bounded live record set as GET /api/acats", async () => {
    await GET(request());
    expect(prisma.acatRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5000,
    }));
  });

  it("returns internal_error when dashboard storage fails", async () => {
    vi.mocked(prisma.acatRecord.findMany).mockRejectedValue(new Error("db"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });

  it("returns unauthorized without querying Prisma", async () => {
    verifyDashboardCaller.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("allows the scoped dev identity to read", async () => {
    verifyDashboardCaller.mockResolvedValue({ email: "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com" });
    expect((await GET(request())).status).toBe(200);
  });
});
