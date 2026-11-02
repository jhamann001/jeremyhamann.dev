import "server-only";

import { operationsFeeRequestsPreviewEnabled } from "@/lib/flags";
import { canAccessOperationsTools } from "@/lib/operations/authorization";
import { withUserScope, type Identity } from "@/lib/rls";
import { buildOperationsSlackMessage, operationsSlackCaptureEnabled, OPERATIONS_SLACK_CHANNEL } from "@/lib/slack/operations-fee-notifications";

export type OperationsSlackPreview = {
  requestId: string;
  captureEnabled: boolean;
  deliveryFlagEnabled: boolean;
  channel: string;
  message: string;
  notification: null | {
    status: string;
    attempts: number;
    eventId: string;
    capturedAt: string;
    receiptPresent: boolean;
  };
};

/** Exact-request, read-only dev evidence; never use a worker identity or claim work. */
export async function operationsSlackPreview(identity: Identity, requestId: string): Promise<OperationsSlackPreview | null> {
  if (process.env.APP_ENV !== "dev" || !operationsFeeRequestsPreviewEnabled()
    || !canAccessOperationsTools(identity.role) || !identity.email?.trim()) return null;
  if (typeof requestId !== "string" || requestId.length < 16 || requestId.length > 64
    || /[^A-Za-z0-9_-]/.test(requestId)) return null;

  return withUserScope(identity, async (tx) => {
    const request = await tx.operationsFeeRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true, kind: true,
        slack_notification: { select: {
          status: true, attempts: true, event_id: true, created_at: true, slack_ts: true,
        } },
      },
    });
    if (!request) return null;
    const notification = request.slack_notification;
    return {
      requestId: request.id,
      captureEnabled: operationsSlackCaptureEnabled(),
      deliveryFlagEnabled: process.env.OPERATIONS_SLACK_DELIVERY_ENABLED === "true",
      channel: OPERATIONS_SLACK_CHANNEL,
      message: buildOperationsSlackMessage(request.kind, request.id),
      notification: notification ? {
        status: notification.status,
        attempts: notification.attempts,
        eventId: notification.event_id.toString(),
        capturedAt: notification.created_at.toISOString(),
        receiptPresent: notification.slack_ts !== null,
      } : null,
    };
  });
}
