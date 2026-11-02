import { describe, expect, it, vi } from "vitest";
import {
  PARTIAL_ACAT_EXECUTION_TASKS,
  buildPartialAcatDecisionSnapshot,
  partialPositionsFromFundingPlanSnapshot,
  syncPartialAcatExecutionTasks,
} from "@/lib/data/decision-case-workflow";

const identity = { role: "OPERATIONS", email: "ops@example.com" };

describe("partial-ACAT workflow materialization", () => {
  it("freezes rich position facts only for a deliberately escalated exception", () => {
    const positions = partialPositionsFromFundingPlanSnapshot({
      positions: [
        {
          symbol: "VTI",
          description: "Vanguard Total Stock Market ETF",
          marketValue: 125_000,
          costBasis: 90_000,
          ineligible: false,
          isTransferring: true,
        },
        {
          symbol: "XYZIX",
          description: "Legacy mutual fund",
          marketValue: 15_000,
          costBasis: 9_000,
          ineligible: true,
          isTransferring: false,
        },
      ],
    });

    expect(buildPartialAcatDecisionSnapshot(2, positions)).toEqual({
      fundingPlanVersion: 2,
      included: ["VTI"],
      excluded: ["XYZIX"],
      includedCount: 1,
      excludedCount: 1,
      positions,
    });
  });

  it("creates direct, owned execution tasks without creating a decision", async () => {
    const tx = {
      decisionTask: {
        upsert: vi.fn(async (_args: unknown) => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };

    const count = await syncPartialAcatExecutionTasks(tx as never, identity, {
      transferId: "transfer-1",
      active: true,
    });

    expect(count).toBe(PARTIAL_ACAT_EXECUTION_TASKS.length);
    expect(tx.decisionTask.upsert).toHaveBeenCalledTimes(3);
    const writes = tx.decisionTask.upsert.mock.calls.map((call) => call[0]);
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        where: {
          source_key: "asset-transfer:transfer-1:standard-partial-acat:prepare-wet-signature-paperwork",
        },
        create: expect.objectContaining({
          decision_id: null,
          transfer_id: "transfer-1",
          owner_team: "CLIENT_SERVICE",
        }),
      }),
      expect.objectContaining({
        create: expect.objectContaining({
          task_key: "review-submit-partial-acat",
          owner_team: "OPERATIONS",
        }),
      }),
      expect.objectContaining({
        create: expect.objectContaining({
          task_key: "track-partial-acat",
          owner_team: "OPERATIONS",
        }),
      }),
    ]));
  });

  it("retires unfinished standard-route tasks when a revised plan is no longer partial", async () => {
    const tx = {
      decisionTask: {
        upsert: vi.fn(async (_args: unknown) => ({})),
        updateMany: vi.fn(async () => ({ count: 3 })),
      },
    };

    const count = await syncPartialAcatExecutionTasks(tx as never, identity, {
      transferId: "transfer-1",
      active: false,
    });

    expect(count).toBe(3);
    expect(tx.decisionTask.upsert).not.toHaveBeenCalled();
    expect(tx.decisionTask.updateMany).toHaveBeenCalledWith({
      where: {
        decision_id: null,
        transfer_id: "transfer-1",
        source_key: { startsWith: "asset-transfer:transfer-1:standard-partial-acat:" },
        status: { not: "DONE" },
      },
      data: {
        status: "DONE",
        completed_by: "ops@example.com",
        completed_at: expect.any(Date),
      },
    });
  });
});
