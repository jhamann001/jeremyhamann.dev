/**
 * `src/server/mcp/jsonrpc.ts` — the hand-written JSON-RPC 2.0 framing.
 *
 * This is the layer that meets hostile input first, so the assertions are about refusals as much as
 * about happy paths: prototype-pollution keys never reach an object, an id is echoed only when it is
 * a legal id, a batch is bounded, and `params` must be an object rather than the positional array
 * JSON-RPC also allows.
 */
import { describe, expect, it } from "vitest";
import {
  JSONRPC_ERRORS,
  JSONRPC_VERSION,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_MAX_BATCH,
  MCP_PROTOCOL_VERSIONS,
  isJsonRpcId,
  jsonRpcError,
  jsonRpcSuccess,
  negotiateProtocolVersion,
  parseBatch,
  parseJsonRpcText,
  toolErrorResult,
  toolTextResult,
  validateJsonRpcRequest,
} from "@/server/mcp/jsonrpc";

describe("parseJsonRpcText", () => {
  it("parses ordinary JSON", () => {
    expect(parseJsonRpcText('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, "x"] });
  });

  it("returns undefined — never null — for text that is not JSON", () => {
    expect(parseJsonRpcText("not json")).toBeUndefined();
    expect(parseJsonRpcText("")).toBeUndefined();
    expect(parseJsonRpcText("{")).toBeUndefined();
    // `null` IS valid JSON and must not be confused with a parse failure.
    expect(parseJsonRpcText("null")).toBeNull();
  });

  it("drops __proto__ without ever assigning it, and does not pollute Object.prototype", () => {
    const parsed = parseJsonRpcText('{"__proto__":{"polluted":"yes"},"method":"ping"}') as Record<string, unknown>;
    expect(parsed.method).toBe("ping");
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("drops constructor and prototype keys at any depth", () => {
    const parsed = parseJsonRpcText(
      '{"params":{"constructor":{"prototype":{"x":1}},"prototype":"y","name":"get_ticket"}}',
    ) as { params: Record<string, unknown> };
    expect(Object.keys(parsed.params)).toEqual(["name"]);
  });

  it("returns null-prototype objects, so nothing is inherited", () => {
    const parsed = parseJsonRpcText('{"a":{"b":1}}') as { a: object };
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(parsed.a)).toBeNull();
  });

  it("leaves arrays as real arrays", () => {
    const parsed = parseJsonRpcText('[{"jsonrpc":"2.0","method":"ping","id":1}]');
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("validateJsonRpcRequest", () => {
  const req = (over: Record<string, unknown>): unknown => ({ jsonrpc: "2.0", method: "ping", ...over });

  it("accepts a well-formed request and carries its id", () => {
    const v = validateJsonRpcRequest(req({ id: 7, params: { a: 1 } }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.isNotification).toBe(false);
    expect(v.request).toEqual({ jsonrpc: JSONRPC_VERSION, method: "ping", params: { a: 1 }, id: 7 });
  });

  it("treats a message with no id as a NOTIFICATION", () => {
    const v = validateJsonRpcRequest(req({ method: "notifications/initialized" }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.isNotification).toBe(true);
    expect("id" in v.request).toBe(false);
  });

  it("id: null is an id, not a notification (specification §4)", () => {
    const v = validateJsonRpcRequest(req({ id: null }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.isNotification).toBe(false);
  });

  it("refuses a wrong or missing jsonrpc version, echoing the caller's id", () => {
    const v = validateJsonRpcRequest({ jsonrpc: "1.0", method: "ping", id: "abc" });
    expect(v).toEqual({ ok: false, id: "abc", code: JSONRPC_ERRORS.invalidRequest, message: 'jsonrpc must be "2.0"' });
  });

  it("refuses a non-object message, a missing method and an empty method", () => {
    expect(validateJsonRpcRequest([]).ok).toBe(false);
    expect(validateJsonRpcRequest("ping").ok).toBe(false);
    expect(validateJsonRpcRequest(null).ok).toBe(false);
    expect(validateJsonRpcRequest(req({ method: undefined })).ok).toBe(false);
    expect(validateJsonRpcRequest(req({ method: "" })).ok).toBe(false);
  });

  it("refuses positional params — MCP is object-params only", () => {
    const v = validateJsonRpcRequest(req({ id: 1, params: [1, 2, 3] }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe(JSONRPC_ERRORS.invalidParams);
  });

  it("refuses an object id and answers with a null id, because there is nothing to echo", () => {
    const v = validateJsonRpcRequest(req({ id: { a: 1 } }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.id).toBeNull();
  });

  it("bounds the method name and the id", () => {
    expect(validateJsonRpcRequest(req({ id: 1, method: "m".repeat(129) })).ok).toBe(false);
    expect(isJsonRpcId("x".repeat(513))).toBe(false);
    expect(isJsonRpcId("x".repeat(512))).toBe(true);
    expect(isJsonRpcId(Number.NaN)).toBe(false);
  });
});

describe("negotiateProtocolVersion", () => {
  it("echoes a version this server speaks", () => {
    for (const v of MCP_PROTOCOL_VERSIONS) expect(negotiateProtocolVersion(v)).toBe(v);
  });

  it("answers with our latest when the client asks for one we do not speak, or asks for nothing", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });
});

describe("parseBatch", () => {
  it("passes a single message through", () => {
    expect(parseBatch({ jsonrpc: "2.0", method: "ping", id: 1 })).toEqual({
      kind: "single",
      message: { jsonrpc: "2.0", method: "ping", id: 1 },
    });
  });

  it("accepts a batch up to the cap", () => {
    const messages = Array.from({ length: MCP_MAX_BATCH }, (_, i) => ({ jsonrpc: "2.0", method: "ping", id: i }));
    const parsed = parseBatch(messages);
    expect(parsed.kind).toBe("batch");
  });

  it("refuses an over-long batch rather than truncating it", () => {
    const messages = Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => ({ jsonrpc: "2.0", method: "ping", id: i }));
    const parsed = parseBatch(messages);
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.code).toBe(JSONRPC_ERRORS.invalidRequest);
  });

  it("refuses an empty batch (specification §6)", () => {
    expect(parseBatch([]).kind).toBe("error");
  });
});

describe("response shapes", () => {
  it("a success and a failure are never both present", () => {
    const ok = jsonRpcSuccess(1, { a: 1 });
    expect(ok).toEqual({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect("error" in ok).toBe(false);

    const bad = jsonRpcError(1, JSONRPC_ERRORS.methodNotFound, "unknown method: x");
    expect(bad).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown method: x" } });
    expect("result" in bad).toBe(false);
  });

  it("omits `data` unless it was given", () => {
    expect(jsonRpcError(null, -32603, "boom").error.data).toBeUndefined();
    expect(jsonRpcError(null, -32603, "boom", { hint: "x" }).error.data).toEqual({ hint: "x" });
  });

  it("uses the reserved codes, unchanged", () => {
    expect(JSONRPC_ERRORS).toEqual({
      parseError: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internalError: -32603,
    });
  });
});

describe("tool results", () => {
  it("wraps a payload in a text block every protocol revision understands", () => {
    const r = toolTextResult({ ticketNumber: 1042 });
    expect(r.content[0].type).toBe("text");
    expect(JSON.parse(r.content[0].text)).toEqual({ ticketNumber: 1042 });
    expect("isError" in r).toBe(false);
  });

  it("a tool failure is isError, not a JSON-RPC error", () => {
    const r = toolErrorResult("FORBIDDEN: comment:internal");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("FORBIDDEN: comment:internal");
  });
});
