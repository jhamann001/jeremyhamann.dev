"use server";

import { auth } from "@/auth";
import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "@/lib/trade-requests/access";
import { isLoadableRequestId } from "@/lib/trade-requests/detail-view";
import { SUBMIT_COPY, type NewRequestPayload, type SubmitOutcome } from "@/lib/trade-requests/new-request-submit";
import { createTradeRequest, resubmitTradeRequest } from "@/lib/trade-requests/submit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSED: SubmitOutcome = { ok: false, message: SUBMIT_COPY.failed };

async function workspaceAllowed(): Promise<boolean> {
  if (!tradeRequestsWorkspaceEnabled()) return false;
  const session = await auth();
  return !!session?.user && canUseTradeRequestsWorkspace((session.user as { role?: string }).role);
}

// The service validates every field; only the shape is checked here.
function payloadShape(value: unknown): value is NewRequestPayload {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { clientId?: unknown }).clientId === "string" && Array.isArray((value as { selectedAccounts?: unknown }).selectedAccounts);
}

export async function submitNewRequest(payload: unknown, idempotencyKey: unknown): Promise<SubmitOutcome> {
  if (!payloadShape(payload) || typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) return REFUSED;
  if (!(await workspaceAllowed())) return REFUSED;
  return createTradeRequest(payload, idempotencyKey);
}

export async function resubmitRequest(id: unknown, payload: unknown, expectedUpdatedAt: unknown): Promise<SubmitOutcome> {
  if (typeof id !== "string" || id.length > 50 || !isLoadableRequestId(id) || !payloadShape(payload)) return REFUSED;
  if (typeof expectedUpdatedAt !== "string" || Number.isNaN(Date.parse(expectedUpdatedAt))) return REFUSED;
  if (!(await workspaceAllowed())) return REFUSED;
  return resubmitTradeRequest(id, payload, expectedUpdatedAt);
}
