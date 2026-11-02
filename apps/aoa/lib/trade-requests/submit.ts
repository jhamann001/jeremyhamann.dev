import "server-only";
import { callTradeRequestService } from "./client";
import { REQUEST_DETAIL_COPY, isLoadableRequestId, isTradeRequest } from "./detail-view";
import { SUBMIT_COPY, type NewRequestPayload, type SubmitOutcome } from "./new-request-submit";
import type { TradeRequest } from "./request-types";

function submitted(data: { data?: unknown } | null): SubmitOutcome {
  const request = data?.data;
  return { ok: true, id: isTradeRequest(request) ? request.id : null };
}

/**
 * Creates the request. The same idempotencyKey is sent on every attempt of
 * one submission (in the body, which is where the service reads it), so a
 * retry after a lost response returns the request already created.
 */
export async function createTradeRequest(payload: NewRequestPayload, idempotencyKey: string): Promise<SubmitOutcome> {
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "createRequest", method: "POST", path: "/requests",
    body: { ...payload, idempotencyKey }, defaultMessage: SUBMIT_COPY.failed,
  });
  return result.ok ? submitted(result.data) : { ok: false, message: result.message };
}

/** Resubmits a Needs Info request; expectedUpdatedAt is the version the form was opened on (ruling A2). */
export async function resubmitTradeRequest(id: string, payload: NewRequestPayload, expectedUpdatedAt: string): Promise<SubmitOutcome> {
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "resubmitRequest", method: "PUT", path: `/requests/${encodeURIComponent(id)}`,
    body: { ...payload, existingId: id, expectedUpdatedAt }, defaultMessage: SUBMIT_COPY.failed,
  });
  return result.ok ? submitted(result.data) : { ok: false, message: result.message };
}

export type SourceRequestLoad =
  | { kind: "found"; request: TradeRequest }
  | { kind: "not_found" }
  | { kind: "not_set_up" }
  | { kind: "failed"; message: string };

/** The request an edit or clone form starts from, read when the form opens. */
export async function loadSourceRequest(id: string): Promise<SourceRequestLoad> {
  if (!isLoadableRequestId(id)) return { kind: "not_found" };
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "requestDetail", method: "GET", path: `/requests/${encodeURIComponent(id)}`,
    defaultMessage: REQUEST_DETAIL_COPY.loadFailed,
  });
  if (result.ok) {
    return isTradeRequest(result.data?.data) ? { kind: "found", request: result.data.data } : { kind: "failed", message: REQUEST_DETAIL_COPY.loadFailed };
  }
  if (result.outcome === "not_set_up") return { kind: "not_set_up" };
  if (result.status === 404) return { kind: "not_found" };
  return { kind: "failed", message: result.message };
}
