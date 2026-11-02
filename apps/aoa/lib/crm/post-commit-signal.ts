import "server-only";

import crypto from "crypto";
import { after } from "next/server";
import {
  crmIdentityPostCommitSignalsEnabled,
  crmIdentityReconciliationEnabled,
  crmIdentityReconciliationWritesEnabled,
  crmRelationshipContinuousRefreshEnabled,
  crmRelationshipReconciliationEnabled,
  crmRelationshipReconciliationWritesEnabled,
} from "@/lib/flags";
import { runCrmIdentityReconciliation } from "@/lib/crm/reconcile";
import { runCrmRelationshipSnapshot } from "@/lib/crm/relationships";

export type CrmIdentityPostCommitSource =
  | "transfer_action"
  | "acat_link"
  | "transfer_sync";

// The normal HTTP endpoints keep independent four-minute transaction budgets.
// An application fast path shares one five-minute request lifecycle, so each
// best-effort step is bounded to leave room for both max-wait windows and the
// already-completed source transaction. The scheduled sweep repairs a timeout.
export const CRM_POST_COMMIT_STEP_TIMEOUT_MS = 100_000;

/**
 * Schedule one best-effort identity reconciliation after the current request
 * has returned, followed by a complete relationship snapshot when all three
 * relationship gates are enabled. Callers invoke this only after their source
 * write has committed. The scheduled sweep is the durable repair path if this
 * fast signal is missed or fails.
 *
 * No entity id, client data, or thrown error is logged. The source is a closed,
 * static enum used only to distinguish the three approved trigger paths.
 */
export function scheduleCrmIdentityReconciliation(
  source: CrmIdentityPostCommitSource,
): boolean {
  if (
    !crmIdentityPostCommitSignalsEnabled() ||
    !crmIdentityReconciliationEnabled() ||
    !crmIdentityReconciliationWritesEnabled()
  ) {
    return false;
  }

  try {
    after(async () => {
      try {
        await runCrmIdentityReconciliation(
          crypto.randomUUID(),
          false,
          CRM_POST_COMMIT_STEP_TIMEOUT_MS,
        );
      } catch {
        console.error(`[crm:post-commit] source=${source} identity_run_failed`);
        return;
      }

      if (
        !crmRelationshipReconciliationEnabled() ||
        !crmRelationshipReconciliationWritesEnabled() ||
        !crmRelationshipContinuousRefreshEnabled()
      ) {
        return;
      }

      try {
        await runCrmRelationshipSnapshot(
          crypto.randomUUID(),
          false,
          {
            contact: true,
            deal: true,
            transfer: true,
          },
          CRM_POST_COMMIT_STEP_TIMEOUT_MS,
        );
      } catch {
        console.error(
          `[crm:post-commit] source=${source} relationship_run_failed`,
        );
      }
    });
  } catch {
    // A framework/request-lifecycle registration failure must not turn an
    // already-committed transfer write into a user-visible failure.
    console.error(`[crm:post-commit] source=${source} schedule_failed`);
    return false;
  }
  return true;
}
