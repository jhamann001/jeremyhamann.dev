/**
 * JSON-RPC 2.0 framing for `POST /api/mcp` — pure, node only, layer L1
 *.
 *
 * Written by hand, on purpose. The Model Context Protocol's own SDK is a dependency this wave may not
 * add ("no new npm dependencies"), and the streamable-HTTP transport MCP actually needs here is one
 * POST that takes a JSON-RPC message and answers with one — the SSE and session-resumption halves of
 * the transport exist for servers that push, and this one never does. Writing the 200 lines is
 * cheaper than owning a dependency that reaches a books-and-records system.
 *
 * Everything in this file is a pure function over values. No database, no `fetch`, no environment —
 * so the whole framing layer is testable without a request, and `registry.ts` is the only place that
 * touches the desk.
 *
 * ## Parsing is hostile-input-first
 *
 * `JSON.parse` on attacker-controlled text is not by itself dangerous, but what the result is then
 * SPREAD into is: `{...parsed}` on an object carrying `"__proto__"` reached through a later
 * `Object.assign` or a merge is the whole prototype-pollution class. `parseJsonRpcText` strips
 * `__proto__`, `constructor` and `prototype` keys during the parse (a reviver runs before the object
 * is assembled, so the dangerous key is never assigned at all) and returns objects with a null
 * prototype. Nothing downstream has to remember.
 *
 * ## Bounds
 *
 * A batch is capped at `MCP_MAX_BATCH`, and the body is capped by the caller before it reaches here.
 * Both refusals are JSON-RPC errors rather than HTTP errors where the protocol allows it, because an
 * agent runtime reads the error object and a bare 400 tells it nothing.
 */

export const JSONRPC_VERSION = "2.0" as const;

/**
 * The protocol revisions this server implements, newest first. Negotiation (MCP `initialize`) is:
 * if the client asks for one of these, answer with exactly that one; otherwise answer with the
 * newest we speak and let the client decide whether it can continue. Refusing outright is the wrong
 * behaviour — the specification says the client may disconnect, which is its call, not ours.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = MCP_PROTOCOL_VERSIONS[0];

/**
 * How many messages one POST may carry. Small deliberately: a batch is a convenience for an agent
 * issuing a handful of calls, and every element is a real query against the desk. Twenty would let
 * one request do twenty tickets' worth of work under one rate-limit token.
 */
export const MCP_MAX_BATCH = 8;

/** Standard JSON-RPC 2.0 error codes. The four the specification reserves, plus the internal one. */
export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** A JSON-RPC id: string, number, or null. Objects and arrays are not ids (specification §4). */
export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  /** Absent for a notification-shaped call with no arguments. Always an object here, never an array. */
  params?: Record<string, unknown>;
  /** Absent for a NOTIFICATION, which takes no response at all. */
  id?: JsonRpcId;
};

export type JsonRpcSuccess = { jsonrpc: typeof JSONRPC_VERSION; id: JsonRpcId; result: unknown };
export type JsonRpcFailure = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

const POLLUTING_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Longest method name this server will even look at. Bounds the string a log line could carry. */
const MAX_METHOD_LENGTH = 128;
/** Longest id this server will echo. An id is echoed verbatim, so it is bounded like any echoed input. */
const MAX_ID_LENGTH = 512;

/**
 * `JSON.parse` with a reviver that DROPS the three prototype-pollution keys, and with every plain
 * object re-created with a null prototype.
 *
 * The reviver runs bottom-up as each value is assembled, so returning `undefined` for a dangerous key
 * removes it before the parent object is built — `__proto__` is never assigned, not even transiently.
 * `Object.create(null)` on the way out means a later `obj.constructor` or `obj.toString` is
 * `undefined` rather than something inherited, which is the second half of the same guarantee.
 *
 * Returns `undefined` when the text is not JSON. `undefined` is not a JSON value, so it is an
 * unambiguous failure marker — `null` is not.
 */
export function parseJsonRpcText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text, function reviver(key: string, value: unknown): unknown {
      if (POLLUTING_KEYS.has(key)) return undefined;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (POLLUTING_KEYS.has(k)) continue;
          clean[k] = v;
        }
        return clean;
      }
      return value;
    });
    return parsed === undefined ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Specification §4: an id is a string, a number, or null. Bounded, because it is echoed back. */
export function isJsonRpcId(v: unknown): v is JsonRpcId {
  if (v === null) return true;
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.length <= MAX_ID_LENGTH;
}

export type RequestValidation =
  | { ok: true; request: JsonRpcRequest; isNotification: boolean }
  | { ok: false; id: JsonRpcId; code: number; message: string };

/**
 * Validates ONE message. The `id` in a failure is the caller's id when it could be read and `null`
 * when it could not — which is exactly what the specification says an `invalidRequest` response
 * carries, and is what lets an agent match the error to the call it made.
 *
 * `params` must be an OBJECT. JSON-RPC allows positional arrays; MCP does not use them, and accepting
 * both would mean every tool schema had to describe two shapes.
 */
export function validateJsonRpcRequest(value: unknown): RequestValidation {
  if (!isPlainObject(value)) {
    return { ok: false, id: null, code: JSONRPC_ERRORS.invalidRequest, message: "message must be an object" };
  }
  const id = isJsonRpcId(value.id) ? (value.id as JsonRpcId) : null;
  if (value.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, id, code: JSONRPC_ERRORS.invalidRequest, message: 'jsonrpc must be "2.0"' };
  }
  if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > MAX_METHOD_LENGTH) {
    return { ok: false, id, code: JSONRPC_ERRORS.invalidRequest, message: "method must be a non-empty string" };
  }
  if ("params" in value && value.params !== undefined && !isPlainObject(value.params)) {
    return { ok: false, id, code: JSONRPC_ERRORS.invalidParams, message: "params must be an object" };
  }
  if ("id" in value && value.id !== undefined && !isJsonRpcId(value.id)) {
    return { ok: false, id: null, code: JSONRPC_ERRORS.invalidRequest, message: "id must be a string, number or null" };
  }

  const isNotification = !("id" in value) || value.id === undefined;
  const request: JsonRpcRequest = {
    jsonrpc: JSONRPC_VERSION,
    method: value.method,
    ...(isPlainObject(value.params) ? { params: value.params } : {}),
    ...(isNotification ? {} : { id: value.id as JsonRpcId }),
  };
  return { ok: true, request, isNotification };
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: JSONRPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * The version this server answers `initialize` with: the client's, when we speak it; ours otherwise.
 * A missing or malformed `protocolVersion` is treated as "did not ask", which gets our latest.
 */
export function negotiateProtocolVersion(requested: unknown): McpProtocolVersion {
  if (typeof requested !== "string") return MCP_LATEST_PROTOCOL_VERSION;
  const match = MCP_PROTOCOL_VERSIONS.find((v) => v === requested);
  return match ?? MCP_LATEST_PROTOCOL_VERSION;
}

export type BatchParse =
  | { kind: "single"; message: unknown }
  | { kind: "batch"; messages: unknown[] }
  | { kind: "error"; code: number; message: string };

/**
 * Splits a parsed body into one message or a bounded batch.
 *
 * An EMPTY array is `invalidRequest` (specification §6), and an oversized one is refused rather than
 * truncated: silently answering the first eight of twenty calls is the kind of partial success that
 * makes an agent loop forever waiting for the ninth.
 */
export function parseBatch(body: unknown): BatchParse {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { kind: "error", code: JSONRPC_ERRORS.invalidRequest, message: "batch must not be empty" };
    }
    if (body.length > MCP_MAX_BATCH) {
      return {
        kind: "error",
        code: JSONRPC_ERRORS.invalidRequest,
        message: `batch must contain at most ${MCP_MAX_BATCH} messages`,
      };
    }
    return { kind: "batch", messages: body };
  }
  return { kind: "single", message: body };
}

/**
 * An MCP tool result, in the `content` shape the protocol defines.
 *
 * The payload is serialized as JSON inside a text block rather than sent as a bare object: the
 * `structuredContent` field is newer than the oldest protocol revision this server accepts, and a
 * text block is the one shape every revision and every client understands. `isError: true` is how a
 * TOOL failure is reported — distinct from a JSON-RPC error, which means the CALL was malformed.
 */
export function toolTextResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function toolErrorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}
