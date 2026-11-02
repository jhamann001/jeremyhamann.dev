import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));

import {
  AUTOMATIC_SUBMISSION_PENDING,
  awaitingAutomaticSubmission,
  recordAchInitiation,
  recordCheckTicket,
  type ChannelTransfer,
} from "@/lib/transfers/channels";
import { logOperationsSubmission } from "@/lib/transfers/receipt";
import type { Identity } from "@/lib/rls";
import type { Prisma } from "@prisma/client";

const SUITE = "asset-transfer-channels";
const identity = { email: "channels@example.invalid", role: "CLIENT_SERVICE" } as Identity;

function transfer(overrides: Partial<ChannelTransfer> = {}): ChannelTransfer {
  return { id: "channels-synthetic", stage: "DECISION", funding_type: "CHECK", archived_at: null, ...overrides };
}

function fakeTx(options: { appAuthorization?: boolean; submission?: boolean } = {}) {
  const create = () => vi.fn(async () => ({ id: "row-synthetic" }));
  return {
    transfer: { update: vi.fn(async () => ({})) },
    transferCheckTicket: { create: create() },
    transferAchInitiation: { create: create() },
    transferReceipt: { create: create() },
    transferSubmission: {
      findFirst: vi.fn(async () => (options.submission ? { id: "submission-synthetic" } : null)),
      create: create(),
    },
    transferReturnedSignature: { create: create() },
    transferTask: { create: create(), createMany: create() },
    transferAppAuthorization: {
      findFirst: vi.fn(async () => (options.appAuthorization ? { id: "app-synthetic" } : null)),
    },
    transferAcatRejection: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

const asTx = (tx: ReturnType<typeof fakeTx>) => tx as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ATW-07 check, ACH and linked account", () => {
  it("records a check ticket without inserting a receipt (AC-55, AC-56, AC-100)", async () => {
    markCase(SUITE, "ticket-inserts-no-receipt");
    const tx = fakeTx();
    const result = await recordCheckTicket(asTx(tx), identity, transfer(), {
      withClient: true, mailerSent: true, checkMailed: false, optionalCall: true,
    }, true);
    expect(result).toEqual({ ok: true, id: "row-synthetic" });
    const data = (tx.transferCheckTicket.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ location: "client", mailer_sent: true, check_mailed: false, optional_call: true });
    expect(tx.transferReceipt.create).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("sets In transfer from an ACH initiation with no submission or task (AC-57, AC-58)", async () => {
    markCase(SUITE, "ach-sets-in-transfer-without-submission");
    const tx = fakeTx();
    const result = await recordAchInitiation(asTx(tx), identity, transfer({ funding_type: "ACH" }), {
      instructionsSent: true, clientInitiationOn: "2026-10-20",
    }, true);
    expect(result.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "IN_TRANSFER" }),
    }));
    expect(JSON.stringify(tx.transfer.update.mock.calls)).not.toContain("FUNDED");
    expect(tx.transferSubmission.create).not.toHaveBeenCalled();
    expect(tx.transferReturnedSignature.create).not.toHaveBeenCalled();
    expect(tx.transferTask.create).not.toHaveBeenCalled();
    expect(tx.transferTask.createMany).not.toHaveBeenCalled();
  });

  it("leaves a linked account unsubmitted until a submission record exists (AC-59)", async () => {
    markCase(SUITE, "linked-account-stays-unsubmitted");
    expect(awaitingAutomaticSubmission({
      fundingType: "ACAT_FULL", appAuthorizationRecorded: true, submissionRecorded: false,
    })).toBe(true);
    expect(awaitingAutomaticSubmission({
      fundingType: "ACAT_FULL", appAuthorizationRecorded: true, submissionRecorded: true,
    })).toBe(false);
    expect(awaitingAutomaticSubmission({
      fundingType: "ACAT_FULL", appAuthorizationRecorded: false, submissionRecorded: false,
    })).toBe(false);
  });

  it("refuses an Operations submission while the automatic submission is pending (AC-60)", async () => {
    markCase(SUITE, "operations-submission-refused");
    const tx = fakeTx({ appAuthorization: true, submission: false });
    const result = await logOperationsSubmission(asTx(tx), identity, {
      id: "channels-synthetic",
      stage: "DECISION",
      funding_type: "ACAT_FULL",
      funding_plan_approved_at: new Date("2026-10-01T12:00:00Z"),
      archived_at: null,
    }, { controlNumber: "TESTCONTROL1", submittedOn: "2026-10-20" }, true);
    expect(result).toEqual({ ok: false, errors: [{ field: "form", message: AUTOMATIC_SUBMISSION_PENDING }] });
    expect(tx.transferSubmission.create).not.toHaveBeenCalled();
  });
});
