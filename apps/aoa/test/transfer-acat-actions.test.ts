import { beforeEach, describe, expect, it, vi } from "vitest";

// Either-id ACAT routing in createTransfer/updateTransfer
// (fix/acat-link-either-id), WITHOUT a DB or the live tracker. @/auth, @/lib/rls,
// @/lib/flags, next/*, and the acat-status fetchers are mocked (the
// asset-transfer-asset-map-actions idiom); withUserScope runs the real callback
// against a fake tx. Asserts the routing matrix:
//   record-id shape → by-record verify → acat_record_id (+ resolved real UUID);
//   UUID shape      → by-UUID verify → acat_transfer_id;
//   unchanged       → NO tracker call, columns untouched;
//   404 / unreachable → field error, NOTHING written (fail closed);
//   blank           → both columns cleared + audited;
//   P2002           → the friendly "already linked" error.

const {
  authSpy,
  withUserScopeSpy,
  revalidateSpy,
  redirectSpy,
  getStatusSpy,
  getStatusByRecordSpy,
  signalSpy,
  checklistFlagSpy,
  redesignFlagSpy,
  manualLinkSpy,
} = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  redirectSpy: vi.fn(),
  getStatusSpy: vi.fn(),
  getStatusByRecordSpy: vi.fn(),
  signalSpy: vi.fn(() => true),
  checklistFlagSpy: vi.fn(() => false),
  redesignFlagSpy: vi.fn(() => false),
  manualLinkSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/acat-link", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/acat-link")>(),
  setManualAcatLinkWithinScope: manualLinkSpy,
}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/flags", () => ({
  transferDealSourcedRedesignEnabled: redesignFlagSpy,
  assetMapTransferLinkEnabled: vi.fn(() => false),
  checklistStageGateEnabled: checklistFlagSpy,
  transferArchiveActionEnabled: vi.fn(() => false),
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("@/lib/data/transfer-asset-map", () => ({
  listAssignableAssetMapAccounts: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));
vi.mock("@/lib/crm/post-commit-signal", () => ({
  scheduleCrmIdentityReconciliation: signalSpy,
}));
// The actions' catch discriminates on instanceof AcatStatusError (a real
// AcatStatusError → friendly fail-closed error; anything else RETHROWS as a
// programming error), so the mock must export the same class the test throws.
const { MockAcatStatusError } = vi.hoisted(() => ({
  MockAcatStatusError: class MockAcatStatusError extends Error {
    kind: string;
    constructor(message: string, kind = "tracker_error") {
      super(message);
      this.kind = kind;
    }
  },
}));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatStatus: getStatusSpy,
  getAcatStatusByRecordId: getStatusByRecordSpy,
  AcatStatusError: MockAcatStatusError,
}));

import { Prisma } from "@prisma/client";
import {
  createTransfer,
  updateTransfer,
} from "@/app/(authenticated)/asset-transfer/actions";
import { LINK_ERRORS } from "@/lib/data/acat-link";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import { DEFAULT_TASKS } from "@/lib/data/transfer-types";
import type { TransferRow } from "@/lib/data/transfer-types";

const UUID = "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const CUID = "cmrezpdyf0001s6019c0bup4n";

function row(over: Partial<TransferRow> = {}): TransferRow {
  return {
    id: "t1",
    source: "APP",
    client_first_name: "Sam",
    client_last_name: "Stone",
    client_sf_id: null,
    household_name: null,
    household_sf_id: null,
    value: 500000,
    stage: "IN_TRANSFER",
    stage_entered_at: new Date("2026-07-01T00:00:00.000Z"),
    owner_kind: "OPERATIONS",
    owner_name: null,
    next_step: null,
    next_step_owner: null,
    pending_nudge: null,
    acat_transfer_id: null,
    funding_type: null,
    accounts_opened_at_apex: false,
    funding_plan_complete: false,
    funding_plan_version: 0,
    funding_plan_approved_at: null,
    funding_plan_approved_by: null,
    funding_initiated: false,
    cash_in_flight: false,
    deal_id: null,
    deal_sf_id: null,
    transferring_firm: null,
    archived_at: null,
    archived_by: null,
    archived_reason: null,
    sync_flag: null,
    acat_record_id: null,
    asset_map_folder_id: null,
    asset_map_custodian: null,
    asset_map_account_number: null,
    asset_map_account_type: null,
    created_by: "ops@example.com",
    updated_by: "ops@example.com",
    created_at: new Date("2026-06-18T00:00:00.000Z"),
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    ...over,
  };
}

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
  transferTask: { createMany: ReturnType<typeof vi.fn> };
};

let tx: FakeTx;

function wireScope(current: TransferRow | null) {
  tx = {
    $queryRaw: vi.fn(async () => [{ id: "t1" }]),
    transfer: {
      findUnique: vi.fn(async () =>
        current ? { ...current, acat_link_version: 7, tasks: [] } : null,
      ),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: "new-1", acat_link_version: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    transferTask: { createMany: vi.fn(async () => ({ count: 0 })) },
  };
  withUserScopeSpy.mockImplementation(
    async (_id: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
}

/** Submitted edit-form values for `current`, with the ACAT field overridden. */
function valuesWith(current: TransferRow, acat: string, extra: Partial<ReturnType<typeof transferToFormValues>> = {}) {
  return { ...transferToFormValues(current), acat_transfer_id: acat, ...extra };
}

beforeEach(() => {
  vi.resetAllMocks(); // wipe per-test implementations too (tracker resolutions)
  authSpy.mockResolvedValue({
    user: { email: "ops@example.com", role: "OPERATIONS" },
  });
  manualLinkSpy.mockResolvedValue({ ok: true });
  checklistFlagSpy.mockReturnValue(false);
  redesignFlagSpy.mockReturnValue(false);
});

describe("updateTransfer — either-id ACAT routing", () => {
  it("seeds the destination checklist when the edit form advances stage", async () => {
    const current = row({ stage: "IN_TRANSFER", funding_plan_complete: true, funding_plan_version: 1 });
    wireScope(current);
    checklistFlagSpy.mockReturnValue(true);

    await updateTransfer(
      "t1",
      valuesWith(current, "", { stage: "FUNDED" }),
    );

    expect(tx.transferTask.createMany).toHaveBeenCalledTimes(1);
    const data = tx.transferTask.createMany.mock.calls[0][0].data as {
      transfer_id: string;
      title: string;
      sort_order: number;
    }[];
    expect(data.map((task) => task.title)).toEqual([
      "All positions received",
      "Cost basis verified",
      "Transition template applied",
      "Fee reimbursement filed",
    ]);
    expect(data.every((task) => task.transfer_id === "t1")).toBe(true);
  });

  it("record-id shape → by-RECORD verify → writes acat_record_id + the resolved real UUID", async () => {
    const current = row();
    wireScope(current);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: UUID });

    const res = await updateTransfer("t1", valuesWith(current, CUID));
    expect(res).toBeUndefined(); // success → redirect (mocked)

    expect(getStatusByRecordSpy).toHaveBeenCalledWith(CUID);
    expect(getStatusSpy).not.toHaveBeenCalled();
    const data = manualLinkSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.recordId).toBe(CUID);
    expect(data.acatTransferId).toBe(UUID);
    // Audit carries BOTH columns' {from,to}.
    const audit = JSON.stringify(tx.auditLog.create.mock.calls[0][0]);
    expect(audit).toContain("acat_record_id");
    expect(audit).toContain(CUID);
    expect(audit).toContain(UUID);
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer");
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer/t1");
    expect(redirectSpy).toHaveBeenCalledWith("/asset-transfer/t1");
  });

  it("record whose projection carries a PLACEHOLDER acatTransferId → uuid column stays null (D2)", async () => {
    const current = row();
    wireScope(current);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: "N/A" });

    await updateTransfer("t1", valuesWith(current, "rec-manual-hayes"));
    const data = manualLinkSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.recordId).toBe("rec-manual-hayes");
    expect(data.acatTransferId).toBeNull();
  });

  it("UUID shape → by-UUID verify → writes acat_transfer_id (record column cleared)", async () => {
    const current = row();
    wireScope(current);
    getStatusSpy.mockResolvedValue({ acatTransferId: UUID });

    await updateTransfer("t1", valuesWith(current, UUID));
    expect(getStatusSpy).toHaveBeenCalledWith(UUID);
    expect(getStatusByRecordSpy).not.toHaveBeenCalled();
    const data = manualLinkSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.acatTransferId).toBe(UUID);
    expect(data.recordId).toBeNull(); // always cleared on a UUID link
  });

  it("unchanged value → NO tracker call and the link columns are not touched", async () => {
    const current = row({ acat_record_id: CUID, acat_transfer_id: UUID });
    wireScope(current);

    // The form seeds record-id-first; resubmit it with another field edited.
    await updateTransfer(
      "t1",
      valuesWith(current, CUID, { next_step: "Call the client" }),
    );
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(getStatusByRecordSpy).not.toHaveBeenCalled();
    const data = tx.transfer.update.mock.calls[0][0].data as Record<string, unknown>;
    expect("acat_record_id" in data).toBe(false);
    expect("acat_transfer_id" in data).toBe(false);
    // No bogus acat entry rides the audit change map.
    const audit = JSON.stringify(tx.auditLog.create.mock.calls[0][0]);
    expect(audit).not.toContain("acat_record_id");
    expect(audit).not.toContain("acat_transfer_id");
  });

  it("resubmitting the legacy UUID (shown on pre-record-id rows) is also a no-op", async () => {
    const current = row({ acat_transfer_id: UUID });
    wireScope(current);

    await updateTransfer("t1", valuesWith(current, UUID));
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(getStatusByRecordSpy).not.toHaveBeenCalled();
    // Nothing else changed either → full no-op: no write, no audit.
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(manualLinkSpy).not.toHaveBeenCalled();
  });

  it("does not save business edits when the guarded manual link loses its version race", async () => {
    const current = row();
    wireScope(current);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: UUID });
    manualLinkSpy.mockResolvedValue({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    const result = await updateTransfer("t1", valuesWith(current, CUID, { next_step: "Must not persist" }));
    expect(result).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_LINK_CHANGED] });
    expect(manualLinkSpy).toHaveBeenCalledWith(tx, expect.anything(), {
      transferId: "t1", expectedVersion: 7, expectedRecordId: null, expectedTransferUuid: null,
      recordId: CUID, acatTransferId: UUID,
    });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("tracker 404 → friendly field error and NOTHING written", async () => {
    const current = row();
    wireScope(current);
    getStatusByRecordSpy.mockResolvedValue(null);

    const res = await updateTransfer("t1", valuesWith(current, "rec-nope"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_NOT_FOUND] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
  });

  it("tracker unreachable (AcatStatusError) → friendly field error and NOTHING written (fail closed)", async () => {
    const current = row();
    wireScope(current);
    getStatusSpy.mockRejectedValue(new MockAcatStatusError("transport", "tracker_error"));

    const res = await updateTransfer("t1", valuesWith(current, UUID));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_UNVERIFIED] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a NON-AcatStatusError from the verify path RETHROWS (programming errors stay loud)", async () => {
    const current = row();
    wireScope(current);
    getStatusSpy.mockRejectedValue(new TypeError("bug in verify path"));

    await expect(updateTransfer("t1", valuesWith(current, UUID))).rejects.toThrow(
      "bug in verify path",
    );
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("relink-by-UUID on a record-linked row CLEARS the stale record id (record-id-first reads must not keep showing the OLD ACAT)", async () => {
    const OTHER_UUID = "9b8a7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d";
    const current = row({ acat_record_id: CUID, acat_transfer_id: UUID });
    wireScope(current);
    getStatusSpy.mockResolvedValue({ acatTransferId: OTHER_UUID });

    await updateTransfer("t1", valuesWith(current, OTHER_UUID));
    expect(getStatusSpy).toHaveBeenCalledWith(OTHER_UUID);
    const data = manualLinkSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.recordId).toBeNull(); // stale record id dropped
    expect(data.acatTransferId).toBe(OTHER_UUID);
    // Audit carries BOTH transitions.
    const audit = JSON.stringify(tx.auditLog.create.mock.calls[0][0]);
    expect(audit).toContain("acat_record_id");
    expect(audit).toContain("acat_transfer_id");
  });

  it("resubmitting the stored UUID in a DIFFERENT CASE is a no-op (no verify, record link kept)", async () => {
    const current = row({ acat_record_id: CUID, acat_transfer_id: UUID });
    wireScope(current);

    await updateTransfer("t1", valuesWith(current, UUID.toUpperCase()));
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(getStatusByRecordSpy).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("verify_uuid stores the tracker's CANONICAL id when the echo differs in case", async () => {
    const current = row();
    wireScope(current);
    getStatusSpy.mockResolvedValue({ acatTransferId: UUID }); // canonical lowercase

    await updateTransfer("t1", valuesWith(current, UUID.toUpperCase()));
    const data = manualLinkSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.acatTransferId).toBe(UUID); // canonical, not the typed casing
  });

  it("clearing the field unlinks BOTH columns with an accurate audit change map", async () => {
    const current = row({ acat_record_id: CUID, acat_transfer_id: UUID });
    wireScope(current);

    await updateTransfer("t1", valuesWith(current, ""));
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(getStatusByRecordSpy).not.toHaveBeenCalled();
    const data = manualLinkSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(data.recordId).toBeNull();
    expect(data.acatTransferId).toBeNull();
    // writeAudit JSON.stringify's the detail — parse it back for exact {from,to}.
    const call = tx.auditLog.create.mock.calls[0][0] as { data: { detail: string } };
    const { changes } = JSON.parse(call.data.detail) as {
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(changes.acat_record_id).toEqual({ from: CUID, to: null });
    expect(changes.acat_transfer_id).toEqual({ from: UUID, to: null });
  });

  it("a lost duplicate-link race (P2002) → the friendly 'already linked' error", async () => {
    const current = row();
    wireScope(current);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: null });
    manualLinkSpy.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const res = await updateTransfer("t1", valuesWith(current, CUID));
    expect(res).toEqual({
      ok: false,
      errors: [LINK_ERRORS.ACAT_ALREADY_LINKED],
    });
  });
});

describe("updateTransfer — stage gate parity", () => {
  const ready = {
    stage: "DECISION" as const,
    accounts_opened_at_apex: true,
    funding_plan_complete: true,
    funding_plan_version: 2,
    funding_initiated: true,
    funding_type: "ACAT_FULL" as const,
    acat_transfer_id: UUID,
  };

  it("rejects unresolved linked exceptions before any form fields or audits are written", async () => {
    const current = row(ready);
    wireScope(current);
    tx.transfer.findUnique.mockResolvedValue({
      ...current, tasks: [],
      decision_cases: [{ id: "case-1", question: "Confirm the source registration" }],
    });

    const result = await updateTransfer("t1", valuesWith(current, UUID, {
      stage: "IN_TRANSFER", next_step: "Do not persist this blocked edit",
    }));

    expect(result).toEqual({ ok: false, errors: [{
      field: "stage", message: "Resolve Decision Center item: Confirm the source registration",
    }] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("applies the visible checklist gate to edit-form forward moves", async () => {
    const current = row({ stage: "IN_TRANSFER", funding_plan_complete: true, funding_plan_version: 1 });
    wireScope(current);
    checklistFlagSpy.mockReturnValue(true);
    const task = { title: DEFAULT_TASKS.IN_TRANSFER[0], done: false, override_done: null, sort_order: 0 };
    tx.transfer.findUnique.mockResolvedValue({ ...current, tasks: [task] });

    const result = await updateTransfer("t1", valuesWith(current, "", { stage: "FUNDED" }));

    expect(result).toEqual({ ok: false, errors: [{ field: "stage", message: task.title }] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferTask.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("applies the existing readiness gate when the redesign flag is on", async () => {
    const current = row({ stage: "DECISION" });
    wireScope(current);
    redesignFlagSpy.mockReturnValue(true);

    const result = await updateTransfer("t1", valuesWith(current, "", { stage: "IN_TRANSFER" }));

    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([
      { field: "stage", message: "Approve the current funding plan before advancing." },
    ]) });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("evaluates the proposed unlink instead of letting the old ACAT satisfy the gate", async () => {
    const current = row(ready);
    wireScope(current);
    redesignFlagSpy.mockReturnValue(true);

    const result = await updateTransfer("t1", valuesWith(current, "", { stage: "IN_TRANSFER" }));

    expect(result).toMatchObject({ ok: false, errors: [expect.objectContaining({ field: "stage" })] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("accepts a verified new link and stage together when all existing gates pass", async () => {
    const current = row({ ...ready, acat_transfer_id: null });
    wireScope(current);
    redesignFlagSpy.mockReturnValue(true);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: UUID });

    expect(await updateTransfer("t1", valuesWith(current, CUID, { stage: "IN_TRANSFER" }))).toBeUndefined();
    expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "IN_TRANSFER" }),
    }));
    expect(manualLinkSpy).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({ recordId: CUID, acatTransferId: UUID }));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("retains backward movement and permits non-stage edits without invalidating approval", async () => {
    const current = row({ ...ready, stage: "IN_TRANSFER" });
    wireScope(current);
    redesignFlagSpy.mockReturnValue(true);
    checklistFlagSpy.mockReturnValue(true);

    expect(await updateTransfer("t1", valuesWith(current, UUID, { stage: "DECISION" }))).toBeUndefined();
    const data = tx.transfer.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("funding_plan_complete");
    expect(data).not.toHaveProperty("funding_plan_version");
    expect(tx.transferTask.createMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a link changed during external tracker verification", async () => {
    const current = row();
    wireScope(current);
    tx.transfer.findUnique
      .mockResolvedValueOnce({ acat_record_id: null, acat_transfer_id: null })
      .mockResolvedValueOnce({ ...current, acat_record_id: "another-record", tasks: [] });
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: UUID });

    expect(await updateTransfer("t1", valuesWith(current, CUID))).toMatchObject({
      ok: false, errors: [{ field: "acat_transfer_id", message: expect.stringMatching(/changed while you were editing/i) }],
    });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("createTransfer — either-id ACAT routing", () => {
  it("rolls back create when the guarded link is rejected and returns its field error", async () => {
    const seed = row();
    wireScope(seed);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: UUID });
    manualLinkSpy.mockResolvedValue({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    const committed = vi.fn();
    withUserScopeSpy.mockImplementation(async (_identity, callback) => { const value = await callback(tx); committed(); return value; });
    expect(await createTransfer(valuesWith(seed, CUID))).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(committed).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(signalSpy).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("verifies a record-id value and creates with BOTH resolved columns", async () => {
    const seed = row();
    wireScope(seed);
    getStatusByRecordSpy.mockResolvedValue({ acatTransferId: UUID });

    const res = await createTransfer(valuesWith(seed, CUID));
    expect(res).toBeUndefined();
    expect(getStatusByRecordSpy).toHaveBeenCalledWith(CUID);
    const data = tx.transfer.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("acat_record_id");
    expect(data).not.toHaveProperty("acat_transfer_id");
    expect(manualLinkSpy).toHaveBeenCalledWith(tx, expect.anything(), {
      transferId: "new-1", expectedVersion: 0, expectedRecordId: null, expectedTransferUuid: null,
      recordId: CUID, acatTransferId: UUID,
    });
    expect(signalSpy).toHaveBeenCalledWith("transfer_action");
    expect(redirectSpy).toHaveBeenCalledWith("/asset-transfer/new-1");
  });

  it("404 on create → field error, no row", async () => {
    const seed = row();
    wireScope(seed);
    getStatusByRecordSpy.mockResolvedValue(null);

    const res = await createTransfer(valuesWith(seed, "rec-nope"));
    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_NOT_FOUND] });
    expect(tx.transfer.create).not.toHaveBeenCalled();
    expect(signalSpy).not.toHaveBeenCalled();
  });

  it("blank ACAT field → no tracker call, both columns null", async () => {
    const seed = row();
    wireScope(seed);

    await createTransfer(valuesWith(seed, ""));
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(getStatusByRecordSpy).not.toHaveBeenCalled();
    const data = tx.transfer.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("acat_record_id");
    expect(data).not.toHaveProperty("acat_transfer_id");
    expect(manualLinkSpy).not.toHaveBeenCalled();
  });

  it("does not signal when the create transaction rejects", async () => {
    const seed = row();
    wireScope(seed);
    tx.transfer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const res = await createTransfer(valuesWith(seed, ""));

    expect(res).toEqual({ ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] });
    expect(signalSpy).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
