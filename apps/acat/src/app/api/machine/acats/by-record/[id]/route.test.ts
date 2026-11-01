import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const { GET, PATCH } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const RECORD_ID = "REC-001";
// A real, non-unique acatTransferId placeholder — the whole reason this by-id
// route exists. Two records can share this; only `id` disambiguates them.
const PLACEHOLDER_TRANSFER_ID = "N/A";

// A full DB row shape (superset of what the projection emits) so we can prove
// PII fields are dropped and account identifiers masked.
const dbRecord = {
  id: RECORD_ID,
  clientName: "Sarah Jenkins",
  wealthAdvisor: "Dana Advisor",
  notes: "some note",
  crmDealId: "DEAL-9",
  tradeInstructions: "sell winners",
  controlNumber: "CTRL-9001",
  acatTransferId: PLACEHOLDER_TRANSFER_ID,
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
  return new Request(`http://localhost/api/machine/acats/by-record/${RECORD_ID}`, {
    headers: authHeader ? { authorization: authHeader } : {},
  }) as Parameters<typeof GET>[0];
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
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

describe("GET /api/machine/acats/by-record/[id]", () => {
  it.each([ALLOWED_SA, "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com"])("returns the same trimmed, redacted projection for %s", async (email) => {
    markCase("machine-acat-detail", "returns the same trimmed, redacted projection");
    allowGoodToken(email);
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRecord);

    const res = await GET(makeRequest("Bearer good.token"), makeParams(RECORD_ID));
    const data = await res.json();

    expect(res.status).toBe(200);

    // Looked up by the record `id` (the PK — @unique) via findUnique, not by
    // the non-unique acatTransferId, and still excluding soft-deleted rows.
    expect(prisma.acatRecord.findUnique).toHaveBeenCalledWith({
      where: { id: RECORD_ID, deletedAt: null },
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
    expect(data.acatTransferId).toBe(PLACEHOLDER_TRANSFER_ID);
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

    const res = await GET(makeRequest("Bearer wrong.aud.token"), makeParams(RECORD_ID));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when the caller email is not in the allowlist", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticket({ email: "attacker@evil.iam.gserviceaccount.com", email_verified: true })
    );

    const res = await GET(makeRequest("Bearer good.sig.wrong.sa"), makeParams(RECORD_ID));

    expect(res.status).toBe(401);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when email_verified is false", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticket({ email: ALLOWED_SA, email_verified: false })
    );

    const res = await GET(makeRequest("Bearer unverified.token"), makeParams(RECORD_ID));

    expect(res.status).toBe(401);
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing Authorization header", async () => {
    const res = await GET(makeRequest(), makeParams(RECORD_ID));
    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 for a garbage Authorization header", async () => {
    const res = await GET(makeRequest("Token nope"), makeParams(RECORD_ID));
    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("returns 401 (not 500) when verifyIdToken throws", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("No pem found for envelope"));
    const res = await GET(makeRequest("Bearer boom"), makeParams(RECORD_ID));
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown record id", async () => {
    allowGoodToken();
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await GET(makeRequest("Bearer good.token"), makeParams("does-not-exist"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 WITHOUT querying Prisma for a blank id (guard: never reaches findUnique)", async () => {
    allowGoodToken();

    const res = await GET(makeRequest("Bearer good.token"), makeParams("   "));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // A blank/undefined id must never reach Prisma.
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("resolves DISTINCT records for two ids sharing the same placeholder acatTransferId", async () => {
    // The core bug this route fixes: two records both carry acatTransferId "N/A"
    // but have distinct record ids — each id must resolve to ITS OWN record.
    allowGoodToken();
    const findUnique = prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>;

    findUnique.mockResolvedValueOnce({
      ...dbRecord,
      id: "REC-A",
      apexAccountId: "BLSTACCTAAAA",
    });
    const resA = await GET(makeRequest("Bearer good.token"), makeParams("REC-A"));
    const dataA = await resA.json();

    findUnique.mockResolvedValueOnce({
      ...dbRecord,
      id: "REC-B",
      apexAccountId: "BLSTACCTBBBB",
    });
    const resB = await GET(makeRequest("Bearer good.token"), makeParams("REC-B"));
    const dataB = await resB.json();

    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "REC-A", deletedAt: null },
      include: { assets: true },
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: "REC-B", deletedAt: null },
      include: { assets: true },
    });
    // Both share acatTransferId "N/A" but resolve to DIFFERENT records.
    expect(dataA.acatTransferId).toBe(PLACEHOLDER_TRANSFER_ID);
    expect(dataB.acatTransferId).toBe(PLACEHOLDER_TRANSFER_ID);
    expect(dataA.apexAccountId).toBe("********AAAA");
    expect(dataB.apexAccountId).toBe("********BBBB");
    expect(dataA.apexAccountId).not.toBe(dataB.apexAccountId);
  });

  it("authenticates a lowercase 'bearer' scheme (RFC 7235 case-insensitive)", async () => {
    allowGoodToken();
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dbRecord);

    const res = await GET(makeRequest("bearer good.token"), makeParams(RECORD_ID));

    expect(res.status).toBe(200);
  });
});

describe("ticket drawer reveal on the by-record detail", () => {
  const EPIC = "EPIC_ACAT_TRANSFER_DRAWER";
  const ROLLOUT = "ROLLOUT_ACAT_TRANSFER_DRAWER";
  const linkedRecord = { ...dbRecord, identityVersion: 5 };

  afterEach(() => {
    delete process.env[EPIC];
    delete process.env[ROLLOUT];
  });

  it("detail: flag off keeps DTCC masked and omits the identity version", async () => {
    markCase("machine-acat-detail", "flag off keeps DTCC masked and omits the identity version");
    allowGoodToken();
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(linkedRecord);
    process.env[EPIC] = "1"; // only one switch on is still off
    const data = await (await GET(makeRequest("Bearer good.token"), makeParams(RECORD_ID))).json();
    expect(data.dtccNumber).toBe("****");
    expect(data).not.toHaveProperty("identityVersion");
  });

  it("detail: flag on reveals only DTCC and returns the identity version", async () => {
    markCase("machine-acat-detail", "flag on reveals only DTCC and returns the identity version");
    allowGoodToken();
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(linkedRecord);
    process.env[EPIC] = "1";
    process.env[ROLLOUT] = "1";
    const data = await (await GET(makeRequest("Bearer good.token"), makeParams(RECORD_ID))).json();
    expect(data.dtccNumber).toBe("0061");
    expect(data.identityVersion).toBe(5);
    expect(data.apexAccountId).toBe("********QZ7K");
    expect(data.statementAccountNumber).toBe("********0061");
    expect(data.assets[0].cusip).toBe("*****3100");
  });

  it("detail: PATCH response follows the same flag", async () => {
    markCase("machine-acat-detail", "PATCH response follows the same flag");
    allowGoodToken();
    vi.mocked(prisma.$transaction).mockImplementation(((fn: (tx: unknown) => unknown) => fn(prisma)) as never);
    (prisma.acatRecord.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...linkedRecord, clientLinks: [] });
    (prisma.acatRecord.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...linkedRecord, clientLinks: [], wealthAdvisor: "Pat" });
    const patch = () => PATCH(
      new Request(`http://localhost/api/machine/acats/by-record/${RECORD_ID}`, {
        method: "PATCH",
        headers: { authorization: "Bearer good.token" },
        body: JSON.stringify({ wealthAdvisor: "Pat" }),
      }),
      makeParams(RECORD_ID),
    );
    const off = await (await patch()).json();
    expect(off.dtccNumber).toBe("****");
    expect(off).not.toHaveProperty("identityVersion");
    process.env[EPIC] = "1";
    process.env[ROLLOUT] = "1";
    const on = await (await patch()).json();
    expect(on.dtccNumber).toBe("0061");
    expect(on.identityVersion).toBe(5);
  });
});
