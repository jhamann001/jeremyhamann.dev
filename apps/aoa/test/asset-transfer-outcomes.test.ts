import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { authSpy, withUserScopeSpy, workspaceSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  workspaceSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  transferDealSourcedRedesignEnabled: () => false,
  checklistStageGateEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: workspaceSpy,
  paperworkRecordsEnabled: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import {
  addTask,
  setCashInFlight,
  setChecklistFlag,
  setStage,
  toggleTask,
} from "@/app/(authenticated)/asset-transfer/actions";
import { DECLINE_AFTER_INITIATION, PREPARATION_PAUSED, recordOutcome } from "@/lib/transfers/outcomes";
import type { Identity } from "@/lib/rls";
import type { Prisma } from "@prisma/client";

const SUITE = "asset-transfer-outcomes";
const identity = { email: "outcomes@example.invalid", role: "OPERATIONS" } as Identity;
const UNAPPROVED = "Approve the current funding plan before advancing.";

function transferRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "outcome-synthetic",
    stage: "DECISION",
    archived_at: null,
    accounts_opened_at_apex: false,
    funding_plan_complete: false,
    funding_plan_version: 0,
    funding_plan_approved_at: null,
    funding_initiated: false,
    cash_in_flight: false,
    funding_type: null,
    acat_transfer_id: null,
    acat_record_id: null,
    funding_route_change_pending: false,
    drs_method_change_pending: false,
    tasks: [],
    decisions: [],
    accounts: [],
    decision_cases: [],
    ...overrides,
  };
}

function fakeTx(row: Record<string, unknown>, latestOutcome: Record<string, unknown> | null) {
  return {
    $queryRaw: vi.fn(async () => [{ id: row.id }]),
    transfer: { findUnique: vi.fn(async () => row), update: vi.fn(async () => ({})) },
    transferTask: {
      findUnique: vi.fn(async () => ({ id: "task-synthetic", transfer_id: row.id, title: "Synthetic task" })),
      update: vi.fn(),
      create: vi.fn(async () => ({ id: "task-new" })),
      createMany: vi.fn(),
    },
    transferOutcome: {
      findFirst: vi.fn(async () => latestOutcome),
      create: vi.fn(async () => ({ id: "outcome-row" })),
      update: vi.fn(),
    },
    transferStageChange: { create: vi.fn(async () => ({ id: "stage-change-row" })) },
    transferSubmission: { findFirst: vi.fn(async () => null) },
    transferReceipt: { findFirst: vi.fn(async () => null) },
    transferAcatRejection: { findFirst: vi.fn(async () => null) },
    deal: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
}

let tx: ReturnType<typeof fakeTx>;

function useTx(next: ReturnType<typeof fakeTx>) {
  tx = next;
  withUserScopeSpy.mockImplementation(async (_identity: unknown, fn: (t: typeof tx) => unknown) => fn(tx));
}

const asTx = (value: ReturnType<typeof fakeTx>) => value as unknown as Prisma.TransactionClient;

beforeEach(() => {
  authSpy.mockResolvedValue({ user: { email: "ops@example.com", role: "OPERATIONS" } });
  workspaceSpy.mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

describe("ATW-10 outcomes, history and unbound stage changes", () => {
  it("refuses Client declined once a submission exists (AC-72, AC-103)", async () => {
    const local = fakeTx(transferRow({ stage: "IN_TRANSFER" }), null);
    local.transferSubmission.findFirst.mockResolvedValue({ id: "submission-synthetic" } as never);
    const result = await recordOutcome(asTx(local), identity, { id: "outcome-synthetic", archived_at: null }, {
      outcome: "Client declined", reason: "Client changed their mind", followUpOn: "", outcomeOn: "2026-10-20",
    }, true);
    expect(result).toEqual({ ok: false, errors: [{ field: "outcome", message: DECLINE_AFTER_INITIATION }] });
    expect(local.transferOutcome.create).not.toHaveBeenCalled();
    markCase(SUITE, "decline-after-submission-refused");
  });

  it("requires an outcome date that is not in the future and stores it", async () => {
    const local = fakeTx(transferRow(), null);
    const transfer = { id: "outcome-synthetic", archived_at: null };
    const base = { outcome: "Canceled", reason: "Client asked to stop", followUpOn: "" };
    const missing = await recordOutcome(asTx(local), identity, transfer, { ...base, outcomeOn: "" }, true, "2026-10-21");
    expect(missing).toEqual({ ok: false, errors: [{ field: "outcomeOn", message: "Enter the outcome date." }] });
    const future = await recordOutcome(asTx(local), identity, transfer, { ...base, outcomeOn: "2026-10-22" }, true, "2026-10-21");
    expect(future).toEqual({ ok: false, errors: [{ field: "outcomeOn", message: "The outcome date cannot be in the future." }] });
    expect(local.transferOutcome.create).not.toHaveBeenCalled();
    const saved = await recordOutcome(asTx(local), identity, transfer, { ...base, outcomeOn: "2026-10-21" }, true, "2026-10-21");
    expect(saved.ok).toBe(true);
    expect(local.transferOutcome.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome_on: new Date("2026-10-21T00:00:00.000Z") }),
    }));
  });

  it("stores the deferral follow-up date and pauses preparation and stage moves (AC-73, AC-76, AC-105)", async () => {
    const local = fakeTx(transferRow(), null);
    const deferred = await recordOutcome(asTx(local), identity, { id: "outcome-synthetic", archived_at: null }, {
      outcome: "Deferred", reason: "Client is travelling", followUpOn: "2026-12-01", outcomeOn: "2026-10-20",
    }, true);
    expect(deferred.ok).toBe(true);
    expect(local.transferOutcome.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        outcome: "Deferred",
        follow_up_on: new Date("2026-12-01T00:00:00.000Z"),
      }),
    }));

    useTx(fakeTx(transferRow(), { id: "outcome-row", outcome: "Deferred", resumed: false }));
    const paused = { ok: false, errors: [{ field: "form", message: PREPARATION_PAUSED }] };
    expect(await toggleTask("outcome-synthetic", "task-synthetic", true)).toEqual(paused);
    expect(await addTask("outcome-synthetic", "Synthetic follow-up")).toEqual(paused);
    expect(await setChecklistFlag("outcome-synthetic", "accounts_opened_at_apex", true)).toEqual(paused);
    expect(await setCashInFlight("outcome-synthetic", true)).toEqual(paused);
    expect(tx.transferTask.update).not.toHaveBeenCalled();
    expect(tx.transferTask.create).not.toHaveBeenCalled();
    expect(tx.transfer.update).not.toHaveBeenCalled();

    const moved = await setStage("outcome-synthetic", "IN_TRANSFER");
    expect(moved).toEqual({ ok: false, blocked: true, unmet: [PREPARATION_PAUSED] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferStageChange.create).not.toHaveBeenCalled();
    markCase(SUITE, "deferred-stores-follow-up");
  });

  it("saves an unbound stage change with a warning and records both stages (AC-92..AC-94)", async () => {
    useTx(fakeTx(transferRow(), null));
    const moved = await setStage("outcome-synthetic", "IN_TRANSFER");
    expect(moved.ok).toBe(true);
    expect(moved).toMatchObject({ warnings: expect.arrayContaining([UNAPPROVED]) });
    expect(tx.transfer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: "IN_TRANSFER" }),
    }));
    expect(tx.transferStageChange.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { transfer_id: "outcome-synthetic", previous_stage: "DECISION", new_stage: "IN_TRANSFER" },
    }));

    useTx(fakeTx(transferRow({ stage: "IN_TRANSFER", funding_type: "ACAT_FULL" }), null));
    const funded = await setStage("outcome-synthetic", "FUNDED");
    expect(funded).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferStageChange.create).not.toHaveBeenCalled();
    markCase(SUITE, "unbound-stage-saves-and-records");
  });

  it("keeps the funding-plan gate hard and records no stage row with the flag off", async () => {
    workspaceSpy.mockReturnValue(false);
    useTx(fakeTx(transferRow(), null));
    const moved = await setStage("outcome-synthetic", "IN_TRANSFER");
    expect(moved).toEqual({ ok: false, blocked: true, unmet: [UNAPPROVED] });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.transferStageChange.create).not.toHaveBeenCalled();
    expect(tx.transferOutcome.findFirst).not.toHaveBeenCalled();
    markCase(SUITE, "flag-off-no-stage-row");
  });
});
