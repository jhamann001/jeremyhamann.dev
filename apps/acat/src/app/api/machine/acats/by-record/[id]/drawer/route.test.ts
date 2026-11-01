import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

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
      canonicalName: "Sarah Selected",
      cedarRidgeUserIds: ["user-22222222-2222-2222-2222-222222222222"],
      snapshotId: "snap",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest",
    }),
    replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 6 }),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockRateLimit = vi.fn();
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

const { PATCH, DELETE } = await import("./route");
const { prisma } = await import("@/lib/prisma");

const PROD_SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const EPIC = "EPIC_ACAT_TRANSFER_DRAWER";
const ROLLOUT = "ROLLOUT_ACAT_TRANSFER_DRAWER";
const ID = "REC-1";
const LINKED_USER = "user-11111111-1111-1111-1111-111111111111";

type Row = Record<string, unknown> & { deletedAt: Date | null };
let row: Row;

function baseRow(overrides: Record<string, unknown> = {}): Row {
  return {
    id: ID,
    clientName: "Ada Lovelace",
    wealthAdvisor: "Dana Advisor",
    crmDealId: "",
    tradeInstructions: "",
    controlNumber: "CTRL-1",
    acatTransferId: "TR-1",
    direction: "In",
    type: "Full",
    accountType: "Individual",
    status: "AcatReceived",
    apexAccountId: "BLSTACCTQZ7K",
    statementAccountNumber: "STMT00000061",
    transferringContra: "Schwab",
    dtccNumber: "0061",
    statementAmount: 5000,
    acatDate: "2026-07-01",
    lastUpdated: "2026-07-01T00:00:00Z",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    deletedAt: null,
    identityVersion: 5,
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
    apexCompletionDate: null,
    rejectionReason: null,
    ...overrides,
  };
}

function linkedRow() {
  return baseRow({ clientLinks: [{ cedarRidgeUserId: LINKED_USER, client: { canonicalName: "Ada Lovelace" } }] });
}

function ticket(email: string) {
  return { getPayload: () => ({ email, email_verified: true }) };
}

function request(method: "PATCH" | "DELETE", body?: unknown, raw?: string) {
  return new Request(`http://localhost/api/machine/acats/by-record/${ID}/drawer`, {
    method,
    headers: { authorization: "Bearer good" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const params = () => ({ params: Promise.resolve({ id: ID }) });

function change(field: string, value: unknown, extra: Record<string, unknown> = {}) {
  return { action: "change", field, value, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[EPIC] = "1";
  process.env[ROLLOUT] = "1";
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  mockVerifyIdToken.mockResolvedValue(ticket(PROD_SA));
  mockRateLimit.mockResolvedValue({ allowed: true, remaining: 59 });
  row = baseRow();
  vi.mocked(prisma.$transaction).mockImplementation(((arg: (tx: unknown) => unknown) => arg(prisma)) as never);
  vi.mocked(prisma.acatRecord.findUnique).mockImplementation((async (args: { where: { deletedAt?: null } }) =>
    args.where.deletedAt === null && row.deletedAt !== null ? null : { ...row }) as never);
  vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockImplementation((async () => ({ ...row })) as never);
  vi.mocked(prisma.acatRecord.update).mockImplementation((async (args: { data: Record<string, unknown> }) => {
    row = { ...row, ...args.data } as Row;
    return { ...row };
  }) as never);
});

afterEach(() => {
  delete process.env[EPIC];
  delete process.env[ROLLOUT];
});

describe("transfer drawer writes", () => {
  it("drawer: off returns 404 before auth or database", async () => {
    markCase("machine-drawer", "off returns 404 before auth or database");
    delete process.env[ROLLOUT];
    for (const res of [await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params()), await DELETE(request("DELETE", { reason: "Duplicate" }), params())]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("drawer: unauthorized returns 401 with no transfer", async () => {
    markCase("machine-drawer", "unauthorized returns 401 with no transfer");
    mockVerifyIdToken.mockRejectedValue(new Error("bad token"));
    const res = await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("drawer: dev identity is rejected on PATCH even when allow-listed", async () => {
    markCase("machine-drawer", "dev identity is rejected on PATCH even when allow-listed");
    process.env.MACHINE_AUTH_ALLOWED_SAS = `${PROD_SA},${DEV_SA}`;
    mockVerifyIdToken.mockResolvedValue(ticket(DEV_SA));
    const res = await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });

  it("drawer: dev identity is rejected on DELETE even when allow-listed", async () => {
    markCase("machine-drawer", "dev identity is rejected on DELETE even when allow-listed");
    process.env.MACHINE_AUTH_ALLOWED_SAS = `${PROD_SA},${DEV_SA}`;
    mockVerifyIdToken.mockResolvedValue(ticket(DEV_SA));
    const res = await DELETE(request("DELETE", { reason: "Duplicate entry" }), params());
    expect(res.status).toBe(401);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("drawer: one named field returns the stored value under transfer", async () => {
    markCase("machine-drawer", "one named field returns the stored value under transfer");
    const res = await PATCH(request("PATCH", change("wealthAdvisor", " Pat Advisor ")), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transfer.wealthAdvisor).toBe("Pat Advisor");
    expect(body.transfer.dtccNumber).toBe("0061");
    expect(body.transfer.identityVersion).toBe(5);
    expect(body.transfer.apexAccountId).toBe("********QZ7K");
    const data = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data.wealthAdvisor).toBe("Pat Advisor");
    expect(data).not.toHaveProperty("status");
  });

  it("drawer: linked transfer id change is refused without the identity version", async () => {
    markCase("machine-drawer", "linked transfer id change is refused without the identity version");
    row = linkedRow();
    const res = await PATCH(request("PATCH", change("acatTransferId", "TR-9")), params());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("IDENTITY_CONFLICT");
    expect(body.transfer.acatTransferId).toBe("TR-1");
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: linked transfer id change is accepted with the current identity version", async () => {
    markCase("machine-drawer", "linked transfer id change is accepted with the current identity version");
    row = linkedRow();
    const res = await PATCH(request("PATCH", change("acatTransferId", "TR-9", { expectedIdentityVersion: 5 })), params());
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.acatTransferId).toBe("TR-9");
  });

  it("drawer: unsupported field returns the unchanged transfer", async () => {
    markCase("machine-drawer", "unsupported field returns the unchanged transfer");
    for (const field of ["status", "notes", "feeAmount"]) {
      const res = await PATCH(request("PATCH", change(field, "x")), params());
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toEqual(expect.any(String));
      expect(body.transfer.status).toBe("AcatReceived");
      expect(body.transfer.wealthAdvisor).toBe("Dana Advisor");
    }
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: multiple changes return the unchanged transfer", async () => {
    markCase("machine-drawer", "multiple changes return the unchanged transfer");
    const res = await PATCH(request("PATCH", { action: "change", field: "wealthAdvisor", value: "Pat", changes: [{ field: "crwEe", value: "x" }] }), params());
    expect(res.status).toBe(400);
    expect((await res.json()).transfer.wealthAdvisor).toBe("Dana Advisor");
    const flat = await PATCH(request("PATCH", { wealthAdvisor: "Pat", crwEe: "x" }), params());
    expect(flat.status).toBe(400);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: blank value returns the unchanged transfer", async () => {
    markCase("machine-drawer", "blank value returns the unchanged transfer");
    const res = await PATCH(request("PATCH", change("wealthAdvisor", "   ")), params());
    expect(res.status).toBe(400);
    expect((await res.json()).transfer.wealthAdvisor).toBe("Dana Advisor");
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: complete without a date returns the unchanged transfer", async () => {
    markCase("machine-drawer", "complete without a date returns the unchanged transfer");
    for (const body of [{ action: "complete" }, { action: "complete", apexCompletionDate: "" }, { action: "complete", apexCompletionDate: "someday" }]) {
      const res = await PATCH(request("PATCH", body), params());
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.transfer.status).toBe("AcatReceived");
      expect(json.transfer.apexCompletionDate).toBeNull();
    }
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: complete stores the date, optional control number, and returned fee fields", async () => {
    markCase("machine-drawer", "complete stores the date, optional control number, and returned fee fields");
    row = baseRow({ feeCharged: "Yes", feeAmount: "$75.00" });
    const res = await PATCH(request("PATCH", { action: "complete", apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" }), params());
    expect(res.status).toBe(200);
    const { transfer } = await res.json();
    expect(transfer.status).toBe("Completed");
    expect(transfer.apexCompletionDate).toBe("2026-10-12");
    expect(transfer.controlNumber).toBe("CTRL-9");
    expect(transfer.feeAmount).toBe("$75.00");
    expect(transfer.feeCharged).toBe("Yes");
    const data = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ status: "Completed", apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" });
    vi.mocked(prisma.acatRecord.update).mockClear();
    row = baseRow();
    const noControl = await PATCH(request("PATCH", { action: "complete", apexCompletionDate: "2026-10-12" }), params());
    expect(noControl.status).toBe(200);
    expect((await noControl.json()).transfer.controlNumber).toBe("CTRL-1");
    expect(vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0].data).not.toHaveProperty("controlNumber");
  });

  it("drawer: reject with a blank reason returns the unchanged transfer", async () => {
    markCase("machine-drawer", "reject with a blank reason returns the unchanged transfer");
    for (const body of [{ action: "reject", reason: "   " }, { action: "reject" }]) {
      const res = await PATCH(request("PATCH", body), params());
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.transfer.status).toBe("AcatReceived");
      expect(json.transfer.rejectionReason).toBeNull();
    }
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: reject stores status and reason together", async () => {
    markCase("machine-drawer", "reject stores status and reason together");
    const res = await PATCH(request("PATCH", { action: "reject", reason: " Wrong custodian " }), params());
    expect(res.status).toBe(200);
    const { transfer } = await res.json();
    expect(transfer.status).toBe("Rejected");
    expect(transfer.rejectionReason).toBe("Wrong custodian");
    const data = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ status: "Rejected", rejectionReason: "Wrong custodian" });
  });

  const relink = (overrides: Record<string, unknown> = {}) => ({
    action: "replaceClient",
    relink: {
      cedarRidgeUserId: "user-22222222-2222-2222-2222-222222222222",
      expectedIdentityVersion: 5,
      reason: "Wrong person linked",
      replaceDisplayName: true,
      ...overrides,
    },
  });

  it("drawer: replaceClient returns the stored selected name", async () => {
    markCase("machine-drawer", "replaceClient returns the stored selected name");
    row = linkedRow();
    vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockImplementation((async () => ({ ...row, clientName: "Sarah Selected", identityVersion: 6 })) as never);
    const res = await PATCH(request("PATCH", relink()), params());
    expect(res.status).toBe(200);
    const { transfer } = await res.json();
    expect(transfer.clientName).toBe("Sarah Selected");
    expect(transfer.identityVersion).toBe(6);
    expect(vi.mocked(prisma.auditLog.createMany).mock.calls[0]?.[0]?.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "identity-relink", performedBy: PROD_SA })]),
    );
  });

  it("drawer: replaceClient identity conflict returns the unchanged transfer", async () => {
    markCase("machine-drawer", "replaceClient identity conflict returns the unchanged transfer");
    row = linkedRow();
    const res = await PATCH(request("PATCH", relink({ expectedIdentityVersion: 4 })), params());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("IDENTITY_CONFLICT");
    expect(body.transfer.clientName).toBe("Ada Lovelace");
    expect(body.transfer.identityVersion).toBe(5);
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it("drawer: delete returns the removed transfer and logs the service account", async () => {
    markCase("machine-drawer", "delete returns the removed transfer and logs the service account");
    const res = await DELETE(request("DELETE", { reason: "  Duplicate entry " }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
    expect(body.transfer.id).toBe(ID);
    expect(vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0]).toMatchObject({ where: { id: ID }, data: { deletedAt: expect.any(Date) } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: { acatRecordId: ID, action: "DELETE", newValue: "Duplicate entry", performedBy: PROD_SA },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  it("drawer: delete with a blank, short, or long reason is refused with the unchanged transfer", async () => {
    markCase("machine-drawer", "delete with a blank, short, or long reason is refused with the unchanged transfer");
    for (const body of [{ reason: "   " }, { reason: "ab" }, { reason: "x".repeat(501) }, {}]) {
      const res = await DELETE(request("DELETE", body), params());
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.transfer.id).toBe(ID);
      expect(json).not.toHaveProperty("removed");
    }
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(row.deletedAt).toBeNull();
  });

  it("drawer: delete of a missing transfer is 404 without a transfer", async () => {
    markCase("machine-drawer", "delete of a missing transfer is 404 without a transfer");
    row = baseRow({ deletedAt: new Date("2026-07-02T00:00:00Z") });
    const res = await DELETE(request("DELETE", { reason: "Duplicate entry" }), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("drawer: malformed JSON returns 400 with the unchanged transfer", async () => {
    markCase("machine-drawer", "malformed JSON returns 400 with the unchanged transfer");
    for (const call of [() => PATCH(request("PATCH", undefined, "not json"), params()), () => DELETE(request("DELETE", undefined, "{"), params())]) {
      const res = await call();
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
      expect(body.transfer.id).toBe(ID);
    }
    expect(prisma.acatRecord.update).not.toHaveBeenCalled();
  });

  it("drawer: storage failure returns 500 with the unchanged transfer", async () => {
    markCase("machine-drawer", "storage failure returns 500 with the unchanged transfer");
    vi.mocked(prisma.acatRecord.update).mockRejectedValue(new Error("db down"));
    const patch = await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params());
    expect(patch.status).toBe(500);
    const patchBody = await patch.json();
    expect(patchBody.error).toBe("internal_error");
    expect(patchBody.transfer.wealthAdvisor).toBe("Dana Advisor");
    const del = await DELETE(request("DELETE", { reason: "Duplicate entry" }), params());
    expect(del.status).toBe(500);
    expect((await del.json()).transfer.id).toBe(ID);
    vi.mocked(prisma.acatRecord.findUnique).mockRejectedValue(new Error("db down"));
    const both = await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params());
    expect(both.status).toBe(500);
    expect(await both.json()).toEqual({ error: "internal_error" });
  });

  it("drawer: missing transfer on PATCH is 404 without a transfer", async () => {
    markCase("machine-drawer", "missing transfer on PATCH is 404 without a transfer");
    row = baseRow({ deletedAt: new Date("2026-07-02T00:00:00Z") });
    const res = await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("drawer: rate limited returns 429 with no transfer", async () => {
    markCase("machine-drawer", "rate limited returns 429 with no transfer");
    mockRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const res = await PATCH(request("PATCH", change("wealthAdvisor", "Pat")), params());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(mockRateLimit).toHaveBeenCalledWith("machine-acat-write", PROD_SA, expect.objectContaining({ failClosed: true }));
    expect(prisma.acatRecord.findUnique).not.toHaveBeenCalled();
  });
});
