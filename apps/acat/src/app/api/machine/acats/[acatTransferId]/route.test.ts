import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";

// The route runs the REAL verifyAcatReadCaller; we mock only the underlying
// google-auth-library verifyIdToken (per task) and prisma.
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

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const ACAT_TRANSFER_ID = "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

// A full DB row shape (superset of what the projection emits) so we can prove
// PII fields are dropped and account identifiers masked.
const dbRecord = {
  id: "REC-001",
  clientName: "Sarah Jenkins",
  wealthAdvisor: "Dana Advisor",
  notes: "some note",
  crmDealId: "DEAL-9",
  tradeInstructions: "sell winners",
  controlNumber: "CTRL-9001",
  acatTransferId: ACAT_TRANSFER_ID,
  direction: "IN",
  type: "FULL",
  accountType: "IRA",
  status: "InTransfer",
  apexAccountId: "BLSTACCTQZ7K",
  statementAccountNumber: "STMT00000061",
  transferringContra: "Schwab",
  dtccNumber: "0061",
  statementAmount: 5467768,
  methodRequested: "ACAT",
  feeCharged: "Yes",
  feeAmount: "$100.00",
  feeMemo: "ACAT fee",
  feeRequestSubmitted: "2026-07-01",
  feeRequestCompleted: "2026-07-02",
  acatDate: "2026-06-30",
  deletedAt: null,
  assets: [
    {
      id: "AST-1",
      symbol: "AAPL",
      description: "Apple Inc",
      cusip: "037833100",
      expectedQty: 100,
      actualQty: 98,
      mapStatus: "Mapped",
      issue: "short 2 shares",
      amount: 19000,
      assetClass: "Equity",
      notes: "asset internal note",
    },
  ],
};

function ticket(payload: Record<string, unknown> | undefined) {
  return { getPayload: () => payload };
}

function makeRequest(authHeader?: string) {
  return new Request(`http://localhost/api/machine/acats/${ACAT_TRANSFER_ID}`, {
    headers: authHeader ? { authorization: authHeader } : {},
  }) as Parameters<typeof GET>[0];
}

function makeParams(acatTransferId: string) {
  return { params: Promise.resolve({ acatTransferId }) };
}

function allowGoodToken(email = ALLOWED_SA) {
  mockVerifyIdToken.mockResolvedValue(
    ticket({ email, email_verified: true })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
});

describe("GET /api/machine/acats/[acatTransferId]", () => {
  it.each([ALLOWED_SA, "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com"])("returns the same trimmed, redacted projection for %s", async (email) => {
    markCase("machine-acat-detail", "returns the same trimmed, redacted projection");
    allowGoodToken(email);
    (prisma.acatRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(dbRecord);

    const res = await GET(makeRequest("Bearer good.token"), makeParams(ACAT_TRANSFER_ID));
    const data = await res.json();

    expect(res.status).toBe(200);

    // Looked up by acatTransferId via findFirst (field is not @unique),
    // excluding soft-deleted rows.
    expect(prisma.acatRecord.findFirst).toHaveBeenCalledWith({
      where: { acatTransferId: ACAT_TRANSFER_ID, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { assets: true },
    });

    expect(data.clientName).toBe("Sarah Jenkins");
    expect(data.wealthAdvisor).toBe("Dana Advisor");
    expect(data.notes).toBe("some note");
    expect(data.crmDealId).toBe("DEAL-9");
    expect(data.tradeInstructions).toBe("sell winners");

    // Account identifiers masked (last-4 style), never raw.
    expect(data.apexAccountId).toBe("********QZ7K");
    expect(data.apexAccountId).not.toContain("BLSTACCT");
    expect(data.statementAccountNumber).toBe("********0061");
    expect(data.dtccNumber).toBe("****");

    // Core status fields passed through.
    expect(data.acatTransferId).toBe(ACAT_TRANSFER_ID);
    expect(data.status).toBe("InTransfer");
    expect(data.controlNumber).toBe("CTRL-9001");

    // Assets: expected-vs-actual + issue included, cusip masked, no id/notes.
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0].expectedQty).toBe(100);
    expect(data.assets[0].actualQty).toBe(98);
    expect(data.assets[0].issue).toBe("short 2 shares");
    expect(data.assets[0].cusip).toBe("*****3100");
    expect(data.assets[0]).not.toHaveProperty("id");
    expect(data.assets[0]).not.toHaveProperty("notes");
  });

  it("returns 401 when the token audience is rejected (verifyIdToken throws)", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("Wrong recipient - payload audience != requiredAudience"));

    const res = await GET(makeRequest("Bearer wrong.aud.token"), makeParams(ACAT_TRANSFER_ID));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when the caller email is not in the allowlist", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticket({ email: "attacker@evil.iam.gserviceaccount.com", email_verified: true })
    );

    const res = await GET(makeRequest("Bearer good.sig.wrong.sa"), makeParams(ACAT_TRANSFER_ID));

    expect(res.status).toBe(401);
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when email_verified is false", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticket({ email: ALLOWED_SA, email_verified: false })
    );

    const res = await GET(makeRequest("Bearer unverified.token"), makeParams(ACAT_TRANSFER_ID));

    expect(res.status).toBe(401);
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing Authorization header", async () => {
    const res = await GET(makeRequest(), makeParams(ACAT_TRANSFER_ID));
    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 for a garbage Authorization header", async () => {
    const res = await GET(makeRequest("Token nope"), makeParams(ACAT_TRANSFER_ID));
    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns 401 (not 500) when verifyIdToken throws", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("No pem found for envelope"));
    const res = await GET(makeRequest("Bearer boom"), makeParams(ACAT_TRANSFER_ID));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown acatTransferId", async () => {
    allowGoodToken();
    (prisma.acatRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await GET(makeRequest("Bearer good.token"), makeParams("does-not-exist"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 WITHOUT querying Prisma for a blank acatTransferId (guard: never drops the filter / matches a null row)", async () => {
    allowGoodToken();

    const res = await GET(makeRequest("Bearer good.token"), makeParams("   "));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // A blank/undefined id must never reach Prisma — an undefined value would
    // drop the where filter and findFirst would return an arbitrary client's row.
    expect(prisma.acatRecord.findFirst).not.toHaveBeenCalled();
  });

  it("authenticates a lowercase 'bearer' scheme (RFC 7235 case-insensitive)", async () => {
    allowGoodToken();
    (prisma.acatRecord.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(dbRecord);

    const res = await GET(makeRequest("bearer good.token"), makeParams(ACAT_TRANSFER_ID));

    expect(res.status).toBe(200);
  });
});
