import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));

import {
  ARRIVAL_PAUSED,
  recordAcatRejection,
  recordFeeReimbursement,
  recordResidual,
  rejectionBlocksFunded,
  type FollowUpTransfer,
} from "@/lib/transfers/follow-up";
import { confirmArrival } from "@/lib/transfers/receipt";
import type { Identity } from "@/lib/rls";
import type { Prisma } from "@prisma/client";

const SUITE = "asset-transfer-follow-up";
const identity = { email: "follow-up@example.invalid", role: "OPERATIONS" } as Identity;
const transfer: FollowUpTransfer = { id: "follow-up-synthetic", funding_type: "ACAT_FULL", archived_at: null };

function fakeTx() {
  const rejections: Record<string, unknown>[] = [];
  const submittedAt = new Date("2026-10-20T12:00:00Z");
  const tx = {
    transfer: { update: vi.fn(), updateMany: vi.fn() },
    transferSubmission: {
      findFirst: vi.fn(async (args: { where: { control_number?: string } }) =>
        args.where.control_number == null || args.where.control_number === "TESTCONTROL1"
          ? { id: "submission-synthetic", created_at: submittedAt }
          : null),
      create: vi.fn(),
    },
    transferResidual: { create: vi.fn(async () => ({ id: "residual-synthetic" })) },
    transferFeeReimbursement: { create: vi.fn(async () => ({ id: "fee-synthetic" })) },
    transferTrackingUpdate: { create: vi.fn(async () => ({ id: "tracking-synthetic" })) },
    transferAcatRejection: {
      findFirst: vi.fn(async () => rejections[rejections.length - 1] ?? null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        rejections.push({
          id: "rejection-synthetic",
          awaiting_operations_review: false,
          response: null,
          created_at: new Date(submittedAt.getTime() + 60_000),
          ...args.data,
        });
        return { id: "rejection-synthetic" };
      }),
    },
    transferReceipt: { findFirst: vi.fn(async () => null), create: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return tx;
}

const asTx = (tx: ReturnType<typeof fakeTx>) => tx as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ATW-09 follow-up, residual and rejection", () => {
  it("keeps the residual tied to the original control number without touching the transfer (AC-65, AC-101)", async () => {
    markCase(SUITE, "residual-keeps-control-number");
    const tx = fakeTx();
    const result = await recordResidual(asTx(tx), identity, transfer, {
      originalControlNumber: "TESTCONTROL1", trackerStage: "Residual pending",
    }, true);
    expect(result).toEqual({ ok: true, id: "residual-synthetic" });
    expect(tx.transferResidual.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ original_control_number: "TESTCONTROL1", tracker_stage: "Residual pending" }),
    }));
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transfer.updateMany).not.toHaveBeenCalled();
    expect(tx.transferReceipt.create).not.toHaveBeenCalled();
  });

  it("pauses arrival confirmation after a rejection (AC-67, AC-82, AC-83)", async () => {
    markCase(SUITE, "rejection-pauses-confirm-arrival");
    const tx = fakeTx();
    const rejected = await recordAcatRejection(asTx(tx), identity, transfer, {
      followUpOwner: "TEST OWNER", reason: "Title mismatch", code: "TEST-01", rejectedOn: "2026-10-20",
    }, true, "2026-10-21");
    expect(rejected.ok).toBe(true);
    expect(tx.transferAcatRejection.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        arrival_paused: true, completion_estimate: null,
        reason: "Title mismatch", code: "TEST-01", rejected_on: new Date("2026-10-20T00:00:00.000Z"),
      }),
    }));
    const arrival = await confirmArrival(asTx(tx), identity, {
      id: transfer.id,
      stage: "IN_TRANSFER",
      funding_type: "ACAT_FULL",
      funding_plan_approved_at: new Date("2026-10-01T12:00:00Z"),
      archived_at: null,
    }, {
      partial: false,
      lines: [{ classification: "matched", quantity: 1, lineStatus: "verified", variancePercentage: 0, reviewNote: "", explanation: "" }],
      nextAction: "", followUpOwner: "", nextCheckOn: "",
    }, true);
    expect(arrival).toEqual({ ok: false, errors: [{ field: "form", message: ARRIVAL_PAUSED }] });
    expect(tx.transferReceipt.create).not.toHaveBeenCalled();
  });

  it("requires the rejection date and reason and keeps the code optional", async () => {
    markCase(SUITE, "rejection-date-reason-code");
    const tx = fakeTx();
    const missing = await recordAcatRejection(asTx(tx), identity, transfer, { followUpOwner: "TEST OWNER" }, true, "2026-10-21");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.map(error => error.field)).toEqual(["reason"]);
    const undated = await recordAcatRejection(asTx(tx), identity, transfer, { followUpOwner: "TEST OWNER", reason: "Title mismatch" }, true, "2026-10-21");
    expect(undated.ok ? [] : undated.errors.map(error => error.field)).toEqual(["rejectedOn"]);
    const future = await recordAcatRejection(asTx(tx), identity, transfer, {
      followUpOwner: "TEST OWNER", reason: "Title mismatch", rejectedOn: "2026-10-22",
    }, true, "2026-10-21");
    expect(future.ok).toBe(false);
    const tooLong = await recordAcatRejection(asTx(tx), identity, transfer, {
      followUpOwner: "TEST OWNER", reason: "x".repeat(1001), rejectedOn: "2026-10-20",
    }, true, "2026-10-21");
    expect(tooLong.ok).toBe(false);
    expect(tx.transferAcatRejection.create).not.toHaveBeenCalled();
    const noCode = await recordAcatRejection(asTx(tx), identity, transfer, {
      followUpOwner: "TEST OWNER", reason: "Title mismatch", code: "  ", rejectedOn: "2026-10-21",
    }, true, "2026-10-21");
    expect(noCode.ok).toBe(true);
    expect(tx.transferAcatRejection.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ code: null }) }));
  });

  it("requires an evidenced fee for a reimbursement (AC-62)", async () => {
    markCase(SUITE, "reimbursement-requires-evidenced");
    const tx = fakeTx();
    const refused = await recordFeeReimbursement(asTx(tx), identity, transfer, { evidenced: false }, true);
    expect(refused.ok).toBe(false);
    expect(tx.transferFeeReimbursement.create).not.toHaveBeenCalled();
    const recorded = await recordFeeReimbursement(asTx(tx), identity, transfer, { evidenced: true }, true);
    expect(recorded).toEqual({ ok: true, id: "fee-synthetic" });
  });

  it("blocks Funded after an accepted rejection while the plan is unapproved (AC-84)", () => {
    markCase(SUITE, "rejection-blocks-funded");
    const accepted = {
      id: "rejection-synthetic", arrival_paused: true, awaiting_operations_review: false,
      response: "Client re-signed", created_at: new Date("2026-10-21T12:00:00Z"),
    };
    expect(rejectionBlocksFunded(true, accepted, null)).toBe(true);
    expect(rejectionBlocksFunded(true, accepted, new Date("2026-10-22T12:00:00Z"))).toBe(false);
    expect(rejectionBlocksFunded(true, { ...accepted, awaiting_operations_review: true }, null)).toBe(false);
    expect(rejectionBlocksFunded(false, accepted, null)).toBe(false);
  });
});
