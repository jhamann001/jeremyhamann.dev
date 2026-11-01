import http from "http";
import { randomUUID } from "crypto";
import { getAppBaseUrl, getMcpPublicUrl } from "@/lib/mcp/config";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import {
  validateMcpBearerToken,
  type McpPrincipal,
} from "@/lib/mcp/access-token";
import { hasScopes } from "@/lib/mcp/scopes";
import {
  callMcpTool,
  listMcpTools,
  requiredScopesForTool,
} from "@/lib/mcp/tools";
import { logger } from "@/lib/logger";

const MAX_BODY_BYTES = 1024 * 1024;
export const MCP_PATH = "/mcp";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_SERVER_INFO = { name: "transfer-tracker-mcp", version: "0.1.0" };

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.MCP_CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization,Content-Type,Mcp-Session-Id,MCP-Protocol-Version",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function writeJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function writeUnauthorized(res: http.ServerResponse) {
  writeJson(
    res,
    401,
    { error: "unauthorized" },
    {
      "WWW-Authenticate": `Bearer resource_metadata="${getMcpPublicUrl()}${RESOURCE_METADATA_PATH}", authorization_uri="${getAppBaseUrl()}/mcp/oauth/authorize"`,
    }
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(req: http.IncomingMessage, res: http.ServerResponse) {
  const requestId = req.headers["x-request-id"]?.toString() || randomUUID();

  // security scanner whcr-modelcontextprotocol-002: every JSON-RPC method on /mcp —
  // `initialize` and `notifications/initialized` included — must present a
  // valid bearer token (OAuth access token or mcp_pat_ personal token).
  // Session initialization used to answer before this check ran, which
  // handed any anonymous caller the protocol version, server info and
  // advertised capabilities. Authenticate before the body is even parsed so
  // nothing is dispatched, and no request payload is buffered, pre-auth.
  // Per-tool scopes are still enforced below, against this same principal.
  let principal: McpPrincipal;
  try {
    principal = await validateMcpBearerToken(req.headers.authorization);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unauthorized";
    // A globally disabled MCP is not an auth problem: answering 401 with a
    // WWW-Authenticate challenge would send clients into a pointless
    // re-authorization loop against a server that is switched off.
    if (message === "MCP is globally disabled") {
      logger.warn({ requestId }, "mcp request while globally disabled");
      writeJson(res, 503, rpcError(null, -32000, message));
      return;
    }
    logger.warn({ requestId, reason: message }, "mcp unauthenticated request");
    writeUnauthorized(res);
    return;
  }

  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(await readBody(req)) as JsonRpcRequest;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON";
    writeJson(res, message === "Request body too large" ? 413 : 400, rpcError(null, -32700, message));
    return;
  }

  const method = payload.method;

  if (method === "initialize") {
    logger.info({ requestId, user: principal.userEmail }, "mcp initialize");
    writeJson(
      res,
      200,
      rpcResult(payload.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      })
    );
    return;
  }

  if (method === "notifications/initialized") {
    writeJson(res, 202, {});
    return;
  }

  try {
    if (method === "tools/list") {
      logger.info({ requestId, user: principal.userEmail }, "mcp tools/list");
      writeJson(res, 200, rpcResult(payload.id, { tools: listMcpTools() }));
      return;
    }

    if (method === "tools/call") {
      const params = payload.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = "arguments" in params ? params.arguments : {};
      // Same message as access-token.ts so the 401 mapping below is uniform
      // whichever layer rejects the call.
      if (!hasScopes(principal.scopes, requiredScopesForTool(name))) {
        throw new Error("Insufficient MCP scope");
      }
      const result = await callMcpTool(name, args, principal, requestId);
      writeJson(
        res,
        200,
        rpcResult(payload.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        })
      );
      return;
    }

    writeJson(res, 404, rpcError(payload.id, -32601, "Method not found"));
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP request failed";
    if (/token|scope/i.test(message)) {
      writeUnauthorized(res);
      return;
    }
    logger.error({ err, requestId, method }, "mcp rpc failed");
    writeJson(res, 500, rpcError(payload.id, -32000, message));
  }
}

export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Deliberately unauthenticated: the Cloud Run health probe, and the
  // RFC 9728 discovery document a client must be able to read *before* it
  // holds a token. Neither exposes tools, capabilities or server internals.
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === RESOURCE_METADATA_PATH) {
    writeJson(res, 200, protectedResourceMetadata());
    return;
  }

  if (req.method === "POST" && url.pathname === MCP_PATH) {
    await handleRpc(req, res);
    return;
  }

  writeJson(res, 404, { error: "Not found" });
}
