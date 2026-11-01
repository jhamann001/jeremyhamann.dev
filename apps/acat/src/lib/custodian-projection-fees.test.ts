import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import type { TransferSource } from "@/lib/transfer-preparation-service";

const resolveClientIdentities = vi.fn();
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/client-directory", () => ({
  lockDirectory: vi.fn().mockResolvedValue(undefined),
  resolveClientIdentities: (...args: unknown[]) => resolveClientIdentities(...args),
  replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 1 }),
}));

const { applyAcatCreate, applyAcatPatch } = await import("./acat-record-write");
const { buildPreparation } = await import("./transfer-preparation-service");
const { prisma } = await import("@/lib/prisma");

const CALLER = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const SELECTED = "user-11111111-1111-1111-1111-111111111111";
const TEMPLATE = "a".repeat(64);

const scheduleFee = {
  id: "fee-1",
  custodianId: "custodian-1",
  feeType: "ACAT",
  accountType: "ANY" as const,
  transferType: "ANY" as const,
  direction: "ANY" as const,
  amount: 80,
  amountText: null,
  notes: null,
  documentation: null,
};

function source(overrides: Partial<TransferSource> = {}): TransferSource {
  return {
    id: "record-1", deletedAt: null, clientName: "Synthetic Client", cedarRidgeUserId: null, identityVersion: 0, clientLinks: [],
    direction: "In", type: "Full account transfer", accountType: "IRA", status: "ToCome", transferWorkflow: "ACAT",
    apexAccountId: "SYN123456", statementAccountNumber: "SRC987654", transferringContra: "Synthetic Broker", dtccNumber: "9999",
    mappingSource: "test", mappingSyncedAt: null, mappingAccountId: null, mappingAccountSummary: null,
    verifiedApexAccountTitle: null, verifiedApexAccountTitleAt: null, verifiedApexAccountTitleBy: null,
    activeTransferTitleConfirmationId: null, activeTransferTitleConfirmation: null,
    transferTitleConfirmations: [],
    assets: [{ id: "position-1", symbol: "TEST", description: "Synthetic position", cusip: "123456789", expectedQty: 5,
      amount: 100, assetClass: "Equity", includeInTransfer: true }],
    custodian: { id: "custodian-1", name: "Synthetic Broker", reviewStatus: "VERIFIED", transferType: "ACAT_API",
      documentationStatus: "DOCUMENTED", dtcNumber: "9999", receivingAccountNumber: null, signature: "Required",
      letterOfAcceptance: "Required by custodian", medallionRequired: null, liquidationMethod: null,
      returnMethod: "Secure upload", watchouts: null, paperworkOnFile: true, projectionRevision: null },
    ...overrides,
  };
}

function createPayload() {
  const call = vi.mocked(prisma.acatRecord.create).mock.calls[0]?.[0] as { data: { feeAmount?: string; feeCharged?: string } } | undefined;
  return call?.data;
}

function updatePayload() {
  const call = vi.mocked(prisma.acatRecord.update).mock.calls[0]?.[0] as { data: { feeAmount?: string } } | undefined;
  return call?.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION;
  delete process.env.CLIENT_IDENTITY_ENABLED;
  resolveClientIdentities.mockResolvedValue({
    canonicalName: "Sarah",
    cedarRidgeUserIds: [SELECTED],
    snapshotId: "snap",
    freshnessBasis: "UPSTREAM_VERIFIED",
    evidenceDigest: "digest",
  });
  const row = { id: "NEW-1", identityVersion: 0, assets: [], status: "AcatReceived", apexAccountId: "APEX1" };
  vi.mocked(prisma.acatRecord.create).mockResolvedValue(row as never);
  vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue(row as never);
  vi.mocked(prisma.acatRecord.update).mockResolvedValue({ identityVersion: 0, assets: [], clientLinks: [] } as never);
  vi.mocked(prisma.custodian.findFirst).mockResolvedValue({ id: "custodian-1", name: "Synthetic Broker" } as never);
});

describe("custodian projection fees", () => {
  it("flag off create does not replace the request fee", async () => {
    markCase("custodian-projection-fees", "flag off create does not replace the request fee");
    const result = await applyAcatCreate({
      body: { cedarRidgeUserId: SELECTED, apexAccountId: "APEX1", transferringContra: "Synthetic Broker", feeAmount: "$10.00" },
      performedBy: CALLER,
    });
    expect(result.kind).toBe("record");
    expect(createPayload()?.feeAmount).toBe("$10.00");
    expect(prisma.custodian.findUnique).not.toHaveBeenCalled();
  });

  it("confirmed create writes the schedule fee", async () => {
    markCase("custodian-projection-fees", "confirmed create writes the schedule fee");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ projectionRevision: 1, fees: [scheduleFee] } as never);
    const result = await applyAcatCreate({
      body: { cedarRidgeUserId: SELECTED, apexAccountId: "APEX1", transferringContra: "Synthetic Broker" },
      performedBy: CALLER,
    });
    expect(result.kind).toBe("record");
    expect(createPayload()).toMatchObject({ feeAmount: "$80.00", feeCharged: "Yes" });
  });

  it("unconfirmed create leaves the request fee unchanged", async () => {
    markCase("custodian-projection-fees", "unconfirmed create leaves the request fee unchanged");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ projectionRevision: null, fees: [scheduleFee] } as never);
    const result = await applyAcatCreate({
      body: {
        cedarRidgeUserId: SELECTED, apexAccountId: "APEX1", transferringContra: "Synthetic Broker",
        feeAmount: "$10.00", feeCharged: "Yes",
      },
      performedBy: CALLER,
    });
    expect(result.kind).toBe("record");
    expect(createPayload()).toMatchObject({ feeAmount: "$10.00", feeCharged: "Yes" });
  });

  it("unconfirmed update leaves the stored fee unchanged", async () => {
    markCase("custodian-projection-fees", "unconfirmed update leaves the stored fee unchanged");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({
      id: "record-1", identityVersion: 0, clientLinks: [], assets: [], custodianId: "custodian-1",
      feeCharged: null, feeAmount: "$10.00", type: "Full", direction: "In", transferWorkflow: "ACAT",
      accountType: "IRA", status: "Completed", clientName: "Synthetic Client", apexAccountId: "APEX1",
    } as never);
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ projectionRevision: null, fees: [scheduleFee] } as never);
    const result = await applyAcatPatch({
      id: "record-1",
      body: { status: "Completed", feeAmount: "$10.00" },
      performedBy: CALLER,
    });
    expect(result.kind).toBe("record");
    expect(updatePayload()?.feeAmount ?? "$10.00").not.toBe("$80.00");
    expect([undefined, "$10.00"]).toContain(updatePayload()?.feeAmount);
  });

  it("confirmed update writes the schedule fee before completion", async () => {
    markCase("custodian-projection-fees", "confirmed update writes the schedule fee before completion");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue({
      id: "record-1", identityVersion: 0, clientLinks: [], assets: [], custodianId: "custodian-1",
      feeCharged: null, feeAmount: null, type: "Full", direction: "In", transferWorkflow: "ACAT",
      accountType: "IRA", status: "ToCome", clientName: "Synthetic Client", apexAccountId: "APEX1",
    } as never);
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue({ projectionRevision: 1, fees: [scheduleFee] } as never);
    const result = await applyAcatPatch({
      id: "record-1",
      body: { status: "ToCome", feeAmount: null },
      performedBy: CALLER,
    });
    expect(result.kind).toBe("record");
    expect(updatePayload()?.feeAmount).toBe("$80.00");
  });

  it("unconfirmed preparation keeps the current signature requirement", () => {
    markCase("custodian-projection-fees", "unconfirmed preparation keeps the current signature requirement");
    const off = buildPreparation(source(), TEMPLATE);
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    const on = buildPreparation(source(), TEMPLATE);
    expect(on.requirements).toEqual(off.requirements);
    expect(on.requirements).toContainEqual({ label: "Client signature", value: "Required" });
  });

  it("confirmed preparation emits the revised signature", () => {
    markCase("custodian-projection-fees", "confirmed preparation emits the revised signature");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    const record = source();
    if (!record.custodian) throw new Error("expected a custodian");
    record.custodian = { ...record.custodian, projectionRevision: 1, signature: "From revision" };
    const prepared = buildPreparation(record, TEMPLATE);
    expect(prepared.requirements).toContainEqual({ label: "Client signature", value: "From revision" });
  });
});
