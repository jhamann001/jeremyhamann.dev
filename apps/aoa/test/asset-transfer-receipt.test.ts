import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), redirect: vi.fn(), workspaceFlag: vi.fn(), paperworkFlag: vi.fn(),
  detail: vi.fn(), partial: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: spies.redirect }));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: spies.workspaceFlag,
  paperworkRecordsEnabled: spies.paperworkFlag,
}));
vi.mock("@/lib/data/transfer-asset-map", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAssignedAssetMapDetail: spies.detail,
  getPartialAcatPositions: spies.partial,
}));

import { applyReceiptComparison, logTransferSubmission } from "@/app/(authenticated)/asset-transfer/actions";
import {
  confirmArrival,
  logOperationsSubmission,
  saveTrackingUpdate,
  SUBMISSION_REQUIRES_APPROVAL,
  UNRESOLVED_RECEIPT,
  type ReceiptLineInput,
  type ReceiptTransfer,
} from "@/lib/transfers/receipt";
import type { Identity } from "@/lib/rls";
import type { Prisma } from "@prisma/client";

const SUITE = "asset-transfer-receipt";
const identity: Identity = { email: "receipt@example.invalid", role: "OPERATIONS" } as Identity;

function transfer(overrides: Partial<ReceiptTransfer> = {}): ReceiptTransfer {
  return {
    id: "receipt-synthetic",
    stage: "IN_TRANSFER",
    funding_type: "ACAT_FULL",
    funding_plan_approved_at: new Date("2026-10-01T12:00:00Z"),
    archived_at: null,
    ...overrides,
  };
}

function fakeTx(options: { latestVersion?: number | null; submitted?: boolean } = {}) {
  const create = () => vi.fn(async () => ({ id: "row-synthetic" }));
  const tx = {
    transfer: {
      findUnique: vi.fn(async () => ({
        ...transfer(),
        asset_map_folder_id: "folder-synthetic",
        asset_map_custodian: "TEST CUSTODIAN",
        asset_map_account_number: null,
        asset_map_account_type: null,
        decisions: [],
      })),
      update: vi.fn(),
    },
    transferSubmission: {
      findFirst: vi.fn(async () => (options.submitted === false ? null : { id: "submission-synthetic" })),
      create: create(),
    },
    transferTrackingUpdate: { create: create() },
    transferReceipt: {
      findFirst: vi.fn(async () => (options.latestVersion ? { version: options.latestVersion } : null)),
      create: create(),
    },
    transferAppAuthorization: { findFirst: vi.fn(async () => null) },
    transferAcatRejection: { findFirst: vi.fn(async () => null) },
    transferSentPacket: { findFirst: vi.fn(async () => null) },
    transferReturnedSignature: { findFirst: vi.fn(async () => ({ id: "signature-synthetic" })) },
    transferMailedPaperwork: { findFirst: vi.fn(async () => null) },
    transferDrsServiceRequest: { findFirst: vi.fn(async () => null) },
    transferFormReview: { findFirst: vi.fn(async () => null) },
    transferStatement: { findFirst: vi.fn(async () => ({ accepted: true })) },
    transferAccountMatch: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
  };
  return tx;
}

const asTx = (tx: ReturnType<typeof fakeTx>) => tx as unknown as Prisma.TransactionClient;

function line(overrides: Partial<ReceiptLineInput> = {}): ReceiptLineInput {
  return {
    classification: "matched",
    quantity: 10,
    lineStatus: "verified",
    variancePercentage: 0,
    reviewNote: "",
    explanation: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.workspaceFlag.mockReturnValue(true);
  spies.paperworkFlag.mockReturnValue(true);
  spies.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "receipt@example.invalid" } });
});

describe("ATW-06 submission, tracking and receipt", () => {
  it("applies a comparison without inserting a receipt (AC-49, AC-79)", async () => {
    markCase(SUITE, "apply-inserts-nothing");
    const tx = fakeTx();
    spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
    spies.detail.mockResolvedValue({
      positions: [
        { symbol: "TESTA", quantity: 10 },
        { symbol: "TESTB", quantity: 5 },
      ],
    });
    const result = await applyReceiptComparison("receipt-synthetic", "Symbol,Quantity\nTESTA,10\nTESTB,4\nTESTC,1\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((row) => row.classification)).toEqual(["matched", "mismatched", "unexpected"]);
    expect(result.lines[1].variancePercentage).toBe(-20);
    expect(tx.transferReceipt.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses All expected assets verified while a line is unresolved (AC-50)", async () => {
    markCase(SUITE, "unresolved-refuses-arrived");
    const tx = fakeTx();
    const result = await confirmArrival(asTx(tx), identity, transfer(), {
      partial: false,
      lines: [line(), line({ classification: "unexpected", lineStatus: "verified", explanation: "" })],
      nextAction: "", followUpOwner: "", nextCheckOn: "",
    }, true);
    expect(result).toEqual({ ok: false, errors: [{ field: "lines", message: UNRESOLVED_RECEIPT }] });
    expect(tx.transferReceipt.create).not.toHaveBeenCalled();
  });

  it("records a tracking update without changing the stage (AC-48)", async () => {
    markCase(SUITE, "tracking-does-not-fund");
    const tx = fakeTx();
    const result = await saveTrackingUpdate(asTx(tx), identity, transfer(), {
      trackingStage: "Pending review at delivering firm", expectedCompletionOn: "2026-11-10",
    }, true);
    expect(result.ok).toBe(true);
    expect(tx.transferTrackingUpdate.create).toHaveBeenCalledTimes(1);
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("saves a verified receipt as a new version and keeps the prior one (AC-53, AC-80)", async () => {
    markCase(SUITE, "verified-save-keeps-prior-version");
    const tx = fakeTx({ latestVersion: 1 });
    const result = await confirmArrival(asTx(tx), identity, transfer(), {
      partial: false,
      lines: [line(), line({ classification: "mismatched", quantity: 9, variancePercentage: -10, explanation: "Fractional share paid as cash" })],
      nextAction: "", followUpOwner: "", nextCheckOn: "",
    }, true);
    expect(result).toEqual({ ok: true, id: "row-synthetic", version: 2, funded: true });
    const data = (tx.transferReceipt.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.version).toBe(2);
    expect(data.partial).toBe(false);
    expect(Object.keys(tx.transferReceipt)).not.toContain("update");
  });

  it("refuses a submission without an approved funding plan (AC-47)", async () => {
    markCase(SUITE, "submission-blocked-without-approval");
    const tx = fakeTx();
    const result = await logOperationsSubmission(asTx(tx), identity, transfer({ stage: "DECISION", funding_plan_approved_at: null }), {
      controlNumber: "TESTCONTROL1", submittedOn: "2026-10-20",
    }, true);
    expect(result).toEqual({ ok: false, errors: [{ field: "form", message: SUBMISSION_REQUIRES_APPROVAL }] });
    expect(tx.transferSubmission.create).not.toHaveBeenCalled();
  });

  it("inserts nothing with the flag off", async () => {
    markCase(SUITE, "flag-off-no-insert");
    const tx = fakeTx();
    spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
    spies.paperworkFlag.mockReturnValue(false);
    const viaAction = await logTransferSubmission("receipt-synthetic", { controlNumber: "TESTCONTROL1", submittedOn: "2026-10-20" });
    expect(viaAction.ok).toBe(false);
    const direct = await logOperationsSubmission(asTx(tx), identity, transfer({ stage: "DECISION" }), {
      controlNumber: "TESTCONTROL1", submittedOn: "2026-10-20",
    }, false);
    expect(direct.ok).toBe(false);
    expect(spies.scope).not.toHaveBeenCalled();
    expect(tx.transferSubmission.create).not.toHaveBeenCalled();
  });
});
