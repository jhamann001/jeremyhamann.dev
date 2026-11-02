import "server-only";

import { withUserScope } from "@/lib/rls";
import { reviewQueueTradeSubjectKey } from "./review-queue-keys";

const SYSTEM_IDENTITY = { role: "ADMIN", email: "review-queue@system" } as const;

const AMBIGUITY_TYPES = new Set([
  "TRADE_PROFILE_MULTIPLE_UNCONFIRMED",
  "TRADE_PROFILE_CONFLICT",
  "TRADE_PROFILE_ACCOUNT_VARIATION",
]);

/**
 * Counts-only post-sweep validation for a known client. The caller supplies the
 * source reference in the request body; it is hashed immediately and is never
 * logged, returned, or persisted by this operation.
 */
export async function validateTradeReviewMaterialization(clientReference: string) {
  const subjectKey = reviewQueueTradeSubjectKey(clientReference);
  return withUserScope(SYSTEM_IDENTITY, async (tx) => {
    const rows = await tx.reviewQueueItem.findMany({
      where: {
        source: "TRADE_REQUEST",
        subject_key: subjectKey,
        source_active: true,
      },
      select: {
        exception_type: true,
        source_snapshot: true,
        last_seen_at: true,
      },
      orderBy: { exception_type: "asc" },
    });
    const types = [...new Set(rows.map((row) => row.exception_type))].sort();
    const numeric = (key: "candidateCount" | "accountCount") =>
      rows.reduce((max, row) => {
        const snapshot = row.source_snapshot as Record<string, unknown> | null;
        const value = snapshot?.[key];
        return typeof value === "number" && Number.isFinite(value)
          ? Math.max(max, value)
          : max;
      }, 0);
    return {
      found: rows.length > 0,
      activeSignals: rows.length,
      ambiguityDetected: types.some((type) => AMBIGUITY_TYPES.has(type)),
      types,
      maxCandidateCount: numeric("candidateCount"),
      maxAccountCount: numeric("accountCount"),
      lastCheckedAt:
        rows.reduce<Date | null>(
          (latest, row) => !latest || row.last_seen_at > latest ? row.last_seen_at : latest,
          null,
        )?.toISOString() ?? null,
    };
  });
}
