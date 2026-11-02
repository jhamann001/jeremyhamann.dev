import "server-only";

import { randomUUID } from "node:crypto";
import { withUserScope } from "@/lib/rls";
import {
  REVIEW_QUEUE_MATERIALIZATION_BUSY,
  runReviewQueueMaterialization,
  type ReviewQueueMaterializationResult,
} from "./review-queue-materialize";

const SYSTEM_IDENTITY = { role: "ADMIN", email: "review-queue@system" } as const;
const SWEEP_ID = "default";
const LEASE_MILLISECONDS = 6 * 60_000;

type SweepLease = {
  token: string;
  tradeCursor: string | null;
  crmCursor: string | null;
  tradeComplete: boolean;
  crmComplete: boolean;
  lastCompletedAt: Date | null;
};

async function acquireSweepLease(): Promise<SweepLease> {
  const now = new Date();
  const token = randomUUID();
  return withUserScope(SYSTEM_IDENTITY, async (tx) => {
    await tx.reviewQueueSweepState.upsert({
      where: { id: SWEEP_ID },
      create: { id: SWEEP_ID, last_started_at: now },
      update: {},
    });
    const claimed = await tx.reviewQueueSweepState.updateMany({
      where: {
        id: SWEEP_ID,
        OR: [{ lease_token: null }, { lease_expires_at: { lte: now } }],
      },
      data: {
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + LEASE_MILLISECONDS),
        last_started_at: now,
      },
    });
    if (claimed.count !== 1) throw new Error(REVIEW_QUEUE_MATERIALIZATION_BUSY);
    const state = await tx.reviewQueueSweepState.findUniqueOrThrow({ where: { id: SWEEP_ID } });
    return {
      token,
      tradeCursor: state.trade_cursor,
      crmCursor: state.crm_cursor,
      tradeComplete: state.trade_complete,
      crmComplete: state.crm_complete,
      lastCompletedAt: state.last_completed_at,
    };
  });
}

function failedSource(tradeFailed: boolean, crmFailed: boolean): string | null {
  if (tradeFailed && crmFailed) return "MULTIPLE";
  if (tradeFailed) return "TRADE_REQUEST";
  if (crmFailed) return "CRM_IDENTITY";
  return null;
}

async function recordMaterializationFailure(token: string): Promise<void> {
  await withUserScope(SYSTEM_IDENTITY, async (tx) => {
    await tx.reviewQueueSweepState.updateMany({
      where: { id: SWEEP_ID, lease_token: token },
      data: {
        lease_token: null,
        lease_expires_at: null,
        last_failure_at: new Date(),
        last_failure_source: "MATERIALIZATION",
      },
    });
  });
}

export type ReviewQueueSweepStepResult = ReviewQueueMaterializationResult & {
  sweep: {
    completed: boolean;
    failed: boolean;
    failureSource: string | null;
    lastCompletedAt: string | null;
    lastFailureAt: string | null;
    lastFailureSource: string | null;
  };
};

/** Advance one bounded page for each unfinished source and persist the checkpoint. */
export async function runReviewQueueSweepStep(options: {
  limit?: number;
  crmLimit?: number;
} = {}): Promise<ReviewQueueSweepStepResult> {
  const lease = await acquireSweepLease();
  let result: ReviewQueueMaterializationResult;
  try {
    result = await runReviewQueueMaterialization({
      cursor: lease.tradeCursor ?? undefined,
      crmCursor: lease.crmCursor ?? undefined,
      limit: options.limit,
      crmLimit: options.crmLimit,
      skipTrade: lease.tradeComplete,
      skipCrm: lease.crmComplete,
    });
  } catch (error) {
    await recordMaterializationFailure(lease.token);
    throw error;
  }

  const tradeFailed = !lease.tradeComplete && (
    result.trade.failed || (result.trade.hasMore && !result.trade.nextCursor)
  );
  const crmFailed = !lease.crmComplete && (
    result.crm.failed || (result.crm.hasMore && !result.crm.nextCursor)
  );
  const failure = failedSource(tradeFailed, crmFailed);
  const now = new Date();
  const nextTradeComplete = lease.tradeComplete || (!tradeFailed && !result.trade.hasMore);
  const nextCrmComplete = lease.crmComplete || (!crmFailed && !result.crm.hasMore);
  const completed = nextTradeComplete && nextCrmComplete;
  const saved = await withUserScope(SYSTEM_IDENTITY, async (tx) => {
    const updated = await tx.reviewQueueSweepState.updateMany({
      where: { id: SWEEP_ID, lease_token: lease.token },
      data: {
        trade_cursor: completed
          ? null
          : lease.tradeComplete || tradeFailed
            ? lease.tradeCursor
            : result.trade.nextCursor,
        crm_cursor: completed
          ? null
          : lease.crmComplete || crmFailed
            ? lease.crmCursor
            : result.crm.nextCursor,
        trade_complete: completed ? false : nextTradeComplete,
        crm_complete: completed ? false : nextCrmComplete,
        lease_token: null,
        lease_expires_at: null,
        last_completed_at: completed ? now : lease.lastCompletedAt,
        ...(failure ? { last_failure_at: now, last_failure_source: failure } : {}),
      },
    });
    if (updated.count !== 1) throw new Error(REVIEW_QUEUE_MATERIALIZATION_BUSY);
    return tx.reviewQueueSweepState.findUniqueOrThrow({ where: { id: SWEEP_ID } });
  });

  return {
    ...result,
    sweep: {
      completed,
      failed: failure != null,
      failureSource: failure,
      lastCompletedAt: saved.last_completed_at?.toISOString() ?? null,
      lastFailureAt: saved.last_failure_at?.toISOString() ?? null,
      lastFailureSource: saved.last_failure_source,
    },
  };
}
