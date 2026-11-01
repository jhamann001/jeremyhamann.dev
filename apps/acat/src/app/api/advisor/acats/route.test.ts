import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { GET } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const advisorSession = {
  user: { email: "advisor@example.com", role: "ADVISOR" },
};
const adminSession = {
  user: { email: "admin@example.com", role: "ADMIN" },
};
const opsUserSession = {
  user: { email: "user@example.com", role: "USER" },
};

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
  crmTicket: "CRM-T-1",
  apexTicket: "AX-T-1",
  tradeRequestUrl: "https://internal/secret",
  tradeRequestId: "TR-1",
  additionalResources: "https://crm.example/tasks/abc-123",
  rejectionReason: null,
  mappingSource: "GCP Project API",
  apexSource: "Pending Upload",
  reconCompletedAt: null,
  slackAlerted: false,
  crwEe: "No",
  methodRequested: "Full Docusign",
  statementAmount: 123456789,
  custodianId: "C1",
  custodianName: "Charles Schwab",
  custodian: {
    id: "C1",
    name: "Charles Schwab",
    acatFeeAmount: 50,
    requiresManualReview: false,
    avgProcessingDays: 6,
    contactEmail: "ops@schwab.example",
  },
  acatDate: "2026-04-01",
  lastUpdated: "2026-04-04T00:00:00Z",
  deletedAt: null,
  assets: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(advisorSession);
  (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    fullRecord,
  ]);
});

describe("GET /api/advisor/acats", () => {
  it("returns 403 for unauthenticated requests", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns 403 for USER role (ops, not advisor)", async () => {
    mockAuth.mockResolvedValue(opsUserSession);
    const res = await GET();
    expect(res.status).toBe(403);
    // Defense in depth: make sure we never even hit the DB for the wrong role.
    expect(prisma.acatRecord.findMany).not.toHaveBeenCalled();
  });

  it("allows ADVISOR sessions and returns redacted records", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    const r = data[0];
    expect(r.clientName).toBe("Sarah Jenkins");
    expect(r.status).toBe("Submitted");
    expect(r.additionalResources).toBe(
      "https://crm.example/tasks/abc-123"
    );
    expect(r.custodian).toMatchObject({
      name: "Charles Schwab",
      avgProcessingDays: 6,
    });
    // statementAmount (cents) is the whitelisted aggregate the advisor view shows.
    expect(r.statementAmount).toBe(123456789);
  });

  it("allows ADMIN sessions (so admins can QA the advisor surface)", async () => {
    mockAuth.mockResolvedValue(adminSession);
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("strips every sensitive field from the wire response", async () => {
    const res = await GET();
    const data = (await res.json()) as Array<Record<string, unknown>>;
    const r = data[0];

    // Account/ticket numbers
    expect(r.apexAccountId).toBeUndefined();
    expect(r.statementAccountNumber).toBeUndefined();
    expect(r.controlNumber).toBeUndefined();
    expect(r.dtccNumber).toBeUndefined();
    expect(r.crmDealId).toBeUndefined();
    expect(r.crmTicket).toBeUndefined();
    expect(r.apexTicket).toBeUndefined();
    expect(r.tradeRequestId).toBeUndefined();
    expect(r.tradeRequestUrl).toBeUndefined();
    // Fees / internal notes
    expect(r.feeAmount).toBeUndefined();
    expect(r.feeMemo).toBeUndefined();
    expect(r.notes).toBeUndefined();
    expect(r.crwEe).toBeUndefined();
    expect(r.methodRequested).toBeUndefined();
    expect(r.rejectionReason).toBeUndefined();
    // Recon/audit internals
    expect(r.mappingSource).toBeUndefined();
    expect(r.apexSource).toBeUndefined();
    expect(r.reconCompletedAt).toBeUndefined();
    expect(r.slackAlerted).toBeUndefined();
    expect(r.lastUpdated).toBeUndefined();
    expect(r.deletedAt).toBeUndefined();
    // Custodian internals
    const c = r.custodian as Record<string, unknown> | null;
    expect(c?.fees).toBeUndefined();
    expect(c?.contactEmail).toBeUndefined();
    expect(c?.acatFeeAmount).toBeUndefined();
    expect(c?.requiresManualReview).toBeUndefined();
    // Assets are never exposed.
    expect(r.assets).toBeUndefined();
  });

  it("excludes soft-deleted records by passing deletedAt: null", async () => {
    await GET();
    const args = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(args.where).toEqual({ deletedAt: null });
  });

  it("eager-loads the custodian relation", async () => {
    await GET();
    const args = (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(args.include).toEqual({ custodian: true });
  });

  it("returns custodian=null when avgProcessingDays is missing", async () => {
    (prisma.acatRecord.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...fullRecord,
        custodian: { id: "C1", name: "New Custodian" },
      },
    ]);
    const res = await GET();
    const data = (await res.json()) as Array<Record<string, unknown>>;
    expect(data[0].custodian).toBeNull();
  });
});
