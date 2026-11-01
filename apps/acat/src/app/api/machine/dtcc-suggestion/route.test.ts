import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const mockRateLimit = vi.fn();
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const PROD_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const EPIC = "EPIC_ACAT_TRANSFER_DRAWER";
const ROLLOUT = "ROLLOUT_ACAT_TRANSFER_DRAWER";

function ticket(email: string) {
  return { getPayload: () => ({ email, email_verified: true }) };
}

function request(query = "?contra=Fidelity") {
  return new Request(`http://localhost/api/machine/dtcc-suggestion${query}`, {
    headers: { authorization: "Bearer good" },
  });
}

function seed(history: Array<{ transferringContra: string; dtccNumber: string }>, custodians: Array<{ name: string; dtcNumber: string | null }> = []) {
  vi.mocked(prisma.acatRecord.findMany).mockResolvedValue(history as never);
  vi.mocked(prisma.custodian.findMany).mockResolvedValue(custodians as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[EPIC] = "1";
  process.env[ROLLOUT] = "1";
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  mockVerifyIdToken.mockResolvedValue(ticket(PROD_SA));
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  seed([]);
});

afterEach(() => {
  delete process.env[EPIC];
  delete process.env[ROLLOUT];
});

describe("machine DTCC suggestion", () => {
  it("dtcc: off returns 404 with zero auth and database calls", async () => {
    markCase("machine-dtcc-suggestion", "off returns 404 with zero auth and database calls");
    delete process.env[EPIC];
    const res = await GET(request());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
    expect(prisma.custodian.findMany).not.toHaveBeenCalled();
  });

  it("dtcc: unauthorized returns 401", async () => {
    markCase("machine-dtcc-suggestion", "unauthorized returns 401");
    mockVerifyIdToken.mockRejectedValue(new Error("bad token"));
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("dtcc: production caller gets the history suggestion", async () => {
    markCase("machine-dtcc-suggestion", "production caller gets the history suggestion");
    seed([
      { transferringContra: "Fidelity", dtccNumber: "0731" },
      { transferringContra: "Fidelity", dtccNumber: "731" },
    ]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "suggested", dtccNumber: "0731", source: "history", historicalSampleSize: 2 });
    expect(vi.mocked(prisma.acatRecord.findMany).mock.calls[0]?.[0]).toEqual({
      where: { deletedAt: null, transferringContra: { not: null } },
      select: { transferringContra: true, dtccNumber: true },
    });
  });

  it("dtcc: scoped dev caller gets the suggestion", async () => {
    markCase("machine-dtcc-suggestion", "scoped dev caller gets the suggestion");
    mockVerifyIdToken.mockResolvedValue(ticket(DEV_SA));
    seed([
      { transferringContra: "Fidelity", dtccNumber: "0061" },
      { transferringContra: "Fidelity", dtccNumber: "0061" },
    ]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("suggested");
  });

  it("dtcc: custodian number is the suggestion source when present", async () => {
    markCase("machine-dtcc-suggestion", "custodian number is the suggestion source when present");
    seed([], [{ name: "Fidelity", dtcNumber: "472" }]);
    const res = await GET(request());
    expect(await res.json()).toEqual({ status: "suggested", dtccNumber: "0472", source: "custodian", historicalSampleSize: 0 });
  });

  it("dtcc: conflicting evidence is ambiguous", async () => {
    markCase("machine-dtcc-suggestion", "conflicting evidence is ambiguous");
    seed([{ transferringContra: "Fidelity", dtccNumber: "0061" }], [{ name: "Fidelity", dtcNumber: "0226" }]);
    const body = await (await GET(request())).json();
    expect(body).toEqual({ status: "ambiguous", dtccNumber: null, source: null, historicalSampleSize: 1 });
  });

  it("dtcc: empty contra returns none", async () => {
    markCase("machine-dtcc-suggestion", "empty contra returns none");
    const res = await GET(request("?contra=%20%20"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 });
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("dtcc: contra over 120 characters returns 400", async () => {
    markCase("machine-dtcc-suggestion", "contra over 120 characters returns 400");
    const res = await GET(request(`?contra=${"a".repeat(121)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Contra is too long" });
  });

  it("dtcc: storage failure returns 500", async () => {
    markCase("machine-dtcc-suggestion", "storage failure returns 500");
    vi.mocked(prisma.acatRecord.findMany).mockRejectedValue(new Error("db down"));
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  it("dtcc: rate limited returns 429", async () => {
    markCase("machine-dtcc-suggestion", "rate limited returns 429");
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const res = await GET(request());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });
});
