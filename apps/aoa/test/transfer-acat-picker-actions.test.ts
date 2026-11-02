import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, scopeSpy, sourceSpy, revalidateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), scopeSpy: vi.fn(), sourceSpy: vi.fn(), revalidateSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/data/acat-status", () => ({ fetchAcatList: sourceSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));

import { loadTransferAcatCandidates, linkAcatRecordToTransfer } from "@/app/(authenticated)/asset-transfer/acat-picker-actions";
import { destinationConfirmationKey, sourceConfirmationKey } from "@/lib/data/transfer-acat-picker";
import type { AcatListRow } from "@/lib/data/acat-status";
import type { TransferAcatLinkInput } from "@/lib/data/transfer-acat-picker-types";

const UUID = "11111111-2222-3333-4444-555555555555";
const source: AcatListRow = {
  id: "synthetic-acat-1", acatTransferId: UUID, clientName: "Synthetic Client",
  controlNumber: "private-control", direction: "INCOMING", type: "FULL", accountType: "IRA",
  status: "SUBMITTED", transferringContra: "Synthetic Custodian", statementAmount: 123400,
  acatDate: "2026-09-24", lastActivityAt: "2026-09-24", apexAccountId: "971622147016",
  statementAccountNumber: "562501056643", dtccNumber: "private-dtcc",
  assetMap: { total: 0, mapped: 0, unmapped: 0, pending: 0, expected: 0 },
};
const destination = {
  id: "synthetic-transfer-1", client_first_name: "Synthetic", client_last_name: "Client",
  client_sf_id: "synthetic-client-1", household_sf_id: "synthetic-household-1",
  household_name: "Synthetic Household", stage: "DECISION", archived_at: null,
  acat_record_id: null, acat_transfer_id: null,
  acat_link_version: 7,
};

const input = (overrides: Partial<TransferAcatLinkInput> = {}): TransferAcatLinkInput => ({
  recordId: source.id, confirmationKey: sourceConfirmationKey(source), confirmed: true,
  destinationConfirmationKey: destinationConfirmationKey(destination), ...overrides,
});

function fakeTx(target: Record<string, unknown> | null = destination) {
  return {
    $queryRaw: vi.fn(async () => [{ id: destination.id }]),
    transfer: {
      findUnique: vi.fn(async () => target),
      findMany: vi.fn(async () => [] as { acat_record_id: string | null; acat_transfer_id: string | null }[]),
      findFirst: vi.fn(async () => null as Record<string, unknown> | null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}
let tx: ReturnType<typeof fakeTx>;

beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic-ops@example.test" } });
  sourceSpy.mockResolvedValue([source]);
  tx = fakeTx();
  scopeSpy.mockImplementation(async (_identity: unknown, callback: (client: typeof tx) => unknown) => callback(tx));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function expectNoWrite() {
  expect(tx.transfer.updateMany).not.toHaveBeenCalled();
  expect(tx.auditLog.create).not.toHaveBeenCalled();
  expect(revalidateSpy).not.toHaveBeenCalled();
}

describe("transfer ACAT picker authorization and loading", () => {
  it.each([null, { user: {} }, { user: { role: "ADVISOR" } }, { user: { role: "CLIENT_SERVICE" } },
    { user: { role: "VIEWER" } }, { user: { role: "HEAD_OF_ADVISORY" } }, { user: { role: "invalid" } }])(
    "rejects unauthorized sessions before any target or firm-wide read (%j)", async (session) => {
      authSpy.mockResolvedValue(session);
      expect(await loadTransferAcatCandidates(destination.id)).toMatchObject({ ok: false });
      expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false });
      expect(scopeSpy).not.toHaveBeenCalled();
      expect(sourceSpy).not.toHaveBeenCalled();
      expectNoWrite();
    },
  );

  it("handles auth transport failure without redirecting or leaking details", async () => {
    authSpy.mockRejectedValue(new Error("private auth payload"));
    expect(JSON.stringify(await loadTransferAcatCandidates(destination.id))).not.toContain("private auth payload");
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false });
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(sourceSpy).not.toHaveBeenCalled();
  });

  it.each([null, { ...destination, stage: "FUNDED" }, { ...destination, archived_at: new Date() },
    { ...destination, acat_record_id: "existing-record" }, { ...destination, acat_transfer_id: UUID }])(
    "rejects unavailable targets before reading source (%j)", async (target) => {
      tx.transfer.findUnique.mockResolvedValue(target);
      expect(await loadTransferAcatCandidates(destination.id)).toMatchObject({ ok: false });
      expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false });
      expect(tx.transfer.findMany).not.toHaveBeenCalled();
      expect(sourceSpy).not.toHaveBeenCalled();
      expectNoWrite();
    },
  );

  it.each(["OPERATIONS", "ADMIN"])("projects only review fields and masks upstream accounts for %s", async (role) => {
    authSpy.mockResolvedValue({ user: { role, email: "synthetic@example.test" } });
    const result = await loadTransferAcatCandidates(destination.id);
    expect(result).toMatchObject({ ok: true, destination: {
      id: destination.id, clientName: "Synthetic Client", householdName: "Synthetic Household",
      confirmationKey: destinationConfirmationKey(destination),
    }, candidates: [{ statementAccountMasked: "••••6643", receivingAccountMasked: "••••7016", unavailableReason: null }] });
    const serialized = JSON.stringify(result);
    for (const privateValue of [UUID, "562501056643", "971622147016", "private-control", "private-dtcc", "synthetic-client-1", "synthetic-household-1"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(scopeSpy).toHaveBeenCalledWith({ role, email: "synthetic@example.test" }, expect.any(Function));
    expect(sourceSpy).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("marks record and legacy UUID links unavailable, including archived transfer links", async () => {
    sourceSpy.mockResolvedValue([source, { ...source, id: "legacy-source", acatTransferId: "legacy-id" },
      { ...source, id: "placeholder-source", acatTransferId: "N/A" }]);
    tx.transfer.findMany.mockResolvedValue([
      { acat_record_id: source.id, acat_transfer_id: null },
      { acat_record_id: null, acat_transfer_id: "legacy-id" },
      { acat_record_id: "other-placeholder", acat_transfer_id: "N/A" },
    ]);
    const result = await loadTransferAcatCandidates(destination.id);
    if (!result.ok) throw new Error(result.message);
    expect(result.candidates.map((candidate) => candidate.unavailableReason)).toEqual([
      "Already linked to a transfer", "Already linked to a transfer", null,
    ]);
    const query = tx.transfer.findMany.mock.calls[0] as unknown[];
    expect(JSON.stringify(query)).not.toContain("archived_at");
  });

  it("returns a successful empty list", async () => {
    sourceSpy.mockResolvedValue([]);
    expect(await loadTransferAcatCandidates(destination.id)).toMatchObject({ ok: true, candidates: [] });
  });

  it.each(["unauthorized", "tracker_error", "transport_error"])("handles %s source failure without writes or private errors", async (reason) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sourceSpy.mockRejectedValue(new Error(`${reason}: private source payload`));
    for (const result of [await loadTransferAcatCandidates(destination.id), await linkAcatRecordToTransfer(destination.id, input())]) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/Tracker is unavailable/) });
      expect(JSON.stringify(result)).not.toContain("private source payload");
    }
    expect(log).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each(["load", "link"])("cancels a %s source request after eight seconds", async (operation) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    sourceSpy.mockImplementation((options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const pending = operation === "load" ? loadTransferAcatCandidates(destination.id) : linkAcatRecordToTransfer(destination.id, input());
    await vi.advanceTimersByTimeAsync(7_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false, message: expect.stringMatching(/Tracker is unavailable/) });
    expectNoWrite();
  });
});

describe("transfer ACAT picker fresh, audited linking", () => {
  it.each([false, undefined, "true"])("requires explicit boolean confirmation (%j)", async (confirmed) => {
    expect(await linkAcatRecordToTransfer(destination.id, input({ confirmed: confirmed as boolean }))).toMatchObject({ ok: false });
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(sourceSpy).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("rereads source after load, uses server UUID, locks target and commits only link fields plus one audit", async () => {
    const loaded = await loadTransferAcatCandidates(destination.id);
    if (!loaded.ok) throw new Error(loaded.message);
    const submitted = { ...input(), acatTransferId: "forged-client-uuid", clientName: "Forged" };
    expect(await linkAcatRecordToTransfer(destination.id, submitted)).toEqual({ ok: true });
    expect(sourceSpy).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.transfer.findUnique.mock.invocationCallOrder[2]);
    expect(tx.transfer.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: destination.id, acat_record_id: null, acat_transfer_id: null, archived_at: null, acat_link_version: 7 },
      data: { acat_record_id: source.id, acat_transfer_id: UUID, updated_by: "synthetic-ops@example.test",
        acat_auto_link_hold: true, acat_link_provenance: "MANUAL", acat_link_decision_id: null },
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    const audit = tx.auditLog.create.mock.calls[0] as unknown as [{ data: { detail: string; action: string } }];
    expect(audit[0].data.action).toBe("transfer.update");
    expect(JSON.parse(audit[0].data.detail)).toEqual({ changes: {
      acat_record_id: { from: null, to: source.id }, acat_transfer_id: { from: null, to: UUID },
    }, acat_link_version: 7, provenance: "MANUAL", automation_hold: true, decision_id: null,
      link_before: { recordId: null, transferUuid: null }, link_after: { recordId: source.id, transferUuid: UUID } });
    expect(audit[0].data.detail).not.toContain("Synthetic Client");
    expect(scopeSpy).toHaveBeenCalledTimes(3); // load, preflight, locked attach + audit
    expect(revalidateSpy.mock.calls.map(([path]) => path)).toEqual([
      `/asset-transfer/${destination.id}`, "/asset-transfer", "/acat-tracking",
    ]);
  });

  it.each(["N/A", "", " pending "])("links a source record with placeholder UUID %j as null", async (acatTransferId) => {
    const row = { ...source, acatTransferId };
    sourceSpy.mockResolvedValue([row]);
    expect(await linkAcatRecordToTransfer(destination.id, input({ confirmationKey: sourceConfirmationKey(row) }))).toEqual({ ok: true });
    expect(tx.transfer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      acat_record_id: row.id, acat_transfer_id: null,
    }) }));
  });

  it.each([
    { reason: "missing", rows: [] },
    { reason: "different record", rows: [{ ...source, id: "different-record" }] },
    { reason: "ambiguous record", rows: [source, source] },
    { reason: "changed name", rows: [{ ...source, clientName: "Changed identity" }] },
    { reason: "changed UUID", rows: [{ ...source, acatTransferId: "changed-uuid" }] },
    { reason: "changed source account exposed by machine endpoint", rows: [{ ...source, statementAccountNumber: "********4444" }] },
    { reason: "changed receiving account exposed by machine endpoint", rows: [{ ...source, apexAccountId: "********8888" }] },
  ])("refuses missing, ambiguous or stale source identity: $reason", async ({ rows }) => {
    sourceSpy.mockResolvedValue(rows);
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({
      ok: false, message: expect.stringMatching(/changed or is no longer available/),
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("allows status/activity to progress without treating the source as a different identity", async () => {
    sourceSpy.mockResolvedValue([{ ...source, status: "ACCEPTED", lastActivityAt: "2026-09-25" }]);
    expect(await linkAcatRecordToTransfer(destination.id, input())).toEqual({ ok: true });
  });

  it.each([null, { ...destination, archived_at: new Date() }, { ...destination, stage: "FUNDED" },
    { ...destination, acat_record_id: "won-by-another" }, { ...destination, acat_transfer_id: "won-by-another" },
    { ...destination, client_sf_id: "reassigned-client" }, { ...destination, household_sf_id: "reassigned-household" },
    { ...destination, client_first_name: "Changed" }, { ...destination, household_name: "Changed" },
  ])("rechecks target eligibility and reviewed identity under lock (%j)", async (current) => {
    tx.transfer.findUnique.mockResolvedValueOnce(destination).mockResolvedValue(current);
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.transfer.findFirst).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("rejects a changed destination before source access too", async () => {
    tx.transfer.findUnique.mockResolvedValue({ ...destination, client_last_name: "Changed" });
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false, message: expect.stringMatching(/client or household changed/) });
    expect(sourceSpy).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each(["record", "uuid"])("preserves the existing %s duplicate guard", async (kind) => {
    tx.transfer.findFirst.mockImplementation(async (query?: unknown) => {
      const where = (query as { where: { acat_record_id?: string; acat_transfer_id?: string | { equals: string; mode: string } } }).where;
      return (kind === "record" ? where.acat_record_id : where.acat_transfer_id) ? { id: "other-transfer" } : null;
    });
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false, message: expect.stringMatching(/already linked/) });
    expectNoWrite();
  });

  it("maps the database unique-index race to an actionable duplicate message", async () => {
    tx.transfer.updateMany.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("private row data", { code: "P2002", clientVersion: "test" }));
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false, message: expect.stringMatching(/already linked/) });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("refuses a concurrent destination link when the guarded attachment updates no row", async () => {
    tx.transfer.updateMany.mockResolvedValue({ count: 0 });
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({
      ok: false, message: expect.stringMatching(/already has an ACAT/),
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("fails cleanly if target lock cannot see a row", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await linkAcatRecordToTransfer(destination.id, input())).toMatchObject({ ok: false });
    expectNoWrite();
  });

  it("surfaces transaction/audit failure without claiming success or refreshing", async () => {
    tx.auditLog.create.mockRejectedValue(new Error("private database payload"));
    const result = await linkAcatRecordToTransfer(destination.id, input());
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private database payload");
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("does not claim an already committed write failed if cache refresh throws", async () => {
    revalidateSpy.mockImplementation(() => { throw new Error("cache unavailable"); });
    expect(await linkAcatRecordToTransfer(destination.id, input())).toEqual({ ok: true });
    expect(tx.transfer.updateMany).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });
});
