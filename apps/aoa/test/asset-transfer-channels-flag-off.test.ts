import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const spies = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), workspaceFlag: vi.fn(), paperworkFlag: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/slack/closeout-webhook", () => ({ postCloseoutWebhook: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assetTransferWorkspaceEnabled: spies.workspaceFlag,
  paperworkRecordsEnabled: spies.paperworkFlag,
}));

import { saveAchInitiation, saveCheckTicket } from "@/app/(authenticated)/asset-transfer/actions";
import { automaticSubmissionRefused, recordCheckTicket } from "@/lib/transfers/channels";
import type { Identity } from "@/lib/rls";
import type { Prisma } from "@prisma/client";

const SUITE = "asset-transfer-channels-flag-off";

beforeEach(() => {
  vi.clearAllMocks();
  spies.workspaceFlag.mockReturnValue(true);
  spies.paperworkFlag.mockReturnValue(false);
  spies.auth.mockResolvedValue({ user: { role: "CLIENT_SERVICE", email: "channels@example.invalid" } });
});

describe("ATW-07 with the flag off", () => {
  it("inserts no check ticket and does not set In transfer", async () => {
    markCase(SUITE, "flag-off-no-insert");
    const tx = {
      transfer: { update: vi.fn() },
      transferCheckTicket: { create: vi.fn() },
      transferAchInitiation: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    spies.scope.mockImplementation(async (_identity, fn) => fn(tx));
    expect((await saveCheckTicket("channels-synthetic", {
      withClient: true, mailerSent: true, checkMailed: true, optionalCall: false,
    })).ok).toBe(false);
    expect((await saveAchInitiation("channels-synthetic", {
      instructionsSent: true, clientInitiationOn: "2026-10-20",
    })).ok).toBe(false);
    const direct = await recordCheckTicket(tx as unknown as Prisma.TransactionClient,
      { email: "channels@example.invalid", role: "CLIENT_SERVICE" } as Identity,
      { id: "channels-synthetic", stage: "DECISION", funding_type: "CHECK", archived_at: null },
      { withClient: false, mailerSent: false, checkMailed: false, optionalCall: false }, false);
    expect(direct.ok).toBe(false);
    expect(automaticSubmissionRefused(false, {
      fundingType: "ACH", appAuthorizationRecorded: false, submissionRecorded: false,
    })).toBe(false);
    expect(spies.scope).not.toHaveBeenCalled();
    expect(tx.transferCheckTicket.create).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });
});
