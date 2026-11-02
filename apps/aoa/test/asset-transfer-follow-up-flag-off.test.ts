import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: vi.fn() }));

import { recordAcatRejection } from "@/lib/transfers/follow-up";
import { confirmArrival, UNRESOLVED_RECEIPT } from "@/lib/transfers/receipt";
import type { Identity } from "@/lib/rls";
import type { Prisma } from "@prisma/client";

const SUITE = "asset-transfer-follow-up-flag-off";
const identity = { email: "follow-up@example.invalid", role: "OPERATIONS" } as Identity;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ATW-09 with the flag off", () => {
  it("inserts no rejection and leaves confirmArrival unchanged", async () => {
    markCase(SUITE, "flag-off-no-insert");
    const tx = {
      transferSubmission: { findFirst: vi.fn(async () => ({ id: "submission-synthetic", created_at: new Date() })) },
      transferAcatRejection: {
        findFirst: vi.fn(async () => ({
          id: "rejection-synthetic", arrival_paused: true, awaiting_operations_review: false,
          response: null, created_at: new Date(Date.now() + 60_000),
        })),
        create: vi.fn(),
      },
      transferTrackingUpdate: { create: vi.fn() },
      transferReceipt: { findFirst: vi.fn(async () => null), create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const asTx = tx as unknown as Prisma.TransactionClient;
    const rejected = await recordAcatRejection(asTx, identity,
      { id: "follow-up-synthetic", funding_type: "ACAT_FULL", archived_at: null }, { followUpOwner: "TEST OWNER" }, false);
    expect(rejected.ok).toBe(false);
    expect(tx.transferAcatRejection.create).not.toHaveBeenCalled();

    const arrival = await confirmArrival(asTx, identity, {
      id: "follow-up-synthetic", stage: "IN_TRANSFER", funding_type: "ACAT_FULL",
      funding_plan_approved_at: new Date("2026-10-01T12:00:00Z"), archived_at: null,
    }, {
      partial: false,
      lines: [{ classification: "mismatched", quantity: 1, lineStatus: "outstanding", variancePercentage: null, reviewNote: "", explanation: "" }],
      nextAction: "", followUpOwner: "", nextCheckOn: "",
    }, false);
    expect(arrival.ok).toBe(false);
    expect(JSON.stringify(arrival)).not.toContain(UNRESOLVED_RECEIPT);
    expect(tx.transferAcatRejection.findFirst).not.toHaveBeenCalled();
    expect(tx.transferReceipt.create).not.toHaveBeenCalled();
  });
});
