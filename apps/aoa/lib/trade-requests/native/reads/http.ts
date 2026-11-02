import { ZodError, type z } from "zod";
import type { TradeRequestCall } from "../../client";
import { finalResult } from "../../service-response";
import type { NativeActor, NativeHandler } from "../registry";

// The standalone service's HTTP behavior for native reads: route matching as
// Express does it (case-insensitive, optional trailing slash), its error handler
// (server/src/middleware/errorHandler.ts:22-53 at d41b6c9) and its JSON bytes.

export type NativeResponse = { status: number; body: unknown };

/** The service's AppError: answered as `{ error: message }` with this status (5xx answers never show the message). */
export class NativeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type NativeRoute = {
  method: TradeRequestCall["method"];
  pattern: RegExp;
  run: (params: string[], call: TradeRequestCall, actor: NativeActor) => Promise<NativeResponse>;
};

export const SEGMENT = "([^/]+)";

/** The service validates with Zod 3, which reports a missing value as "Required". */
export const SERVICE_PARSE: { error: z.core.$ZodErrorMap } = {
  error: (issue) => (issue.input === undefined ? "Required" : undefined),
};

export function route(method: NativeRoute["method"], template: string, run: NativeRoute["run"]): NativeRoute {
  return { method, pattern: new RegExp(`^${template}/?$`, "i"), run };
}

export const ok = (body: unknown): NativeResponse => ({ status: 200, body });

/** The call's query as Express parses it: every value a string. */
export function queryOf(call: TradeRequestCall): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(call.query ?? {})) if (value !== undefined) out[name] = String(value);
  return out;
}

/** The call's body as the service receives it (JSON on the wire). */
export function bodyOf(call: TradeRequestCall): unknown {
  return call.body === undefined ? undefined : JSON.parse(JSON.stringify(call.body));
}

function errorResponse(error: unknown): NativeResponse {
  if (error instanceof ZodError) {
    return { status: 400, body: { error: "Validation failed", details: error.issues.map((e) => ({ path: e.path, message: e.message })) } };
  }
  if (error instanceof NativeHttpError) {
    return { status: error.status, body: { error: error.status >= 500 ? "Internal server error" : error.message } };
  }
  return { status: 500, body: { error: "Internal server error" } };
}

export function nativeRoutes(...routes: NativeRoute[]): NativeHandler {
  return async (call, actor) => {
    let response: NativeResponse;
    try {
      const match = routes.find((r) => r.method === call.method && r.pattern.test(call.path));
      if (!match) {
        response = { status: 404, body: { error: "Not found" } };
      } else {
        const params = (match.pattern.exec(call.path) ?? []).slice(1).map((part) => decodeURIComponent(part));
        response = await match.run(params, call, actor);
      }
    } catch (error) {
      if (!(error instanceof ZodError) && !(error instanceof NativeHttpError)) {
        const code = (error as { code?: unknown } | null)?.code;
        console.error(JSON.stringify({ event: "trade_request_native_failed", operation: call.operation, code: typeof code === "string" ? code : "unknown" }));
      }
      response = errorResponse(error);
    }
    // JSON drops undefined fields and renders dates as ISO strings, as on the wire.
    return finalResult(call, response.status, JSON.parse(JSON.stringify(response.body ?? null)));
  };
}
