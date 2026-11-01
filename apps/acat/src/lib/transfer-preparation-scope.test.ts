// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), find: vi.fn(), update: vi.fn(),
  operationFind: vi.fn(), operationCreate: vi.fn(), audit: vi.fn(), documents: vi.fn() }));
vi.mock("./transfer-preparation-prisma", () => ({ transferPreparationPrisma: { $transaction: mocks.transaction } }));
import { confirmReceivingTitle, generateTransferForm, getPreparation, receivingFingerprint, sourceRevision, updateTransferScope, type TransferSource } from "./transfer-preparation-service";
import type { GenerateTransferForm, UpdateTransferScope } from "./transfer-form-contract";

const actor = { email: "operator@example.test", serviceAccount: "ops-portal@example.iam.gserviceaccount.com" };
let templateHash: string;
let record: TransferSource;
type Operation = { acatRecordId: string; actorEmail: string; operationId: string; kind: string; requestHash: string; serviceOrigin: string };
let operations: Map<string, Operation>;
const operationKey = (value: Pick<Operation, "acatRecordId" | "actorEmail" | "operationId">) =>
  `${value.acatRecordId}:${value.actorEmail}:${value.operationId}`;
const document = { id: "existing-pdf", filename: "old.pdf", createdBy: "original@example.test",
  createdAt: new Date("2026-09-20T10:00:00.000Z"), sha256: "f".repeat(64) };

function fixture(): TransferSource {
  const source: TransferSource = {
    id: "record-1", deletedAt: null, clientName: "Synthetic Client", cedarRidgeUserId: null, identityVersion: 0, clientLinks: [],
    direction: "In", type: "Full", accountType: "IRA", status: "AcatReceived", transferWorkflow: "ACAT",
    apexAccountId: "SYN123456", statementAccountNumber: "SRC987654", transferringContra: "Synthetic Broker", dtccNumber: "9999",
    mappingSource: "test", mappingSyncedAt: null, mappingAccountId: null, mappingAccountSummary: null,
    verifiedApexAccountTitle: "Synthetic Client IRA", verifiedApexAccountTitleAt: "2026-09-25T12:00:00.000Z", verifiedApexAccountTitleBy: actor.email,
    activeTransferTitleConfirmationId: "confirmation-1", activeTransferTitleConfirmation: null, transferTitleConfirmations: [],
    assets: [true, false, null].map((includeInTransfer, index) => ({ id: `position-${index + 1}`, symbol: `TEST${index + 1}`,
      description: "Synthetic position", cusip: "123456789", expectedQty: 5, amount: 100, assetClass: "Equity", includeInTransfer })),
    custodian: { id: "custodian-1", name: "Synthetic Broker", reviewStatus: "VERIFIED", transferType: "ACAT_API",
      documentationStatus: "DOCUMENTED", dtcNumber: "9999", receivingAccountNumber: null, signature: "Required",
      letterOfAcceptance: null, medallionRequired: null, liquidationMethod: null, returnMethod: null, watchouts: null, paperworkOnFile: true, projectionRevision: null },
  };
  source.activeTransferTitleConfirmation = { id: "confirmation-1", acatRecordId: source.id, title: source.verifiedApexAccountTitle!,
    registration: "Traditional IRA", receivingAccountFingerprint: receivingFingerprint(source), sourceAccountType: source.accountType,
    sourceIdentityVersion: source.identityVersion, sourceRevision: "b".repeat(64), confirmedBy: actor.email,
    confirmedAt: new Date(source.verifiedApexAccountTitleAt!), serviceOrigin: actor.serviceAccount };
  source.transferTitleConfirmations = [source.activeTransferTitleConfirmation];
  return source;
}
function request(scope: UpdateTransferScope["scope"] = "PARTIAL"): UpdateTransferScope {
  return { expectedRevision: sourceRevision(record, templateHash), operationId: randomUUID(), scope, confirmed: true };
}

beforeAll(async () => {
  templateHash = createHash("sha256").update(await readFile(join(process.cwd(), "public/form-templates/apex-customer-account-transfer-request.pdf"))).digest("hex");
});
beforeEach(() => {
  vi.resetAllMocks(); record = fixture(); operations = new Map();
  mocks.query.mockResolvedValue([{ custodianId: record.custodian!.id }]);
  mocks.find.mockImplementation(async () => structuredClone(record));
  mocks.update.mockImplementation(async ({ data }: { data: { type: string; lastUpdated: string } }) => {
    record.type = data.type;
    return structuredClone(record);
  });
  mocks.operationFind.mockImplementation(async ({ where }: { where: { acatRecordId_actorEmail_operationId: Parameters<typeof operationKey>[0] } }) =>
    operations.get(operationKey(where.acatRecordId_actorEmail_operationId)) ?? null);
  mocks.operationCreate.mockImplementation(async ({ data }: { data: Operation }) => { operations.set(operationKey(data), data); return data; });
  mocks.documents.mockResolvedValue([document]);
  const tx = { $queryRaw: mocks.query, acatRecord: { findUnique: mocks.find, update: mocks.update },
    transferPreparationOperation: { findUnique: mocks.operationFind, create: mocks.operationCreate },
    auditLog: { create: mocks.audit }, acatDocument: { findMany: mocks.documents } };
  mocks.transaction.mockImplementation((callback: (transaction: Prisma.TransactionClient) => Promise<unknown>) => callback(tx as unknown as Prisma.TransactionClient));
});

describe("inline scope update service", () => {
  it("changes only the canonical scope and update timestamp, preserving title, identity, status, selections and old document history", async () => {
    const before = structuredClone(record);
    const input = request();
    const dto = await updateTransferScope(record.id, input, actor);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: record.id, deletedAt: null }, data: { type: "Partial", lastUpdated: expect.any(String) } });
    expect(Number.isFinite(Date.parse(mocks.update.mock.calls[0][0].data.lastUpdated))).toBe(true);
    expect(record).toEqual({ ...before, type: "Partial" });
    expect(dto.scope).toBe("PARTIAL"); expect(dto.sourceRevision).not.toBe(input.expectedRevision);
    expect(dto.confirmation).toMatchObject({ valid: true, id: "confirmation-1", confirmedBy: actor.email, confirmedAt: before.verifiedApexAccountTitleAt });
    expect(dto.positions.map((p) => p.include)).toEqual([true, false, null]);
    expect(dto.blockers.map((blocker) => blocker.code)).toContain("positions_undecided");
    expect(dto.documents).toEqual([{ ...document, createdAt: document.createdAt.toISOString() }]);
    expect(mocks.audit).toHaveBeenCalledWith({ data: { acatRecordId: record.id, action: "ops-portal-transfer-scope-update", field: "type",
      oldValue: "Full", newValue: "Partial", performedBy: actor.email } });
    expect(mocks.operationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "UPDATE_SCOPE", actorEmail: actor.email, serviceOrigin: actor.serviceAccount }) });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable", timeout: 30_000 });
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });
  it("uses all holdings for Full while preserving earlier partial choices for a round trip", async () => {
    record.type = "Partial";
    const full = await updateTransferScope(record.id, request("FULL"), actor);
    expect(full.scope).toBe("FULL");
    expect(full.positions.map((p) => p.include)).toEqual([true, false, null]);
    expect(full.blockers.map((blocker) => blocker.code)).not.toContain("positions_undecided");
    const partial = await updateTransferScope(record.id, request("PARTIAL"), actor);
    expect(partial.blockers.map((blocker) => blocker.code)).toContain("positions_undecided");
    expect(record.assets.map((p) => p.includeInTransfer)).toEqual([true, false, null]);
  });
  it("replays an old operation as the current DTO without reversing a later edit or adding another audit", async () => {
    const input = request();
    await updateTransferScope(record.id, input, actor);
    record.type = "Full"; record.assets[0].expectedQty = 12;
    const currentRevision = sourceRevision(record, templateHash);
    const dto = await updateTransferScope(record.id, input, actor);
    expect(dto.scope).toBe("FULL"); expect(dto.sourceRevision).toBe(currentRevision);
    expect(mocks.update).toHaveBeenCalledTimes(1); expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
    await expect(updateTransferScope(record.id, { ...input, scope: "FULL" }, actor)).rejects.toMatchObject({ reason: "invalid" });
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it("persists an unchanged save without rewriting a canonical alias or confirmation timestamp", async () => {
    record.type = "Full account transfer";
    const input = request("FULL");
    const dto = await updateTransferScope(record.id, input, actor);
    expect(dto.sourceRevision).toBe(input.expectedRevision);
    expect(record.type).toBe("Full account transfer");
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.operationCreate).toHaveBeenCalledTimes(1);
  });
  it.each([null, "Unknown"])("allows explicit classification of ordinary unknown scope %s", async (type) => {
    record.type = type;
    expect((await updateTransferScope(record.id, request("FULL"), actor)).scope).toBe("FULL");
    expect(mocks.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ oldValue: type, newValue: "Full" }) });
  });
  it.each(["Submitted", "Completed", "Canceled", "Purged"] as const)("preserves %s status just like the existing Tracker type editor", async (status) => {
    record.status = status;
    await updateTransferScope(record.id, request(), actor);
    expect(record.status).toBe(status);
  });
  it.each([{ direction: "Out" }, { direction: null }, { transferWorkflow: "DRS" }, { transferWorkflow: "RESIDUAL" }] as const)("rejects unsupported transfer shape %j without writing", async (change) => {
    Object.assign(record, change);
    await expect(updateTransferScope(record.id, request(), actor)).rejects.toMatchObject({ reason: "review_required" });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.operationCreate).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("rejects stale revisions before changing the record or recording an operation", async () => {
    const input = request(); record.assets[0].expectedQty = 12;
    await expect(updateTransferScope(record.id, input, actor)).rejects.toMatchObject({ reason: "stale" });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.operationCreate).not.toHaveBeenCalled();
  });
  it("rejects an unconfirmed request before starting a transaction", async () => {
    await expect(updateTransferScope(record.id, { ...request(), confirmed: false } as unknown as UpdateTransferScope, actor)).rejects.toMatchObject({ reason: "invalid" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["40001", "40P01"])("maps raw row-lock transaction conflict %s to stale", async (sqlState) => {
    mocks.query.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("private database detail", {
      code: "P2010", clientVersion: "test", meta: { code: sqlState },
    }));
    await expect(updateTransferScope(record.id, request(), actor)).rejects.toMatchObject({ reason: "stale" });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.operationCreate).not.toHaveBeenCalled();
  });
  it("does not mislabel unrelated raw query errors as stale", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("private database detail", {
      code: "P2010", clientVersion: "test", meta: { code: "42601" },
    });
    mocks.query.mockRejectedValueOnce(error);
    await expect(updateTransferScope(record.id, request(), actor)).rejects.toBe(error);
  });
});

describe("refused paperwork requests", () => {
  const stale = "0".repeat(64);
  async function expectStoredPaperworkUnchanged() {
    const dto = await getPreparation(record.id);
    expect(dto.confirmation).toMatchObject({ title: "Synthetic Client IRA", confirmedBy: actor.email, valid: true });
    expect(dto.documents.map((item) => item.id)).toEqual([document.id]);
  }
  it("returns the stored title and documents unchanged after a refused title confirmation", async () => {
    await expect(confirmReceivingTitle(record.id, { expectedRevision: stale, operationId: randomUUID(),
      title: "Replacement title", registration: "Traditional IRA", confirmed: true }, actor)).rejects.toMatchObject({ reason: "stale" });
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.operationCreate).not.toHaveBeenCalled();
    await expectStoredPaperworkUnchanged();
  });
  it("returns the stored title and documents unchanged after a refused form request", async () => {
    const input: GenerateTransferForm = { expectedRevision: stale, confirmationId: "confirmation-1", operationId: randomUUID(),
      workflowId: "default-brokerage-firm-transfer", assetInstruction: "IN_KIND", deliveringTitle: "Synthetic Client",
      deliveringTitleConfirmed: true, accountsReviewed: true, instructionsReviewed: true, letterOfAuthorizationRequired: false };
    await expect(generateTransferForm(record.id, input, actor)).rejects.toMatchObject({ reason: "stale" });
    expect(mocks.operationCreate).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    await expectStoredPaperworkUnchanged();
  });
});
