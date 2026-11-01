import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "stream";
import type { IncomingMessage, ServerResponse } from "http";

const mockValidate = vi.fn();
const mockCallTool = vi.fn();

vi.mock("@/lib/mcp/access-token", () => ({
  validateMcpBearerToken: (...args: unknown[]) => mockValidate(...args),
}));
vi.mock("@/lib/mcp/tools", () => ({
  callMcpTool: (...args: unknown[]) => mockCallTool(...args),
  listMcpTools: () => [{ name: "search_acats" }],
  requiredScopesForTool: (name: string) =>
    name === "search_acats" ? ["acats:read"] : [],
}));
vi.mock("@/lib/mcp/oauth", () => ({
  protectedResourceMetadata: () => ({ resource: "https://mcp.test" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleMcpRequest } = await import("./handler");

const PRINCIPAL = {
  userEmail: "ops@example.com",
  connectionId: null,
  clientId: "pat:token-1",
  scopes: ["acats:read"],
  role: "ADMIN" as const,
};

function makeRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = options.method ?? "POST";
  req.url = options.url ?? "/mcp";
  req.headers = { host: "mcp.test", ...(options.headers ?? {}) };
  stream.end(options.body === undefined ? "" : JSON.stringify(options.body));
  return req;
}

type CapturedResponse = ServerResponse & {
  status: number;
  sentHeaders: Record<string, string>;
  body: string;
};

function makeResponse(): CapturedResponse {
  const chunks: string[] = [];
  const res = {
    status: 0,
    sentHeaders: {} as Record<string, string>,
    get body() {
      return chunks.join("");
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.status = status;
      Object.assign(res.sentHeaders, headers ?? {});
      return res;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      return res;
    },
  };
  return res as unknown as CapturedResponse;
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = makeResponse();
  await handleMcpRequest(makeRequest({ body, headers }), res);
  return res;
}

describe("handleMcpRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockResolvedValue(PRINCIPAL);
  });

  // security scanner whcr-modelcontextprotocol-002 / finding 5b630d28-f450-5eeb-8e3a-937bffe834ad
  it("rejects unauthenticated initialize without leaking server info", async () => {
    mockValidate.mockRejectedValue(new Error("Missing bearer token"));

    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(401);
    expect(res.sentHeaders["WWW-Authenticate"]).toContain(
      "oauth-protected-resource"
    );
    expect(res.body).not.toContain("serverInfo");
    expect(res.body).not.toContain("protocolVersion");
    expect(res.body).not.toContain("transfer-tracker-mcp");
  });

  it("rejects unauthenticated notifications/initialized", async () => {
    mockValidate.mockRejectedValue(new Error("Missing bearer token"));

    const res = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(res.status).toBe(401);
  });

  it("rejects initialize when the bearer token is invalid", async () => {
    mockValidate.mockRejectedValue(new Error("Invalid bearer token"));

    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { authorization: "Bearer mcp_pat_revoked" }
    );

    expect(res.status).toBe(401);
    expect(res.body).not.toContain("serverInfo");
  });

  it("completes the handshake for a valid token", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { authorization: "Bearer mcp_pat_valid" }
    );

    expect(mockValidate).toHaveBeenCalledWith("Bearer mcp_pat_valid");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.serverInfo.name).toBe("transfer-tracker-mcp");
    expect(parsed.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers 503 without an auth challenge when MCP is globally disabled", async () => {
    mockValidate.mockRejectedValue(new Error("MCP is globally disabled"));

    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { authorization: "Bearer mcp_pat_valid" }
    );

    expect(res.status).toBe(503);
    expect(res.sentHeaders["WWW-Authenticate"]).toBeUndefined();
  });

  it("rejects tools/list without a token", async () => {
    mockValidate.mockRejectedValue(new Error("Missing bearer token"));

    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(res.status).toBe(401);
    expect(res.body).not.toContain("search_acats");
  });

  it("still enforces per-tool scopes on tools/call", async () => {
    mockValidate.mockResolvedValue({ ...PRINCIPAL, scopes: ["fees:read"] });

    const res = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_acats", arguments: {} },
      },
      { authorization: "Bearer mcp_pat_valid" }
    );

    expect(res.status).toBe(401);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it("runs tools/call when the token carries the required scope", async () => {
    mockCallTool.mockResolvedValue({ items: [] });

    const res = await post(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search_acats", arguments: {} },
      },
      { authorization: "Bearer mcp_pat_valid" }
    );

    expect(res.status).toBe(200);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it("keeps /health and the protected-resource metadata public", async () => {
    const health = makeResponse();
    await handleMcpRequest(
      makeRequest({ method: "GET", url: "/health" }),
      health
    );

    const metadata = makeResponse();
    await handleMcpRequest(
      makeRequest({
        method: "GET",
        url: "/.well-known/oauth-protected-resource",
      }),
      metadata
    );

    expect(health.status).toBe(200);
    expect(metadata.status).toBe(200);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});
