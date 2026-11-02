import type { Prisma } from "@prisma/client";
import type { DealStage, StageHistoryEntry } from "./deal-types";

// D8 QC fix (MEDIUM-1, PR #80): the stage write is guarded and the timeline
// append happens IN SQL, so concurrent stage changes can neither drop a
// history entry nor record a stale `from`/`lost_from`.
//
//  - Optimistic guard: updateMany({ id, stage: expectedFrom }) — under READ
//    COMMITTED the second writer blocks on the row lock, re-evaluates the
//    WHERE against the winner's committed stage, matches zero rows and gets
//    "conflict" back. The caller returns a clear error and writes NOTHING
//    (this must be the transaction's first write).
//  - jsonb append: `stage_history = stage_history || $entry` — the DB
//    concatenates against the CURRENT committed value, never a stale
//    JS-side read.
//
// Extracted from the server actions so the conflict semantics are unit-
// testable with a fake transaction client (no auth/next imports here).

export type StageWriteOutcome = "applied" | "conflict";

/** The clear, non-technical error the actions surface on a lost race. */
export const STAGE_CONFLICT_MESSAGE =
  "This deal's stage was just changed by someone else — refresh to see the latest, then retry.";

/**
 * Guarded stage transition + SQL-side timeline append, in the caller's
 * transaction. On "conflict" nothing has been written — the caller must stop
 * (no field update, no audit rows).
 */
export async function applyGuardedStageWrite(
  tx: Prisma.TransactionClient,
  id: string,
  from: DealStage,
  to: DealStage,
  entry: StageHistoryEntry,
  updatedBy: string | null,
): Promise<StageWriteOutcome> {
  const updated = await tx.deal.updateMany({
    where: { id, stage: from },
    data: {
      stage: to,
      // Transition to LOST captures the prior stage for win/loss reporting —
      // computed from the same guarded `from`, so it can never be stale.
      ...(to === "LOST" ? { lost_from: from } : {}),
      updated_by: updatedBy,
    },
  });
  if (updated.count === 0) return "conflict";

  // Append at the SQL level; runs on the row this transaction now holds
  // locked, so the concatenation base is always the committed timeline.
  await tx.$executeRaw`
    UPDATE "app"."deal"
    SET stage_history = stage_history || ${JSON.stringify([entry])}::jsonb
    WHERE id = ${id}`;
  return "applied";
}
