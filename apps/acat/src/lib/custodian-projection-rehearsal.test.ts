import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import type { CustodianFee } from "@/lib/types";

vi.mock("@/lib/prisma", async () => {
  const { prisma } = await import("@/lib/__mocks__/prisma");
  Object.assign(prisma.acatRecord, { findUniqueOrThrow: vi.fn() });
  return { prisma };
});

const { preparation } = vi.hoisted(() => {
  const preparation = {
    acatRecord: { findUnique: vi.fn() },
    acatDocument: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  preparation.$transaction.mockImplementation((fn: (tx: typeof preparation) => unknown) => fn(preparation));
  return { preparation };
});
vi.mock("@/lib/transfer-preparation-prisma", () => ({ transferPreparationPrisma: preparation }));

const { mockVerifyCaller, mockRateLimit, resolveClientIdentities } = vi.hoisted(() => ({
  mockVerifyCaller: vi.fn(),
  mockRateLimit: vi.fn(),
  resolveClientIdentities: vi.fn(),
}));
vi.mock("@/lib/machine-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/machine-auth")>()),
  verifyCustodianAdminCaller: (...args: unknown[]) => mockVerifyCaller(...args),
}));
vi.mock("@/lib/rate-limit-redis", () => ({
  rateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
vi.mock("@/lib/client-directory", () => ({
  lockDirectory: vi.fn().mockResolvedValue(undefined),
  resolveClientIdentities: (...args: unknown[]) => resolveClientIdentities(...args),
  replaceAcatRecordClients: vi.fn().mockResolvedValue({ identityVersion: 1 }),
}));
vi.mock("@/lib/custodian-timing-data", () => ({
  loadObservedCustodianTimings: vi.fn().mockResolvedValue(new Map()),
}));

const { prisma } = await import("@/lib/prisma");
const {
  applyCustodianProjection,
  authorizeCustodianAdmin,
  custodianEditBlockedResponse,
  custodianRevisionChecksum,
} = await import("@/lib/custodian-admin");
const { applyAcatCreate, applyAcatPatch } = await import("@/lib/acat-record-write");
const { getPreparation } = await import("@/lib/transfer-preparation-service");

const SUITE = "custodian-projection-rehearsal";
const ACTOR = "custodian-projection";
const ADMIN = "rehearsal-admin@example.test";
const CALLER = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const PROJECTION_ENV = "ENFORCE_CUSTODIAN_TRACKER_PROJECTION";
const SELECTED = "user-11111111-1111-1111-1111-111111111111";
const SOURCE = { id: "cust-rehearsal-source", name: "Synthetic Source Broker" };
const SURVIVOR = { id: "cust-rehearsal-survivor", name: "Synthetic Survivor Broker" };
const LINKED = [
  { id: "rec-rehearsal-1", transferringContra: "Synthetic Source Broker", custodianName: "Synthetic Source Broker" },
  { id: "rec-rehearsal-2", transferringContra: null, custodianName: "Synthetic Source Broker" },
  { id: "rec-rehearsal-3", transferringContra: "Synthetic Source Brkr", custodianName: "Synthetic Source Broker" },
];
const RULES: CustodianFee[] = [
  {
    id: "fee-rehearsal-1",
    custodianId: SURVIVOR.id,
    feeType: "Full transfer",
    accountType: "ANY",
    transferType: "ANY",
    direction: "ANY",
    amount: 75,
    amountText: null,
    notes: null,
    documentation: null,
  },
  {
    id: "fee-rehearsal-2",
    custodianId: SURVIVOR.id,
    feeType: "Termination",
    accountType: "ANY",
    transferType: "ANY",
    direction: "ANY",
    amount: 25,
    amountText: null,
    notes: null,
    documentation: null,
  },
];
const STORED_FILL = {
  feeAmount: "$100.00",
  feeMemo: "Full transfer: $75.00 + Termination: $25.00",
  feeCharged: "Yes",
};
const PRIOR_FEE = { feeAmount: "$10.00", feeMemo: "Prior memo", feeCharged: "Yes" };
const PLAYBOOK_REQUIREMENTS = [
  { label: "Client signature", value: "Required" },
  { label: "Letter of Acceptance (custodian wording)", value: "Rehearsal LOA wording" },
  { label: "Return method", value: "Secure upload" },
];

function confirmedCustodian(projectionRevision: number | null) {
  return {
    ...SURVIVOR,
    projectionRevision,
    fees: RULES,
    reviewStatus: "VERIFIED",
    transferType: "ACAT_API",
    documentationStatus: "DOCUMENTED",
    dtcNumber: "9999",
    receivingAccountNumber: null,
    signature: "Required",
    letterOfAcceptance: "Rehearsal LOA wording",
    medallionRequired: null,
    liquidationMethod: null,
    returnMethod: "Secure upload",
    watchouts: null,
    paperworkOnFile: true,
  };
}

function preparationRow(projectionRevision: number | null) {
  return {
    id: "rec-rehearsal-prep",
    deletedAt: null,
    clientName: "Synthetic Client",
    cedarRidgeUserId: null,
    identityVersion: 0,
    clientLinks: [],
    direction: "In",
    type: "Full account transfer",
    accountType: "IRA",
    status: "ToCome",
    transferWorkflow: "ACAT",
    apexAccountId: "SYN123456",
    statementAccountNumber: "SRC987654",
    transferringContra: SURVIVOR.name,
    dtccNumber: "9999",
    mappingSource: "test",
    mappingSyncedAt: null,
    mappingAccountId: null,
    mappingAccountSummary: null,
    verifiedApexAccountTitle: null,
    verifiedApexAccountTitleAt: null,
    verifiedApexAccountTitleBy: null,
    activeTransferTitleConfirmationId: null,
    activeTransferTitleConfirmation: null,
    transferTitleConfirmations: [],
    assets: [
      {
        id: "position-1",
        symbol: "TEST",
        description: "Synthetic position",
        cusip: "123456789",
        expectedQty: 5,
        amount: 100,
        assetClass: "Equity",
        includeInTransfer: true,
      },
    ],
    custodian: confirmedCustodian(projectionRevision),
  };
}

function survivorSnapshot() {
  return {
    id: SURVIVOR.id,
    name: SURVIVOR.name,
    // saveSnapshotSchema requires numbers here; null fails merge parse as mismatch.
    acat_fee_amount: 0,
    avg_processing_days: 7,
    contact_email: null,
    contact_method: "EMAIL",
    contact_details: null,
    review_status: "VERIFIED",
    transfer_type: "ACAT_API",
    documentation_status: "DOCUMENTED",
    dtc_number: "9999",
    receiving_account_number: null,
    signature: "Required",
    letter_of_acceptance: "Rehearsal LOA wording",
    medallion_required: null,
    liquidation_method: null,
    return_method: "Secure upload",
    watchouts: null,
    paperwork_on_file: true,
    transfers_to_date: 0,
    merged_into_id: null,
    retired_at: null,
    revision: "1",
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
    fee_rules: [],
  };
}

const mergeBody = { source: { id: SOURCE.id, name: SOURCE.name }, target: survivorSnapshot() };
const envelope = {
  revision: 1,
  previousRevision: null,
  checksum: custodianRevisionChecksum(mergeBody),
  body: mergeBody,
};
const store = { appliedRevision: 0, receipt: null as { revision: number; bodySha256: string } | null };
const storeUpdate: unknown[] = [];
const storeAudit: Array<{ data: unknown[] }> = [];
const updateMany = vi.fn(async (args: unknown) => {
  storeUpdate.push(args);
  return { count: LINKED.length };
});
const createMany = vi.fn(async (args: { data: unknown[] }) => {
  storeAudit.push(args);
  return { count: args.data.length };
});
const tx = {
  $queryRaw: vi.fn(async () => [{ id: 1, appliedRevision: store.appliedRevision }]),
  custodianProjectionState: {
    findUnique: vi.fn(async () => ({ id: 1, appliedRevision: store.appliedRevision })),
    update: vi.fn(async ({ data }: { data: { appliedRevision: number } }) => {
      store.appliedRevision = data.appliedRevision;
      return data;
    }),
  },
  custodianProjectionReceipt: {
    findUnique: vi.fn(async () => store.receipt),
    create: vi.fn(async ({ data }: { data: { revision: number; bodySha256: string } }) => {
      store.receipt = data;
      return data;
    }),
  },
  custodian: {
    upsert: vi.fn(async () => SURVIVOR),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === SOURCE.id ? SOURCE : where.id === SURVIVOR.id ? SURVIVOR : null,
    ),
    delete: vi.fn(async () => SOURCE),
  },
  custodianFee: {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({ id: "unused" })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  acatRecord: { findMany: vi.fn(async () => LINKED), updateMany },
  auditLog: { createMany },
  custodianFeeScheduleDocument: { updateMany: vi.fn(async () => ({ count: 0 })) },
};

function resetProjectionHarness() {
  store.appliedRevision = 0;
  store.receipt = null;
  storeUpdate.length = 0;
  storeAudit.length = 0;
  updateMany.mockClear();
  createMany.mockClear();
}

function editRequest() {
  return new Request(`http://localhost/api/machine/custodians/admin/${SURVIVOR.id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-acting-user-email": ADMIN,
    },
    body: JSON.stringify({ watchouts: "Synthetic rehearsal edit" }),
  });
}

describe("Tracker custodian move rehearsal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "1");
    vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "1");
    mockVerifyCaller.mockResolvedValue(CALLER);
    mockRateLimit.mockResolvedValue({ allowed: true });
    vi.mocked(prisma.allowedUser.findUnique).mockResolvedValue({ role: "ADMIN", active: true } as never);
    preparation.$transaction.mockImplementation((fn: (tx: typeof preparation) => unknown) => fn(preparation));
    preparation.acatDocument.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("TRK-REH-001 leaves all 3 linked transfers on the surviving custodian", async () => {
    resetProjectionHarness();
    const first = await applyCustodianProjection(tx as never, envelope);
    const second = await applyCustodianProjection(tx as never, envelope);
    expect(first).toEqual({ outcome: "accepted", revision: 1, movedTransfers: 3 });
    expect(second).toEqual({ outcome: "duplicate", revision: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { custodianId: SOURCE.id },
      data: { custodianId: SURVIVOR.id, custodianName: SURVIVOR.name, transferringContra: SURVIVOR.name },
    });
    markCase(SUITE, "TRK-REH-001");
  });

  it("TRK-REH-002 records 3 custodian-merge audit entries for 3 moved transfers", async () => {
    resetProjectionHarness();
    await applyCustodianProjection(tx as never, envelope);
    await applyCustodianProjection(tx as never, envelope);
    expect(createMany).toHaveBeenCalledTimes(1);
    const rows = storeAudit[0].data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.acatRecordId))).toEqual(new Set(LINKED.map((row) => row.id)));
    expect(
      rows.every(
        (row) => row.action === "custodian-merge" && row.newValue === SURVIVOR.name && row.performedBy === ACTOR,
      ),
    ).toBe(true);
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(createMany.mock.invocationCallOrder[0]);
    markCase(SUITE, "TRK-REH-002");
  });

  it("TRK-REH-003 sets fees and paperwork from the confirmed custodian", async () => {
    vi.stubEnv(PROJECTION_ENV, "1");
    const custodian = confirmedCustodian(1);
    vi.mocked(prisma.custodian.findFirst).mockResolvedValue(custodian as never);
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(custodian as never);
    resolveClientIdentities.mockResolvedValue({
      canonicalName: "Synthetic Client",
      cedarRidgeUserIds: [SELECTED],
      snapshotId: "snap",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest",
    });
    vi.mocked(prisma.acatRecord.create).mockResolvedValue({ id: "rec-rehearsal-create" } as never);
    vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue({ id: "rec-rehearsal-create" } as never);
    const created = await applyAcatCreate({
      performedBy: CALLER,
      body: {
        cedarRidgeUserId: SELECTED,
        clientName: "Synthetic Client",
        apexAccountId: "SYN123456",
        accountType: "IRA",
        type: "Full account transfer",
        direction: "In",
        transferringContra: SURVIVOR.name,
        status: "AcatReceived",
      },
    });
    expect(created.kind).toBe("record");
    const createMock = vi.mocked(prisma.acatRecord.create);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.lastCall![0].data).toMatchObject(STORED_FILL);

    const existing = {
      id: "rec-rehearsal-fee",
      deletedAt: null,
      clientLinks: [],
      assets: [],
      identityVersion: 0,
      clientName: "Synthetic Client",
      apexAccountId: "SYN123456",
      status: "AcatReceived",
      accountType: "IRA",
      type: "Full account transfer",
      direction: "In",
      custodianId: SURVIVOR.id,
      feeAmount: null,
      feeMemo: null,
      feeCharged: null,
    };
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockImplementation(
      (async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data })) as never,
    );
    const patched = await applyAcatPatch({ id: existing.id, performedBy: CALLER, body: { notes: "rehearsal" } });
    expect(patched.kind).toBe("record");
    const updateMock = vi.mocked(prisma.acatRecord.update);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.lastCall![0].data).toMatchObject(STORED_FILL);

    preparation.acatDocument.findMany.mockResolvedValue([]);
    preparation.acatRecord.findUnique.mockResolvedValue(preparationRow(1) as never);
    const prepared = await getPreparation("rec-rehearsal-prep");
    expect(prepared.requirements).toEqual(PLAYBOOK_REQUIREMENTS);
    markCase(SUITE, "TRK-REH-003");
  });

  it("TRK-REH-005 leaves fees and paperwork unchanged when the custodian is not confirmed", async () => {
    vi.stubEnv(PROJECTION_ENV, "1");
    const custodian = confirmedCustodian(null);
    vi.mocked(prisma.custodian.findFirst).mockResolvedValue(custodian as never);
    vi.mocked(prisma.custodian.findUnique).mockResolvedValue(custodian as never);
    resolveClientIdentities.mockResolvedValue({
      canonicalName: "Synthetic Client",
      cedarRidgeUserIds: [SELECTED],
      snapshotId: "snap",
      freshnessBasis: "UPSTREAM_VERIFIED",
      evidenceDigest: "digest",
    });
    vi.mocked(prisma.acatRecord.create).mockResolvedValue({ id: "rec-rehearsal-create" } as never);
    vi.mocked(prisma.acatRecord.findUniqueOrThrow).mockResolvedValue({ id: "rec-rehearsal-create" } as never);
    const created = await applyAcatCreate({
      performedBy: CALLER,
      body: {
        cedarRidgeUserId: SELECTED,
        clientName: "Synthetic Client",
        apexAccountId: "SYN123456",
        accountType: "IRA",
        type: "Full account transfer",
        direction: "In",
        transferringContra: SURVIVOR.name,
        status: "AcatReceived",
        ...PRIOR_FEE,
      },
    });
    expect(created.kind).toBe("record");
    const createMock = vi.mocked(prisma.acatRecord.create);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.lastCall![0].data).toMatchObject(PRIOR_FEE);

    const existing = {
      id: "rec-rehearsal-fee",
      deletedAt: null,
      clientLinks: [],
      assets: [],
      identityVersion: 0,
      clientName: "Synthetic Client",
      apexAccountId: "SYN123456",
      status: "AcatReceived",
      accountType: "IRA",
      type: "Full account transfer",
      direction: "In",
      custodianId: SURVIVOR.id,
      ...PRIOR_FEE,
    };
    vi.mocked(prisma.acatRecord.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.acatRecord.update).mockImplementation(
      (async ({ data }: { data: Record<string, unknown> }) => ({ ...existing, ...data })) as never,
    );
    const patched = await applyAcatPatch({ id: existing.id, performedBy: CALLER, body: { notes: "rehearsal" } });
    if (patched.kind !== "record") throw new Error("expected a record");
    expect(patched.record).toMatchObject(PRIOR_FEE);
    const updateMock = vi.mocked(prisma.acatRecord.update);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.lastCall![0].data.feeAmount).toBeUndefined();

    preparation.acatDocument.findMany.mockResolvedValue([]);
    preparation.acatRecord.findUnique.mockResolvedValue(preparationRow(null) as never);
    const prepared = await getPreparation("rec-rehearsal-prep");
    expect(prepared.requirements).toEqual(PLAYBOOK_REQUIREMENTS);
    markCase(SUITE, "TRK-REH-005");
  });

  describe("Tracker custodian move rehearsal — pre-freeze editing", () => {
    it("TRK-REH-004 accepts a Tracker custodian edit while the authority switch is off", async () => {
      expect(custodianEditBlockedResponse()).toBeNull();
      const result = await authorizeCustodianAdmin(editRequest(), "update");
      expect(result).toEqual({ actor: ADMIN });
      markCase(SUITE, "TRK-REH-004");
    });

    it("TRK-REH-006 refuses the same Tracker edit once the authority switch is on", async () => {
      vi.stubEnv(PROJECTION_ENV, "1");
      const result = await authorizeCustodianAdmin(editRequest(), "update");
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "custodian_authority_active" });
      markCase(SUITE, "TRK-REH-006");
    });
  });
});
