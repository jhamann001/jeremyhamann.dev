import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import type { AcatRecord } from "@/lib/types";

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

// Rate limiter: always allow unless a test overrides it.
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");
const { rateLimit } = await import("@/lib/rate-limit-redis");
const { acatClientLinksSelection, toOperationalAcat } = await import("@/lib/acat-identity-dto");
const { RECORD_FIELDS_BY_KEY } = await import("@/lib/record-fields");
const { BOOK_RECORD_COLUMN_KEYS } = await import("@/lib/mcp/redaction");

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";

// Minimal DB row factory (superset of the projection). `id` doubles as a
// stable handle in assertions.
let seq = 0;
function row(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `REC-${seq}`,
    clientName: "Sarah Jenkins",
    wealthAdvisor: "Dana Advisor",
    notes: "internal only — do not leak",
    controlNumber: `CTRL-${seq}`,
    acatTransferId: `TR-${seq}`,
    direction: "IN",
    type: "FULL",
    accountType: "IRA",
    status: "Submitted",
    apexAccountId: "BLSTACCTQZ7K",
    statementAccountNumber: "STMT00000061",
    transferringContra: "Schwab",
    dtccNumber: "0061",
    statementAmount: 5467768,
    acatDate: "2026-06-30",
    lastUpdated: "2026-07-01T00:00:00Z",
    createdAt: new Date("2026-06-30T00:00:00Z"),
    deletedAt: null,
    assets: [
      { id: "A1", symbol: "AAPL", description: "Apple", cusip: "037833100", expectedQty: 100, actualQty: 98, mapStatus: "Mapped", issue: null, amount: 1, assetClass: "Equity", notes: "x" },
      { id: "A2", symbol: "TSLA", description: "Tesla", cusip: "88160R101", expectedQty: 5, actualQty: 0, mapStatus: "Unmapped", issue: "missing", amount: 1, assetClass: "Equity", notes: "y" },
    ],
    ...overrides,
  };
}

function ticket(payload: Record<string, unknown> | undefined) {
  return { getPayload: () => payload };
}

function makeRequest(authHeader?: string, url = "http://localhost/api/machine/acats") {
  return new Request(url, {
    headers: authHeader ? { authorization: authHeader } : {},
  }) as Parameters<typeof GET>[0];
}

function allowGoodToken(email = ALLOWED_SA) {
  mockVerifyIdToken.mockResolvedValue(
    ticket({ email, email_verified: true })
  );
}

function mockRecords(records: unknown[]) {
  (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(records);
}

beforeEach(() => {
  vi.clearAllMocks();
  (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true, remaining: 59 });
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  seq = 0;
});

describe("GET /api/machine/acats (list) — OIDC gate", () => {
  it("returns 401 for a missing Authorization header (no Prisma query)", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 401 for a garbage Authorization header", async () => {
    const res = await GET(makeRequest("Token nope"));
    expect(res.status).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 401 when the token audience is rejected (verifyIdToken throws)", async () => {
    mockVerifyIdToken.mockRejectedValue(
      new Error("Wrong recipient - payload audience != requiredAudience")
    );
    const res = await GET(makeRequest("Bearer wrong.aud"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 401 when the caller email is not in the allowlist (wrong SA)", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticket({ email: "attacker@evil.iam.gserviceaccount.com", email_verified: true })
    );
    const res = await GET(makeRequest("Bearer good.sig.wrong.sa"));
    expect(res.status).toBe(401);
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 401 when email_verified is false", async () => {
    mockVerifyIdToken.mockResolvedValue(
      ticket({ email: ALLOWED_SA, email_verified: false })
    );
    const res = await GET(makeRequest("Bearer unverified"));
    expect(res.status).toBe(401);
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    allowGoodToken();
    (rateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false, remaining: 0 });
    const res = await GET(makeRequest("Bearer good"));
    expect(res.status).toBe(429);
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/machine/acats (list) — query scope", () => {
  it("loads LIVE + Rejected unbounded and Completed only within the recency window; excludes soft-deleted; never loads Canceled/Purged", async () => {
    allowGoodToken();
    mockRecords([]);
    await GET(makeRequest("Bearer good"));

    const arg = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.include).toEqual({ assets: true });

    // Two OR clauses: unbounded {LIVE + Rejected}, and bounded Completed.
    const clauses = arg.where.OR as Array<Record<string, unknown>>;
    const unbounded = clauses.find((c) => c.status && (c.status as { in?: unknown[] }).in);
    const completedClause = clauses.find((c) => c.status === "Completed");

    const loaded = new Set((unbounded!.status as { in: string[] }).in);
    // AcatReceived (schema default) and every other non-terminal live status.
    expect(loaded.has("AcatReceived")).toBe(true);
    expect(loaded.has("Submitted")).toBe(true);
    expect(loaded.has("PendingBookkeeping")).toBe(true);
    expect(loaded.has("Rejected")).toBe(true);
    // Never load the dead-ends, and never load Completed unbounded.
    expect(loaded.has("Canceled")).toBe(false);
    expect(loaded.has("Purged")).toBe(false);
    expect(loaded.has("Completed")).toBe(false);
    expect(loaded.has("WaitingForStatement")).toBe(true);
    expect(loaded.size).toBe(17); // 16 LIVE + Rejected

    // Completed is bounded by a createdAt >= (now - window) filter.
    expect(completedClause).toBeDefined();
    const gte = (completedClause!.createdAt as { gte: Date }).gte;
    expect(gte).toBeInstanceOf(Date);
    const days = (Date.now() - gte.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });
});

async function listFor(records: unknown[], email = ALLOWED_SA) {
  allowGoodToken(email);
  mockRecords(records);
  const res = await GET(makeRequest("Bearer good"));
  expect(res.status).toBe(200);
  const data = await res.json();
  return data.acats as Array<Record<string, unknown>>;
}

async function listForUrl(records: unknown[], url: string) {
  allowGoodToken();
  mockRecords(records);
  const res = await GET(makeRequest("Bearer good", url));
  expect(res.status).toBe(200);
  const data = await res.json();
  return data.acats as Array<Record<string, unknown>>;
}

describe("GET /api/machine/acats (list) — suppression rule", () => {
  it("(a) Rejected + a LATER Completed in the same group → Rejected omitted", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", acatTransferId: "T-REJ", lastUpdated: "2026-06-01T00:00:00Z" }),
      row({ id: "DONE", status: "Completed", acatTransferId: "T-DONE", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    // Completed never returned; Rejected suppressed by the LATER Completed.
    expect(acats).toHaveLength(0);
  });

  it("(b) Rejected + a LATER in-flight (Accepted) in the same group → Rejected omitted", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", acatTransferId: "T-REJ", lastUpdated: "2026-06-01T00:00:00Z" }),
      row({ id: "LIVE", status: "Accepted", acatTransferId: "T-LIVE", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["LIVE"]);
  });

  it("(c) a lone Rejected (no live/completed sibling) → returned", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", acatTransferId: "T-REJ" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });

  it("(d) grouping is by statement#+apex#(+client): a Completed on a DIFFERENT account does not suppress an unrelated Rejected", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", statementAccountNumber: "STMT-AAA", apexAccountId: "APEX-AAA" }),
      row({ id: "DONE", status: "Completed", statementAccountNumber: "STMT-BBB", apexAccountId: "APEX-BBB" }),
    ]);
    // Different account groups: the Rejected survives, the Completed is not returned.
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });

  it("(d2) same account-number pair but different client is a different group", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", clientName: "Client A" }),
      row({ id: "DONE", status: "Completed", clientName: "Client B" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });
});

describe("GET /api/machine/acats (list) — TEMPORAL suppression (H1)", () => {
  it("an EARLIER Completed does NOT bury a LATER genuine Rejection → Rejected RETURNED", async () => {
    const acats = await listFor([
      row({ id: "DONE", status: "Completed", acatTransferId: "T-OLD", lastUpdated: "2026-01-01T00:00:00Z" }),
      row({ id: "REJ", status: "Rejected", acatTransferId: "T-NEW", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    // Completed is older than the Rejected, so it must not suppress it.
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });

  it("a LATER Completed DOES suppress an earlier Rejection (inverse)", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", acatTransferId: "T-OLD", lastUpdated: "2026-01-01T00:00:00Z" }),
      row({ id: "DONE", status: "Completed", acatTransferId: "T-NEW", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    expect(acats).toHaveLength(0);
  });

  it("equal timestamps fall back to createdAt: an earlier-created Completed does not suppress a later-created Rejected", async () => {
    const acats = await listFor([
      row({ id: "DONE", status: "Completed", acatTransferId: "T-OLD", lastUpdated: "", createdAt: new Date("2026-01-01T00:00:00Z") }),
      row({ id: "REJ", status: "Rejected", acatTransferId: "T-NEW", lastUpdated: "", createdAt: new Date("2026-07-01T00:00:00Z") }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });
});

describe("GET /api/machine/acats (list) — non-successors & new records", () => {
  it("Canceled does NOT suppress a Rejected in the same group → Rejected shown", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", lastUpdated: "2026-06-01T00:00:00Z" }),
      // Even though it is LATER, Canceled is not a suppressing successor.
      row({ id: "CAN", status: "Canceled", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });

  it("Purged does NOT suppress a Rejected in the same group → Rejected shown", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", lastUpdated: "2026-06-01T00:00:00Z" }),
      row({ id: "PUR", status: "Purged", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });

  it("a lone AcatReceived (schema default) record is returned — brand-new records appear in the lane", async () => {
    const acats = await listFor([row({ id: "NEW", status: "AcatReceived" })]);
    expect(acats.map((a) => a.id)).toEqual(["NEW"]);
  });
});

describe("GET /api/machine/acats (list) — group-key collision (L4)", () => {
  it("a literal '|' in a field does not merge two distinct account groups", async () => {
    // Without an un-collidable key, ["A|","B",...] and ["A","|B",...] would
    // both join to "A||B|..." and merge. A later Completed in group X must not
    // reach a Rejected that only exists in group Y.
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", statementAccountNumber: "A|", apexAccountId: "B", lastUpdated: "2026-06-01T00:00:00Z" }),
      row({ id: "DONE", status: "Completed", statementAccountNumber: "A", apexAccountId: "|B", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    // Distinct groups: the Rejected survives (Completed never shown).
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });

  it("null statementAccountNumber is distinct from the literal string 'null'", async () => {
    const acats = await listFor([
      row({ id: "REJ", status: "Rejected", statementAccountNumber: null, apexAccountId: "X", lastUpdated: "2026-06-01T00:00:00Z" }),
      row({ id: "DONE", status: "Completed", statementAccountNumber: "null", apexAccountId: "X", lastUpdated: "2026-07-01T00:00:00Z" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["REJ"]);
  });
});

describe("GET /api/machine/acats (list) — output filtering", () => {
  it("excludes Completed, Canceled, Purged from output (only live in-flight + surviving Rejected remain)", async () => {
    const acats = await listFor([
      row({ id: "SUB", status: "Submitted", statementAccountNumber: "S1", apexAccountId: "A1" }),
      row({ id: "DONE", status: "Completed", statementAccountNumber: "S2", apexAccountId: "A2" }),
      // Canceled/Purged shouldn't be loaded, but even if present they aren't returned.
      row({ id: "CAN", status: "Canceled", statementAccountNumber: "S3", apexAccountId: "A3" }),
      row({ id: "PUR", status: "Purged", statementAccountNumber: "S4", apexAccountId: "A4" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["SUB"]);
  });
});

describe("GET /api/machine/acats (list) — projection", () => {
  it.each([ALLOWED_SA, "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com"])("keeps clientName, masks identifiers and omits private notes for %s", async (email) => {
    const acats = await listFor([row({ id: "R1", status: "Submitted" })], email);
    expect(acats).toHaveLength(1);
    const item = acats[0];

    // clientName KEPT (lane displays it).
    expect(item.clientName).toBe("Sarah Jenkins");

    // Account identifiers masked (last-4 style), never raw.
    expect(item.apexAccountId).toBe("********QZ7K");
    expect(item.statementAccountNumber).toBe("********0061");
    expect(item.dtccNumber).toBe("****");

    // PII omitted.
    expect(item).not.toHaveProperty("wealthAdvisor");
    expect(item).not.toHaveProperty("notes");
    expect(item).not.toHaveProperty("tradeInstructions");
    expect(item).not.toHaveProperty("custodianName");

    // Asset-map summary is COUNTS, not the full asset array.
    expect(item).not.toHaveProperty("assets");
    expect(item.assetMap).toEqual({ total: 2, mapped: 1, unmapped: 1, pending: 0, expected: 0 });

    // Last-activity timestamp echoed for re-sorting.
    expect(item.lastActivityAt).toBe("2026-07-01T00:00:00Z");
  });
});

describe("GET /api/machine/acats (list) — sort", () => {
  it("returns rows most-recent-first by last-activity (lastUpdated)", async () => {
    const acats = await listFor([
      row({ id: "OLD", status: "Submitted", lastUpdated: "2026-01-01T00:00:00Z", statementAccountNumber: "S1", apexAccountId: "A1" }),
      row({ id: "NEW", status: "Submitted", lastUpdated: "2026-07-10T00:00:00Z", statementAccountNumber: "S2", apexAccountId: "A2" }),
      row({ id: "MID", status: "Submitted", lastUpdated: "2026-04-01T00:00:00Z", statementAccountNumber: "S3", apexAccountId: "A3" }),
    ]);
    expect(acats.map((a) => a.id)).toEqual(["NEW", "MID", "OLD"]);
  });
});

describe("GET /api/machine/acats?book=full", () => {
  it("book=full returns every non-deleted transfer", async () => {
    markCase("machine-acat-book", "book=full returns every non-deleted transfer");
    const acats = await listForUrl(
      [
        row({ id: "SUB", status: "Submitted", statementAccountNumber: "S1", apexAccountId: "A1" }),
        row({ id: "DONE", status: "Completed", statementAccountNumber: "S2", apexAccountId: "A2" }),
        row({ id: "CAN", status: "Canceled", statementAccountNumber: "S3", apexAccountId: "A3" }),
        row({ id: "PUR", status: "Purged", statementAccountNumber: "S4", apexAccountId: "A4" }),
        row({ id: "REJ", status: "Rejected", statementAccountNumber: "S5", apexAccountId: "A5" }),
        row({ id: "DEF", status: "Deferred", statementAccountNumber: "S6", apexAccountId: "A6" }),
      ],
      "http://localhost/api/machine/acats?book=full",
    );
    expect(acats.map((a) => a.id)).toEqual(expect.arrayContaining(["SUB", "DONE", "CAN", "PUR", "REJ", "DEF"]));
    expect(acats).toHaveLength(6);
    const first = vi.mocked(prisma.acatRecord.findMany).mock.calls[0]?.[0];
    if (!first) throw new Error("findMany was not called");
    expect(first.where).toEqual({ deletedAt: null });
    expect(first.include).toEqual({ assets: true, clientLinks: acatClientLinksSelection, custodian: { select: { avgProcessingDays: true } } });
  });

  it("book=full does not suppress a Rejected that a later Completed would hide", async () => {
    markCase("machine-acat-book", "book=full does not suppress a Rejected that a later Completed would hide");
    const acats = await listForUrl(
      [
        row({ id: "REJ", status: "Rejected", acatTransferId: "T-REJ", lastUpdated: "2026-06-01T00:00:00Z" }),
        row({ id: "DONE", status: "Completed", acatTransferId: "T-DONE", lastUpdated: "2026-07-01T00:00:00Z" }),
      ],
      "http://localhost/api/machine/acats?book=full",
    );
    expect(acats.map((a) => a.id).sort()).toEqual(["DONE", "REJ"]);
  });

  it("book=full projects the book fields", async () => {
    markCase("machine-acat-book", "book=full projects the book fields");
    const unmapped = { id: "A", symbol: "X", description: "x", expectedQty: 10, actualQty: 0, mapStatus: "Unmapped" };
    const acats = await listForUrl(
      [
        row({
          id: "BLANK",
          status: "Submitted",
          wealthAdvisor: "Dana Advisor",
          crmDealId: "DEAL-1",
          type: "Full",
          tradeInstructions: "  ",
          feeCharged: "Yes",
          feeRequestCompleted: "",
          assets: [unmapped],
          statementAccountNumber: "S1",
          apexAccountId: "A1",
        }),
        row({
          id: "DEAD",
          status: "Rejected",
          assets: [unmapped],
          statementAccountNumber: "S2",
          apexAccountId: "A2",
        }),
        row({
          id: "SURPLUS",
          status: "Submitted",
          assets: [{ id: "B", symbol: "Y", description: "y", expectedQty: 100, actualQty: 112, mapStatus: "Mapped" }],
          statementAccountNumber: "S3",
          apexAccountId: "A3",
        }),
        row({
          id: "WORDS",
          status: "Submitted",
          notes: "call the client",
          tradeInstructions: "sell winners",
          custodianName: "Fidelity",
          assets: [],
          statementAccountNumber: "S4",
          apexAccountId: "A4",
        }),
      ],
      "http://localhost/api/machine/acats?book=full",
    );
    const byId = Object.fromEntries(acats.map((row) => [row.id, row]));
    expect(byId.BLANK.wealthAdvisor).toBe("Dana Advisor");
    expect(byId.BLANK.crmDealId).toBe("DEAL-1");
    expect(byId.BLANK.type).toBe("Full");
    expect(byId.BLANK.tradeInstructionsBlank).toBe(true);
    expect(byId.BLANK.feeCharged).toBe("Yes");
    expect(byId.BLANK.feeRequestCompleted).toBe("");
    expect(byId.BLANK.hasIssue).toBe(true);
    expect(byId.DEAD.hasIssue).toBe(false);
    expect(byId.SURPLUS.hasIssue).toBe(false);
    expect(byId.WORDS.tradeInstructionsBlank).toBe(false);
    expect(byId.WORDS.notes).toBe("call the client");
    expect(byId.WORDS.tradeInstructions).toBe("sell winners");
    expect(byId.WORDS.custodianName).toBe("Fidelity");
  });

  it("book=true keeps the in-flight list", async () => {
    markCase("machine-acat-book", "book=true keeps the in-flight list");
    const acats = await listForUrl(
      [
        row({ id: "SUB", status: "Submitted", statementAccountNumber: "S1", apexAccountId: "A1" }),
        row({ id: "DONE", status: "Completed", statementAccountNumber: "S2", apexAccountId: "A2" }),
        row({ id: "CAN", status: "Canceled", statementAccountNumber: "S3", apexAccountId: "A3" }),
        row({ id: "PUR", status: "Purged", statementAccountNumber: "S4", apexAccountId: "A4" }),
      ],
      "http://localhost/api/machine/acats?book=true",
    );
    expect(acats.map((a) => a.id)).toEqual(["SUB"]);
  });

  it("book=full&removed=only returns removed transfers newest removal first with removedAt", async () => {
    markCase("machine-acat-book", "book=full&removed=only returns removed transfers newest removal first with removedAt");
    const acats = await listForUrl(
      [
        row({ id: "GONE-NEW", status: "Submitted", deletedAt: new Date("2026-09-02T00:00:00Z"), statementAccountNumber: "S1", apexAccountId: "A1" }),
        row({ id: "GONE-OLD", status: "Completed", deletedAt: new Date("2026-09-01T00:00:00Z"), statementAccountNumber: "S2", apexAccountId: "A2" }),
      ],
      "http://localhost/api/machine/acats?book=full&removed=only",
    );
    expect(acats.map((a) => a.id)).toEqual(["GONE-NEW", "GONE-OLD"]);
    expect(acats[0].removedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(acats[0].wealthAdvisor).toBe("Dana Advisor");
    expect(acats[0].notes).toBe("internal only — do not leak");
    const first = vi.mocked(prisma.acatRecord.findMany).mock.calls[0]?.[0];
    if (!first) throw new Error("findMany was not called");
    expect(first.where).toEqual({ deletedAt: { not: null } });
    expect(first.orderBy).toEqual([{ deletedAt: "desc" }, { createdAt: "desc" }]);
    expect(first.include).toEqual({ assets: true, clientLinks: acatClientLinksSelection, custodian: { select: { avgProcessingDays: true } } });
  });

  it("book=full without removed keeps the live query and marks rows removedAt null", async () => {
    markCase("machine-acat-book", "book=full without removed keeps the live query and marks rows removedAt null");
    const acats = await listForUrl(
      [row({ id: "LIVE", status: "Submitted", statementAccountNumber: "S1", apexAccountId: "A1" })],
      "http://localhost/api/machine/acats?book=full",
    );
    expect(acats[0].removedAt).toBeNull();
    const first = vi.mocked(prisma.acatRecord.findMany).mock.calls[0]?.[0];
    expect(first?.where).toEqual({ deletedAt: null });
  });

  it("book=full with an unknown removed value is refused before any query", async () => {
    markCase("machine-acat-book", "book=full with an unknown removed value is refused before any query");
    allowGoodToken();
    mockRecords([]);
    const res = await GET(makeRequest("Bearer good", "http://localhost/api/machine/acats?book=full&removed=yes"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_removed" });
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("book=full findMany rejection returns internal_error and no acats", async () => {
    markCase("machine-acat-book", "book=full findMany rejection returns internal_error and no acats");
    allowGoodToken();
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const res = await GET(makeRequest("Bearer good", "http://localhost/api/machine/acats?book=full"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(body.acats).toBeUndefined();
  });

  it("removed=only without book=full leaves the in-flight list unchanged", async () => {
    markCase("machine-acat-book", "removed=only without book=full leaves the in-flight list unchanged");
    const acats = await listForUrl(
      [
        row({ id: "SUB", status: "Submitted", statementAccountNumber: "S1", apexAccountId: "A1" }),
        row({ id: "DONE", status: "Completed", statementAccountNumber: "S2", apexAccountId: "A2" }),
      ],
      "http://localhost/api/machine/acats?removed=only",
    );
    expect(acats.map((a) => a.id)).toEqual(["SUB"]);
    const first = vi.mocked(prisma.acatRecord.findMany).mock.calls[0]?.[0];
    expect(first?.where).toHaveProperty("deletedAt", null);
  });
});

describe("GET /api/machine/acats?book=full records columns", () => {
  it("book=full returns the records-list column values", async () => {
    vi.setSystemTime(new Date("2026-07-10T00:00:00Z"));
    try {
      const record = row({
        id: "COLS",
        status: "Submitted",
        clientLinks: [
          { cedarRidgeUserId: "u-b", client: { canonicalName: "Client B" } },
          { cedarRidgeUserId: "u-a", client: { canonicalName: "Client A" } },
        ],
        custodian: { avgProcessingDays: 5 },
        custodianId: "cust-1",
        transferWorkflow: "ACAT",
        methodRequested: "API",
        crwEe: "No",
        originalClientRequestDate: "2026-06-30",
        opsSubmissionDateToApex: "2026-07-01",
        apexCompletionDate: "2026-07-09",
        reconCompletedAt: "2026-07-05T12:00:00Z",
        residualMonitoringRequired: true,
        residualFollowUpDate: "2026-07-15",
        feeAmount: "150.00",
        feeMemo: "fee memo",
        feeRequestSubmitted: "2026-07-02",
        feeApexTicket: "FAT-1",
        feeCreditRequestId: "FCR-1",
        crmTicket: "PT-1",
        apexTicket: "AT-1",
        additionalResources: "link",
        tradeRequestId: "TR-1",
        tradeRequestUrl: "https://example.test/tr-1",
        mappingSource: "GCP Project API",
        apexSource: "Pending Upload",
      });
      const [projected] = await listForUrl([record], "http://localhost/api/machine/acats?book=full");
      const operational = toOperationalAcat(record as Parameters<typeof toOperationalAcat>[0]) as unknown as AcatRecord;
      for (const key of BOOK_RECORD_COLUMN_KEYS) {
        expect(projected, key).toHaveProperty(key);
        expect(projected[key], key).toEqual(RECORD_FIELDS_BY_KEY.get(key)!.value(operational));
      }
      expect(projected.cedarRidgeUserIds).toBe("u-a, u-b");
      expect(projected.cedarRidgeUserId).toBe("");
      expect(projected.needsClientLink).toBe(false);
      expect(projected.transferWorkflow).toBe("ACAT (API)");
      expect(projected.daysOpen).toBe(10);
      expect(projected.reconStatus).toBe("Complete");
      expect(projected.reconCompletedAt).toBe("2026-07-05");
      expect(projected.expectedCompletionDate).toBe("2026-07-06");
      expect(projected.issueCount).toBe(1);
      markCase("machine-acat-book", "book=full returns the records-list column values");
    } finally {
      vi.useRealTimers();
    }
  });

  it("book=full keeps empty records-list values empty", async () => {
    const [projected] = await listForUrl(
      [row({ id: "EMPTY", status: "Submitted", assets: [], custodian: null })],
      "http://localhost/api/machine/acats?book=full",
    );
    expect(projected.needsClientLink).toBe(true);
    expect(projected.cedarRidgeUserIds).toBe("");
    expect(projected.cedarRidgeUserId).toBe("");
    expect(projected.expectedCompletionDate).toBe("");
    expect(projected.issueCount).toBe(0);
    expect(projected.reconStatus).toBe("Pending");
    markCase("machine-acat-book", "book=full keeps empty records-list values empty");
  });

  it("in-flight list carries no records columns", async () => {
    const acats = await listForUrl(
      [row({ id: "SUB", status: "Submitted", custodian: { avgProcessingDays: 5 } })],
      "http://localhost/api/machine/acats",
    );
    expect(acats).toHaveLength(1);
    for (const key of BOOK_RECORD_COLUMN_KEYS) expect(acats[0], key).not.toHaveProperty(key);
    const first = vi.mocked(prisma.acatRecord.findMany).mock.calls[0]?.[0];
    expect(first?.include).toEqual({ assets: true });
    markCase("machine-acat-book", "in-flight list carries no records columns");
  });
});
