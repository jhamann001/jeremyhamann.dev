import "server-only";
import { callTradeRequestService } from "./client";
import { isLoadableRequestId } from "./detail-view";
import { STATUS_ACTION_COPY, type StatusChange, type StatusChangeResult } from "./status-view";

/**
 * The service allows this to reviewers only, refuses a decided request, and
 * refuses a change whose expectedUpdatedAt no longer matches (stale change).
 * It records the audit entry by the signed-in person, "No additional notes."
 * when the note is empty.
 */
export async function changeRequestStatus(id: string, change: StatusChange): Promise<StatusChangeResult> {
  if (!isLoadableRequestId(id)) return { ok: false, message: STATUS_ACTION_COPY.actionFailed };
  const result = await callTradeRequestService<unknown>({
    operation: "statusChange", method: "PUT", path: `/requests/${encodeURIComponent(id)}/status`,
    body: { status: change.status, note: change.note, expectedUpdatedAt: change.expectedUpdatedAt },
    defaultMessage: STATUS_ACTION_COPY.actionFailed,
  });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}
