"use server";

import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { changeRequestStatus } from "@/lib/trade-requests/status";
import { STATUS_ACTION_COPY, STATUS_NOTE_MAX, isStatusActionTarget, type StatusChangeResult } from "@/lib/trade-requests/status-view";

// The delegated client confirms the signed-in person and their workspace role
// on every call, and the service allows status changes to reviewers only.

const FAILED: StatusChangeResult = { ok: false, message: STATUS_ACTION_COPY.actionFailed };

const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 100;
const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));

export async function changeTradeRequestStatus(id: unknown, change: unknown): Promise<StatusChangeResult> {
  if (!tradeRequestsWorkspaceEnabled() || !validId(id) || change == null || typeof change !== "object") return FAILED;
  const { status, note, expectedUpdatedAt } = change as Record<string, unknown>;
  if (!isStatusActionTarget(status) || typeof note !== "string" || note.length > STATUS_NOTE_MAX || !validTimestamp(expectedUpdatedAt)) {
    return FAILED;
  }
  return changeRequestStatus(id, { status, note, expectedUpdatedAt });
}
