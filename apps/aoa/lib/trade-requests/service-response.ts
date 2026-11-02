import { TRADE_REQUESTS_COPY } from "./copy";
import type { TradeRequestCall, TradeRequestResult } from "./client";

// How a Trade Request answer becomes a workspace result. Shared by the delegated
// call and the native handlers so both show the same outcome and message text.

const NOT_SET_UP_CODES = new Set([
  "person_unconfirmed", "role_unconfirmed", "role_not_permitted", "caller_unauthenticated", "caller_not_permitted",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Same text the standalone app shows: the service error plus up to three validation details.
export function serviceText(body: unknown): string | null {
  if (!record(body) || typeof body.error !== "string" || body.error === "") return null;
  const details = Array.isArray(body.details) ? body.details : [];
  const fields = details
    .map((detail) => {
      if (!record(detail)) return "";
      const path = Array.isArray(detail.path) ? detail.path.filter((part) => part !== "" && part != null).map(String).join(".") : "";
      const message = typeof detail.message === "string" ? detail.message : "";
      return path && message ? `${path}: ${message}` : message || path;
    })
    .filter(Boolean)
    .slice(0, 3);
  return fields.length > 0 ? `${body.error}: ${fields.join("; ")}` : body.error;
}

export function refusalCode(body: unknown): string | null {
  return record(body) && typeof body.code === "string" && NOT_SET_UP_CODES.has(body.code) ? body.code : null;
}

/** The bell shows one fixed line for every failure, never service text. */
export function failedResult<T>(call: TradeRequestCall, status: number | null, message: string): TradeRequestResult<T> {
  return { ok: false, outcome: "failed", status, message: call.channel === "bell" ? call.defaultMessage : message };
}

export function notSetUpResult<T>(call: TradeRequestCall, status: number | null = null): TradeRequestResult<T> {
  return call.channel === "bell"
    ? failedResult(call, status, call.defaultMessage)
    : { ok: false, outcome: "not_set_up", message: TRADE_REQUESTS_COPY.notSetUp };
}

/** The result for an answer that will not be retried. */
export function finalResult<T>(call: TradeRequestCall, status: number, body: unknown, malformed = false): TradeRequestResult<T> {
  if (status >= 200 && status < 300) {
    return malformed ? failedResult(call, status, call.defaultMessage) : { ok: true, status, data: body as T };
  }
  if ((status === 401 || status === 403) && refusalCode(body)) return notSetUpResult(call, status);
  return failedResult(call, status, serviceText(body) ?? `Request failed with status code ${status}`);
}
