import "server-only";
import { withUserScope, type Identity } from "@/lib/rls";
import { appWritesPaused } from "@/lib/maintenance";
import { getOperationsSlackDeliveryConfig, operationsSlackCaptureEnabled } from "@/lib/slack/operations-fee-notifications";
import { operationsSlackDiagnosticCodeSchema, operationsSlackDiagnosticSchema, type OperationsSlackDiagnostic } from "@/lib/operations/operations-slack-diagnostic-contract";
import { assertOperationsSlackVerificationRecord, OPERATIONS_SLACK_VERIFICATION_REQUEST_ID } from "@/lib/operations/operations-slack-verification";

type Counts = OperationsSlackDiagnostic["counts"] & {
  total: number;
  needsReviewCount: number;
  delayedRetryCount: number;
};

/** Aggregate ordinary work in PostgreSQL; inspect only the fixed synthetic test.
 * This read cannot capture, claim, send, acknowledge or retry a notification. */
export async function readOperationsSlackDiagnostic(identity: Identity): Promise<OperationsSlackDiagnostic> {
  if ((identity.role !== "ADMIN" && identity.role !== "OPERATIONS")
    || typeof identity.email !== "string" || !identity.email.trim()) {
    throw new Error("Operations Slack diagnostic forbidden");
  }
  return withUserScope(identity, async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('statement_timeout', '5000', true),
      set_config('lock_timeout', '1000', true),
      set_config('jit', 'off', true)`;
    const rows = await tx.$queryRaw<Counts[]>`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'PENDING')::int AS "PENDING",
      count(*) FILTER (WHERE status = 'SENDING')::int AS "SENDING",
      count(*) FILTER (WHERE status = 'RETRY')::int AS "RETRY",
      count(*) FILTER (WHERE status = 'SENT')::int AS "SENT",
      count(*) FILTER (WHERE status = 'FAILED')::int AS "FAILED",
      count(*) FILTER (WHERE status = 'UNCERTAIN')::int AS "UNCERTAIN",
      count(*) FILTER (WHERE status IN ('FAILED', 'UNCERTAIN') AND acknowledged_at IS NULL)::int AS "needsReviewCount",
      count(*) FILTER (WHERE status = 'RETRY' AND next_attempt_at > now())::int AS "delayedRetryCount"
      FROM app.operations_slack_notification`;
    if (rows.length !== 1) throw new Error("Operations Slack diagnostic unavailable");
    const { total, needsReviewCount, delayedRetryCount, ...counts } = rows[0];
    if (Object.values(counts).reduce((sum, value) => sum + value, 0) !== total) {
      throw new Error("Operations Slack diagnostic unavailable");
    }
    const record = await tx.operationsFeeRequest.findUnique({
      where: { id: OPERATIONS_SLACK_VERIFICATION_REQUEST_ID },
      include: { events: { take: 3, orderBy: { id: "asc" } }, slack_notification: true },
    });
    const test = (() => {
      if (!record) return null;
      // A reserved-ID collision or incomplete test is an error, not an empty
      // queue or a passed verification. Internal validation fields stay here.
      assertOperationsSlackVerificationRecord(record);
      const notification = record.slack_notification;
      if (!notification) throw new Error("Operations Slack diagnostic unavailable");
      const code = operationsSlackDiagnosticCodeSchema.safeParse(notification.last_code);
      return {
        requestId: OPERATIONS_SLACK_VERIFICATION_REQUEST_ID,
        requestStatus: "CANCELLED",
        notificationStatus: notification.status,
        attempts: notification.attempts,
        channelId: notification.channel_id,
        slackTs: notification.slack_ts,
        lastCode: notification.last_code === null ? null : code.success ? code.data : "unrecognized_code",
        capturedAt: notification.created_at.toISOString(),
        updatedAt: notification.updated_at.toISOString(),
        submissionEventCount: record.events.filter((event) => event.action === "SUBMITTED").length,
        cancellationEventCount: record.events.filter((event) => event.action === "CANCELLED").length,
      };
    })();
    return operationsSlackDiagnosticSchema.parse({
      counts, needsReviewCount, delayedRetryCount,
      captureEnabled: operationsSlackCaptureEnabled(),
      deliveryEnabled: process.env.OPERATIONS_SLACK_DELIVERY_ENABLED === "true",
      configurationValid: getOperationsSlackDeliveryConfig() !== null,
      writesPaused: appWritesPaused(),
      test,
    });
  }, { maxWait: 2_000, timeout: 8_000, isolationLevel: "RepeatableRead" });
}
