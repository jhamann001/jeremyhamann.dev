import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import { redactAcatForMachine, redactAcatForMachineList } from "@/lib/mcp/redaction";

const mockVerifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class MockOAuth2Client {
    verifyIdToken = mockVerifyIdToken;
  },
}));

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

vi.mock("@/lib/client-directory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-directory")>();
  return {
    ...actual,
    lockDirectory: vi.fn().mockResolvedValue(undefined),
    resolveClientIdentities: vi.fn().mockResolvedValue({
      canonicalName: "Sarah",
      cedarRidgeUserIds: ["user-11111111-1111-1111-1111-111111111111"],
      snapshotId: "snap",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest",
    }),
    replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 1 }),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./by-record/[id]/route");
const { prisma } = await import("@/lib/prisma");

const ALLOWED_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";

function ticket(payload: Record<string, unknown> | undefined) {
  return { getPayload: () => payload };
}

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "REC-1",
    clientName: "Ada",
    wealthAdvisor: "",
    crmDealId: "",
    tradeInstructions: "",
    controlNumber: "CTRL-1",
    acatTransferId: "TR-1",
    direction: "In",
    type: "Full",
    accountType: "Individual",
    status: "AcatReceived",
    apexAccountId: "BLSTACCTQZ7K",
    statementAccountNumber: null,
    transferringContra: null,
    dtccNumber: null,
    statementAmount: null,
    acatDate: "2026-07-01",
    lastUpdated: "2026-07-01T00:00:00Z",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    deletedAt: null,
    identityVersion: 0,
    clientLinks: [],
    assets: [],
    feeCharged: "",
    feeAmount: null,
    feeMemo: null,
    feeRequestSubmitted: null,
    feeRequestCompleted: "",
    methodRequested: null,
    residualMonitoringRequired: false,
    residualFollowUpDate: null,
    transferWorkflow: "UNCLASSIFIED",
    mappingAccountId: null,
    mappingSource: "GCP Project API",
    apexSource: "Pending Upload",
    reconCompletedAt: null,
    custodianId: null,
    notes: null,
    ...overrides,
  };
}

function allowGoodToken() {
  mockVerifyIdToken.mockResolvedValue(
    ticket({ email: ALLOWED_SA, email_verified: true })
  );
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/machine/acats/by-record/REC-1", {
    method: "PATCH",
    headers: { authorization: "Bearer good" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  allowGoodToken();
  vi.mocked(prisma.$transaction).mockImplementation(((args: unknown[] | ((tx: unknown) => unknown)) =>
    typeof args === "function" ? args(prisma) : Promise.all(args as Promise<unknown>[])) as never);
});

describe("machine ACAT writes", () => {
  it("saves a lifecycle status onto the next list row", async () => {
    markCase("machine-acat-writes", "saves a lifecycle status onto the next list row");
    const existing = existingRow();
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockResolvedValue(existingRow({ status: "WaitingOnClient" }) as never);

    const res = await PATCH(patchRequest({ status: "WaitingOnClient" }), {
      params: Promise.resolve({ id: "REC-1" }),
    });
    expect(res.status).toBe(200);
    const first = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0];
    if (!first) throw new Error("update was not called");
    const updateData = first.data as { status: string };
    expect(updateData.status).toBe("WaitingOnClient");
    const updated = existingRow({ status: "WaitingOnClient", lastUpdated: "2026-07-02T00:00:00Z" });
    expect(redactAcatForMachineList(updated).status).toBe("WaitingOnClient");
  });

  it("saves feeCharged onto the next by-record projection", async () => {
    markCase("machine-acat-writes", "saves feeCharged onto the next by-record projection");
    const existing = existingRow();
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockResolvedValue(existingRow({ feeCharged: "Yes" }) as never);

    const res = await PATCH(patchRequest({ feeCharged: "Yes" }), {
      params: Promise.resolve({ id: "REC-1" }),
    });
    expect(res.status).toBe(200);
    const first = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0];
    if (!first) throw new Error("update was not called");
    const updateData = first.data as { feeCharged: string };
    expect(updateData.feeCharged).toBe("Yes");
    const body = await res.json();
    expect(body.feeCharged).toBe("Yes");
    expect(redactAcatForMachine(existingRow({ feeCharged: "Yes" })).feeCharged).toBe("Yes");
  });

  it("persists wealthAdvisor, crmDealId, and tradeInstructions under the book contract names", async () => {
    markCase(
      "machine-acat-writes",
      "persists wealthAdvisor, crmDealId, and tradeInstructions under the book contract names",
    );
    const existing = existingRow();
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockResolvedValue(existingRow() as never);

    const res = await PATCH(
      patchRequest({
        wealthAdvisor: "Dana Advisor",
        crmDealId: "DEAL-1",
        tradeInstructions: "sell winners",
      }),
      { params: Promise.resolve({ id: "REC-1" }) },
    );
    expect(res.status).toBe(200);
    const first = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0];
    if (!first) throw new Error("update was not called");
    const updateData = first.data as Record<string, unknown>;
    expect(updateData.wealthAdvisor).toBe("Dana Advisor");
    expect(updateData.crmDealId).toBe("DEAL-1");
    expect(updateData.tradeInstructions).toBe("sell winners");
  });

  it("rejects Matched and leaves the row unchanged", async () => {
    markCase("machine-acat-writes", "rejects Matched and leaves the row unchanged");
    for (const status of ["Matched", "Mismatch", "Pending"]) {
      const res = await PATCH(patchRequest({ status }), {
        params: Promise.resolve({ id: "REC-1" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Status is not a lifecycle status" });
      expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    }
  });

  it("rejects an asset payload", async () => {
    markCase("machine-acat-writes", "rejects an asset payload");
    const res = await PATCH(
      patchRequest({ assets: [{ id: "A1", mapStatus: "Mapped" }] }),
      { params: Promise.resolve({ id: "REC-1" }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Field is not accepted on this path" });
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("creates a transfer the in-flight list can load", async () => {
    markCase("machine-acat-writes", "creates a transfer the in-flight list can load");
    const created = existingRow({ id: "NEW-1" });
    vi.mocked(prisma.acatRecord.create).mockResolvedValue(created as never);
    vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue(created as never);

    const res = await POST(
      new Request("http://localhost/api/machine/acats", {
        method: "POST",
        headers: { authorization: "Bearer good" },
        body: JSON.stringify({
          cedarRidgeUserId: "user-11111111-1111-1111-1111-111111111111",
          clientName: "Ada",
          apexAccountId: "BLSTACCTQZ7K",
          direction: "In",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const first = vi.mocked(prisma.acatRecord.create).mock.calls[0]?.[0];
    if (!first) throw new Error("create was not called");
    const createData = first.data as Record<string, unknown>;
    expect(createData.status).toBe("AcatReceived");
    expect(Object.hasOwn(createData, "deletedAt")).toBe(false);
    const body = await res.json();
    expect(body.apexAccountId).toBe("********QZ7K");
  });
});
