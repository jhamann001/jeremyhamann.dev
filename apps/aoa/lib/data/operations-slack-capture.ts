import "server-only";
import type { Prisma } from "@prisma/client";
import {
  buildOperationsSlackMessage, operationsSlackCaptureEnabled, type OperationsSlackRequestKind,
} from "@/lib/slack/operations-fee-notifications";
import { demoMode } from "@/lib/demo/mode";
import { recordOutbox, slackSummary } from "@/lib/demo/outbox";

/** Join the caller's fresh submission transaction. Never backfill or upsert. */
export async function captureOperationsSlackNotification(
  tx: Prisma.TransactionClient, requestId: string, submittedEventId: bigint,
): Promise<boolean> {
  // The public demo has no delivery job: the alert it would post goes to the Outbox, in the same transaction.
  if (demoMode()) {
    const [row] = await tx.$queryRaw<{ kind: OperationsSlackRequestKind; client_sf_id: string | null }[]>`
      SELECT kind::text AS kind, client_sf_id FROM app.operations_fee_request WHERE id = ${requestId}`;
    if (!row) return false;
    const text = buildOperationsSlackMessage(row.kind, requestId);
    await recordOutbox(tx, {
      channel: "Slack", destination: "#operations", ...slackSummary(text), body: text, about: { clientSfId: row.client_sf_id },
    });
    return true;
  }
  if (!operationsSlackCaptureEnabled()) return false;
  // Keep the database clock and existing forced-RLS fresh-submission policy.
  await tx.$executeRaw`
    INSERT INTO app.operations_slack_notification (request_id, event_id)
    VALUES (${requestId}, ${submittedEventId})`;
  return true;
}
