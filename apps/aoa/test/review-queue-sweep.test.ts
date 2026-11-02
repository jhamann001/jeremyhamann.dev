import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, materializeSpy } = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  materializeSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/data/review-queue-materialize", () => ({
  REVIEW_QUEUE_MATERIALIZATION_BUSY: "review_queue_materialization_already_running",
  runReviewQueueMaterialization: materializeSpy,
}));

import { runReviewQueueSweepStep } from "@/lib/data/review-queue-sweep";

type State = {
  id: string;
  trade_cursor: string | null;
  crm_cursor: string | null;
  trade_complete: boolean;
  crm_complete: boolean;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_started_at: Date | null;
  last_completed_at: Date | null;
  last_failure_at: Date | null;
  last_failure_source: string | null;
};

function result(overrides: {
  tradeFailed?: boolean;
  tradeMore?: boolean;
  crmMore?: boolean;
  missingTradeCursor?: boolean;
} = {}) {
  return {
    trade: {
      processed: overrides.tradeFailed ? 0 : 1,
      failed: overrides.tradeFailed ?? false,
      hasMore: overrides.tradeMore ?? false,
      nextCursor: overrides.tradeMore && !overrides.missingTradeCursor ? "003NEXT" : null,
    },
    crm: {
      processed: 1, failed: false, hasMore: overrides.crmMore ?? false,
      nextCursor: overrides.crmMore ? "crm_next" : null,
    },
    changes: { opened: 1, refreshed: 0, reopened: 0, autoResolved: 0, awakened: 0 },
  };
}

describe("review queue resumable sweep", () => {
  let state: State;
  let tx: { reviewQueueSweepState: Record<string, ReturnType<typeof vi.fn>> };

  beforeEach(() => {
    state = {
      id: "default", trade_cursor: null, crm_cursor: null,
      trade_complete: false, crm_complete: false,
      lease_token: null, lease_expires_at: null, last_started_at: null,
      last_completed_at: null, last_failure_at: null, last_failure_source: null,
    };
    tx = {
      reviewQueueSweepState: {
        upsert: vi.fn().mockImplementation(async () => state),
        updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
          if (data.last_started_at) {
            if (state.lease_token && state.lease_expires_at && state.lease_expires_at > new Date()) {
              return { count: 0 };
            }
          } else if (where.lease_token !== state.lease_token) return { count: 0 };
          Object.assign(state, data);
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ ...state })),
      },
    };
    scopeSpy.mockReset();
    scopeSpy.mockImplementation(async (_identity, fn) => fn(tx));
    materializeSpy.mockReset();
  });

  it("persists independent source progress and resets only after a complete sweep", async () => {
    materializeSpy
      .mockResolvedValueOnce(result({ tradeMore: true }))
      .mockResolvedValueOnce(result());

    const first = await runReviewQueueSweepStep({ limit: 10, crmLimit: 20 });
    expect(first.sweep.completed).toBe(false);
    expect(state).toMatchObject({
      trade_cursor: "003NEXT", crm_cursor: null,
      trade_complete: false, crm_complete: true, lease_token: null,
    });

    const second = await runReviewQueueSweepStep({ limit: 10, crmLimit: 20 });
    expect(materializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: "003NEXT", skipTrade: false, skipCrm: true,
    }));
    expect(second.sweep.completed).toBe(true);
    expect(state).toMatchObject({
      trade_cursor: null, crm_cursor: null,
      trade_complete: false, crm_complete: false, lease_token: null,
    });
    expect(state.last_completed_at).toBeInstanceOf(Date);
  });

  it("retains a failed source checkpoint while the other source completes", async () => {
    materializeSpy.mockResolvedValue(result({ tradeFailed: true }));
    const step = await runReviewQueueSweepStep();
    expect(step.sweep).toMatchObject({ completed: false, lastFailureSource: "TRADE_REQUEST" });
    expect(state).toMatchObject({
      trade_cursor: null, trade_complete: false,
      crm_complete: true, last_failure_source: "TRADE_REQUEST", lease_token: null,
    });
  });

  it("exposes a missing continuation cursor as a current-step failure", async () => {
    materializeSpy.mockResolvedValue(result({ tradeMore: true, missingTradeCursor: true }));
    const step = await runReviewQueueSweepStep();
    expect(step.sweep).toMatchObject({
      completed: false,
      failed: true,
      failureSource: "TRADE_REQUEST",
      lastFailureSource: "TRADE_REQUEST",
    });
  });

  it("rejects a concurrent call before any materialization work", async () => {
    state.lease_token = "00000000-0000-0000-0000-000000000000";
    state.lease_expires_at = new Date(Date.now() + 60_000);
    await expect(runReviewQueueSweepStep()).rejects.toThrow(
      "review_queue_materialization_already_running",
    );
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it("releases the lease and records freshness after a materialization failure", async () => {
    materializeSpy.mockRejectedValue(new Error("external details"));
    await expect(runReviewQueueSweepStep()).rejects.toThrow("external details");
    expect(state).toMatchObject({
      lease_token: null,
      lease_expires_at: null,
      last_failure_source: "MATERIALIZATION",
    });
    expect(state.last_failure_at).toBeInstanceOf(Date);
  });
});
