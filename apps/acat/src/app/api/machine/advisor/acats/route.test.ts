import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { ADVISOR_VISIBLE_KEYS } from "@/lib/advisor-redaction";

const verifyAcatReadCaller = vi.fn();
vi.mock("@/lib/machine-auth", () => ({ verifyAcatReadCaller }));
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
const { logger } = await import("@/lib/logger");

const CALLER = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const ADVISOR_EMAIL = "advisor@example.com";

const request = (email: string | null = ADVISOR_EMAIL) =>
  new Request("http://localhost/api/machine/advisor/acats", {
    headers: email === null ? {} : { "X-OpsPortal-Actor-Email": email },
  });

const fullRecord = {
  id: "REC-001",
  clientName: "Sarah Jenkins",
  apexAccountId: "APX-secret-001",
  statementAccountNumber: "STMT-secret-001",
  controlNumber: "CTRL-secret-001",
  dtccNumber: "1234",
  status: "Submitted",
  direction: "In",
  type: "Full",
  accountType: "Traditional IRA",
  transferringContra: "Charles Schwab",
  wealthAdvisor: "Rachel",
  originalClientRequestDate: "2026-04-01",
  opsSubmissionDateToApex: "2026-04-03",
  apexCompletionDate: null,
  feeAmount: "$75.00",
  feeMemo: "internal-only fee context",
  notes: "internal-only ops notes",
  crmDealId: "CRM-secret-1",
  additionalResources: "https://crm.example/tasks/abc-123",
  statementAmount: 123456789,
  custodianId: "C1",
  custodian: {
    id: "C1",
    name: "Charles Schwab",
    acatFeeAmount: 50,
    avgProcessingDays: 6,
    contactEmail: "ops@schwab.example",
  },
  acatDate: "2026-04-01",
  deletedAt: null,
};

const findAccess = vi.mocked(prisma.allowedUser.findUnique);
const findRows = vi.mocked(prisma.acatRecord.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ROLLOUT_ACAT_ADVISOR_LIST = "1";
  verifyAcatReadCaller.mockResolvedValue({ email: CALLER });
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 59 });
  findAccess.mockResolvedValue({ active: true, role: "ADVISOR" } as never);
  findRows.mockResolvedValue([fullRecord] as never);
});

describe("GET /api/machine/advisor/acats", () => {
  it("returns 404 while the advisor list flag is off", async () => {
    for (const value of [undefined, "0"]) {
      if (value === undefined) delete process.env.ROLLOUT_ACAT_ADVISOR_LIST;
      else process.env.ROLLOUT_ACAT_ADVISOR_LIST = value;
      const response = await GET(request());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    expect(verifyAcatReadCaller).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(findAccess).not.toHaveBeenCalled();
    expect(findRows).not.toHaveBeenCalled();
    markCase("machine-advisor-list", "returns 404 while the advisor list flag is off");
  });

  it("asks the machine verifier for the advisor scope", async () => {
    await GET(request());
    expect(verifyAcatReadCaller).toHaveBeenCalledWith(expect.any(Request), "advisor");
    markCase("machine-advisor-list", "asks the machine verifier for the advisor scope");
  });

  it("returns unauthorized without querying Prisma", async () => {
    verifyAcatReadCaller.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(findAccess).not.toHaveBeenCalled();
    expect(findRows).not.toHaveBeenCalled();
    markCase("machine-advisor-list", "returns unauthorized without querying Prisma");
  });

  it("returns rate_limited without querying Prisma", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false, remaining: 0 });
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(rateLimit).toHaveBeenCalledWith(
      "machine-advisor-acats",
      CALLER,
      expect.objectContaining({ failClosed: true }),
    );
    expect(findAccess).not.toHaveBeenCalled();
    expect(findRows).not.toHaveBeenCalled();
    markCase("machine-advisor-list", "returns rate_limited without querying Prisma");
  });

  it("rejects a missing or malformed email", async () => {
    for (const email of [null, "", "nope"]) {
      const response = await GET(request(email));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(findAccess).not.toHaveBeenCalled();
    expect(findRows).not.toHaveBeenCalled();
    markCase("machine-advisor-list", "rejects a missing or malformed email");
  });

  it("returns redacted rows for an active advisor", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { acats: Array<Record<string, unknown>> };
    expect(body.acats).toHaveLength(1);
    expect(Object.keys(body.acats[0]).sort()).toEqual([...ADVISOR_VISIBLE_KEYS].sort());
    expect(body.acats[0].clientName).toBe("Sarah Jenkins");
    expect(findRows).toHaveBeenCalledWith({
      where: { deletedAt: null },
      include: { custodian: true },
      orderBy: [{ acatDate: "desc" }, { id: "desc" }],
      take: 5000,
    });
    markCase("machine-advisor-list", "returns redacted rows for an active advisor");
  });

  it("returns redacted rows for an active admin", async () => {
    findAccess.mockResolvedValue({ active: true, role: "ADMIN" } as never);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { acats: unknown[] }).acats).toHaveLength(1);
    markCase("machine-advisor-list", "returns redacted rows for an active admin");
  });

  it("omits account numbers, fee amounts, fee memos, and internal notes", async () => {
    const text = await (await GET(request())).text();
    for (const secret of [
      "APX-secret-001",
      "STMT-secret-001",
      "CTRL-secret-001",
      "$75.00",
      "internal-only fee context",
      "internal-only ops notes",
      "ops@schwab.example",
    ]) {
      expect(text).not.toContain(secret);
    }
    markCase("machine-advisor-list", "omits account numbers, fee amounts, fee memos, and internal notes");
  });

  it("returns an empty list for an allowed person with no transfers", async () => {
    findRows.mockResolvedValue([] as never);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acats: [] });
    markCase("machine-advisor-list", "returns an empty list for an allowed person with no transfers");
  });

  it("refuses a USER role, an inactive advisor, and an unknown email", async () => {
    for (const row of [
      { active: true, role: "USER" },
      { active: false, role: "ADVISOR" },
      null,
    ]) {
      findAccess.mockResolvedValue(row as never);
      const response = await GET(request());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "not_allowed" });
    }
    expect(findRows).not.toHaveBeenCalled();
    markCase("machine-advisor-list", "refuses a USER role, an inactive advisor, and an unknown email");
  });

  it("normalizes the requested email before lookup", async () => {
    await GET(request(" Advisor@example.com "));
    expect(findAccess).toHaveBeenCalledWith({
      where: { email: ADVISOR_EMAIL },
      select: { active: true, role: true },
    });
    markCase("machine-advisor-list", "normalizes the requested email before lookup");
  });

  it("returns internal_error when storage fails", async () => {
    findRows.mockRejectedValueOnce(new Error("DB down"));
    let response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    findAccess.mockRejectedValueOnce(new Error("DB down"));
    response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    markCase("machine-advisor-list", "returns internal_error when storage fails");
  });

  it("does not log the requested email", async () => {
    await GET(request());
    findAccess.mockResolvedValue(null as never);
    await GET(request());
    // A driver error that echoes the lookup arguments, as Prisma's can.
    findAccess.mockRejectedValueOnce(
      Object.assign(new Error(`Invalid findUnique invocation: where: { email: "${ADVISOR_EMAIL}" }`), { code: "P2024" }),
    );
    await GET(request());
    const logged = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logged).toContain("P2024");
    expect(logged).not.toContain(ADVISOR_EMAIL);
    markCase("machine-advisor-list", "does not log the requested email");
  });
});
