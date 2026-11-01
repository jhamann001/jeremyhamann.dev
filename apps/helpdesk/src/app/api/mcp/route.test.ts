/**
 * POST /api/mcp — the route handler, driven with fetch-like requests.
 *
 * The tool registry is mocked here on purpose: this file is about the TRANSPORT and the four gates in
 * front of it — the feature flag, the body cap, the bearer and the rate limit — plus JSON-RPC framing
 * end to end. What the six tools actually do is proved against the desk's own modules in
 * `src/server/mcp/registry.test.ts`.
 *
 * Nothing here connects to a database: `@/lib/db`, `@/lib/env` and every module that touches either
 * are mocked, so the handler runs exactly as it does in production with the I/O replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test" as const,
    // Composed from its parts at run time: a literal `postgresql://USER:PASSWORD@HOST/DB` is a security scanner
    // secret finding in any tracked file, tests included, even for a database nothing dials.
    // `vi.hoisted` / `vi.mock` run before imports, so `@/test-support/db-url` cannot be called from in
    // here; this is that module's `unitDatabaseUrl()` written as one expression.
    DATABASE_URL: Object.assign(new URL("postgresql://localhost:5432/unit_never_connects"), {
      username: "unit",
      password: "unit",
    }).toString(),
    APP_ENV: "local" as const,
    TRUSTED_PROXY_HOPS: 0,
    MCP_ENABLED: true,
  },
  assertServingInvariants: vi.fn(),
}));
vi.mock("@/lib/env", () => mockEnv);

vi.mock("@/lib/db", () => ({ prisma: {}, withTx: vi.fn() }));

vi.mock("@/lib/request-context", () => ({
  getRequestContextFromRequest: () => ({
    ipAddress: "203.0.113.9",
    userAgent: "vitest",
    requestId: "req-mcp-1",
    isPrefetch: false,
  }),
}));

/** Loose signatures on purpose: a mock's job here is to record calls, not to re-declare a contract. */
const mockTokens = vi.hoisted(() => ({
  verifyApiToken: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, null)),
  apiTokenActor: (id: string | null) => ({ id: null, email: id === null ? "token:legacy" : `token:${id}`, groups: [] }),
}));
vi.mock("@/lib/api-tokens", () => mockTokens);

const mockAudit = vi.hoisted(() => ({
  AUDIT_VIA: { api: "api", email: "email", clientApp: "client-app", job: "job", mcp: "mcp", import: "import" },
  writeAudit: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
}));
vi.mock("@/lib/audit", () => mockAudit);

const mockThrottle = vi.hoisted(() => ({
  recordUnauthenticatedClientDenial: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
}));
vi.mock("@/lib/denial-throttle", () => mockThrottle);

const mockLimit = vi.hoisted(() => ({
  enforceMachineRateLimit: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, null)),
}));
vi.mock("@/lib/integration-auth", () => mockLimit);

const mockContext = vi.hoisted(() => ({
  resolveMcpCaller: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, null)),
}));
vi.mock("@/server/mcp/context", () => mockContext);

const pingTool = vi.hoisted(() => ({
  name: "search_tickets",
  description: "test double",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
}));
const explodingTool = vi.hoisted(() => ({
  name: "add_internal_note",
  description: "test double that fails",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: vi.fn(async (...a: unknown[]): Promise<unknown> => {
    void a;
    throw new Error("kaboom: ticket body 4111 1111 1111 1111");
  }),
}));
vi.mock("@/server/mcp/registry", () => ({
  MCP_TOOLS_BY_NAME: new Map([
    [pingTool.name, pingTool],
    [explodingTool.name, explodingTool],
  ]),
  toolDescriptors: () => [
    { name: pingTool.name, description: pingTool.description, inputSchema: pingTool.inputSchema },
    { name: explodingTool.name, description: explodingTool.description, inputSchema: explodingTool.inputSchema },
  ],
}));

import { GET, POST } from "./route";

/** Duck-typed so a body can be a stream with no declared content-length, like a chunked request. */
function post(body: string | ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}): Request {
  const stream =
    typeof body === "string"
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        })
      : body;
  return {
    url: "https://wm-helpdesk.local/api/mcp",
    method: "POST",
    headers: new Headers({ "content-type": "application/json", authorization: "Bearer wmhd_ab12cd34.secret", ...headers }),
    body: stream,
  } as unknown as Request;
}

function rpc(method: string, params?: unknown, id: unknown = 1): string {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) message.params = params;
  if (id !== undefined) message.id = id;
  return JSON.stringify(message);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.env.MCP_ENABLED = true;
  mockTokens.verifyApiToken.mockResolvedValue({ id: "tok_1", scopes: ["MCP"], requesterEmail: null });
  mockContext.resolveMcpCaller.mockResolvedValue({
    token: { id: "tok_1", scopes: ["MCP"], requesterEmail: null },
    viewer: { id: "u_1", email: "mia@wm.local", name: "Mia", image: null, groups: ["ops_team"], isDev: false },
    actor: { id: "u_1", email: "mia@wm.local", groups: ["ops_team"] },
    isStaff: true,
  });
  mockLimit.enforceMachineRateLimit.mockResolvedValue(null);
  pingTool.handler.mockImplementation(async (...a: unknown[]) => ({ echoed: a[0] }));
});

describe("the MCP_ENABLED gate", () => {
  it("404s to everyone when the key is unset — bearer or not, POST or GET", async () => {
    mockEnv.env.MCP_ENABLED = false;
    const res = await POST(post(rpc("ping")));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
    // The bearer is never even looked at: a disabled feature does not authenticate callers.
    expect(mockTokens.verifyApiToken).not.toHaveBeenCalled();

    const get = await GET();
    expect(get.status).toBe(404);
  });

  it("answers 405 on GET when it IS enabled, so the verb is the only thing that differs", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("never caches, whatever the answer", async () => {
    const res = await POST(post(rpc("ping")));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("the bearer", () => {
  it("401s and records ONE coalesced denial when the token does not verify", async () => {
    mockTokens.verifyApiToken.mockResolvedValue(null);
    const res = await POST(post(rpc("ping")));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mockThrottle.recordUnauthenticatedClientDenial).toHaveBeenCalledTimes(1);
    expect(mockThrottle.recordUnauthenticatedClientDenial.mock.calls[0][1]).toBe("/api/mcp");
  });

  it("requires the MCP scope specifically", async () => {
    await POST(post(rpc("ping")));
    expect(mockTokens.verifyApiToken.mock.calls[0][1]).toBe("MCP");
  });

  it("401s with an attributable row when the credential's creator is deactivated", async () => {
    mockContext.resolveMcpCaller.mockResolvedValue(null);
    const res = await POST(post(rpc("ping")));
    expect(res.status).toBe(401);
    expect(mockThrottle.recordUnauthenticatedClientDenial).not.toHaveBeenCalled();
    expect(mockAudit.writeAudit).toHaveBeenCalledTimes(1);
    const entry = mockAudit.writeAudit.mock.calls[0][3] as unknown as {
      newValue: string;
      entityType: string;
      entityId: string;
    };
    expect(entry.newValue).toBe("mcp:creator-inactive");
    expect(entry.entityType).toBe("API_TOKEN");
    expect(entry.entityId).toBe("tok_1");
  });
});

describe("the rate limit", () => {
  it("429s with Retry-After and never reaches a tool", async () => {
    mockLimit.enforceMachineRateLimit.mockResolvedValue({ resetAt: new Date(), retryAfterSeconds: 37 });
    const res = await POST(post(rpc("tools/call", { name: "search_tickets", arguments: {} })));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("37");
    expect(pingTool.handler).not.toHaveBeenCalled();
  });

  it("spends the credential's own bucket, not a shared one", async () => {
    await POST(post(rpc("ping")));
    const call = mockLimit.enforceMachineRateLimit.mock.calls[0];
    expect(call[1]).toBe("/api/mcp");
    expect(call[2]).toEqual({ kind: "token", tokenId: "tok_1", scopes: ["MCP"] });
  });
});

describe("the body", () => {
  it("refuses a body larger than the cap without buffering it, and runs no tool", async () => {
    // 1 MiB offered with no declared length: the shape a content-length check cannot see.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 64) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(32 * 1024).fill(0x20));
      },
    });
    const res = await POST(post(stream));
    expect(res.status).toBe(413);
    expect(pingTool.handler).not.toHaveBeenCalled();
  });

  it("answers a JSON-RPC parse error for a body that is not JSON", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });
});

describe("protocol methods", () => {
  it("initialize echoes a version it speaks and advertises tools only", async () => {
    const res = await POST(post(rpc("initialize", { protocolVersion: "2024-11-05" })));
    const body = (await res.json()) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe("wm-helpdesk");
  });

  it("initialize falls back to the newest version it speaks for an unknown request", async () => {
    const res = await POST(post(rpc("initialize", { protocolVersion: "1999-01-01" })));
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("answers notifications/initialized with 202 and NO body", async () => {
    const res = await POST(post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("ping answers an empty result", async () => {
    const res = await POST(post(rpc("ping", undefined, "p1")));
    await expect(res.json()).resolves.toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
  });

  it("tools/list returns every tool's name, description and schema", async () => {
    const res = await POST(post(rpc("tools/list")));
    const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["search_tickets", "add_internal_note"]);
    expect(body.result.tools[0].inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("an unknown method is -32601 and an unknown tool is -32602", async () => {
    const unknownMethod = (await (await POST(post(rpc("resources/list")))).json()) as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);

    const unknownTool = (await (await POST(post(rpc("tools/call", { name: "delete_everything" })))).json()) as {
      error: { code: number };
    };
    expect(unknownTool.error.code).toBe(-32602);

    const noName = (await (await POST(post(rpc("tools/call", {})))).json()) as { error: { code: number } };
    expect(noName.error.code).toBe(-32602);
  });
});

describe("the MCP-Protocol-Version header", () => {
  it("states the version initialize negotiated, not the newest this server speaks", async () => {
    const res = await POST(post(rpc("initialize", { protocolVersion: "2024-11-05" })));
    const body = (await res.json()) as { result: { protocolVersion: string } };
    // The header and the negotiated result must agree, or a client that trusts one over the other
    // assumes features the revision it negotiated does not have.
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2024-11-05");
  });

  it("falls back to the newest version when initialize asked for one this server does not speak", async () => {
    const res = await POST(post(rpc("initialize", { protocolVersion: "1999-01-01" })));
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
  });

  it("echoes the inbound header on a later request in the session", async () => {
    const res = await POST(post(rpc("ping"), { "MCP-Protocol-Version": "2025-03-26" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
  });

  it("tolerates surrounding whitespace in the inbound header", async () => {
    const res = await POST(post(rpc("ping"), { "MCP-Protocol-Version": "  2024-11-05 " }));
    expect(res.status).toBe(200);
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2024-11-05");
  });

  it("answers the newest version it speaks when the header is absent", async () => {
    const res = await POST(post(rpc("ping")));
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
  });

  it("carries the negotiated version on the 202 a notification-only POST answers", async () => {
    const res = await POST(
      post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), {
        "MCP-Protocol-Version": "2025-03-26",
      }),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2025-03-26");
  });

  it("lets an initialize in the request override the inbound header", async () => {
    const res = await POST(post(rpc("initialize", { protocolVersion: "2024-11-05" }), { "MCP-Protocol-Version": "2025-03-26" }));
    expect(res.headers.get("MCP-Protocol-Version")).toBe("2024-11-05");
  });

  it("400s an inbound header naming a version it does not speak, and runs no tool", async () => {
    const res = await POST(
      post(rpc("tools/call", { name: "search_tickets", arguments: {} }), { "MCP-Protocol-Version": "2030-01-01" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toContain("unsupported MCP-Protocol-Version");
    expect(pingTool.handler).not.toHaveBeenCalled();
  });

  it("refuses a bad inbound header only AFTER the bearer and the limit, so a probe learns nothing", async () => {
    mockTokens.verifyApiToken.mockResolvedValue(null);
    const unauth = await POST(post(rpc("ping"), { "MCP-Protocol-Version": "2030-01-01" }));
    expect(unauth.status).toBe(401);

    mockEnv.env.MCP_ENABLED = false;
    const off = await POST(post(rpc("ping"), { "MCP-Protocol-Version": "2030-01-01" }));
    expect(off.status).toBe(404);
  });
});

describe("tools/call", () => {
  it("passes the arguments through and wraps the result in a text block", async () => {
    const res = await POST(post(rpc("tools/call", { name: "search_tickets", arguments: { query: "wire" } })));
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(pingTool.handler).toHaveBeenCalledTimes(1);
    expect(pingTool.handler.mock.calls[0][0]).toEqual({ query: "wire" });
    expect(JSON.parse(body.result.content[0].text)).toEqual({ echoed: { query: "wire" } });
  });

  it("reports a thrown tool failure as isError, and never echoes an unknown error's message", async () => {
    const res = await POST(post(rpc("tools/call", { name: "add_internal_note", arguments: {} })));
    const body = (await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(res.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("the tool failed");
    // I14: an unknown error's message can quote a row, so it never reaches the caller.
    expect(JSON.stringify(body)).not.toContain("4111");
  });
});

describe("batches", () => {
  it("answers each message in order, and omits notifications from the response array", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", method: "ping", id: "a" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "tools/list", id: "b" },
    ]);
    const res = await POST(post(batch));
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("refuses an over-long batch rather than answering the first few", async () => {
    const batch = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({ jsonrpc: "2.0", method: "ping", id: i })),
    );
    const res = await POST(post(batch));
    expect(res.status).toBe(400);
    expect(pingTool.handler).not.toHaveBeenCalled();
  });

  it("a malformed member of a batch fails alone", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", method: "ping", id: "a" },
      { jsonrpc: "1.0", method: "ping", id: "b" },
    ]);
    const body = (await (await POST(post(batch))).json()) as Array<Record<string, unknown>>;
    expect(body[0]).toHaveProperty("result");
    expect(body[1]).toHaveProperty("error");
  });

  it("a batch of only notifications is 202 with no body", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
    ]);
    const res = await POST(post(batch));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("prototype-pollution-safe parsing reaches the handler", () => {
  it("a __proto__ key in arguments never reaches a tool", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_tickets", arguments: { __proto__: { polluted: true }, query: "ok" } },
    });
    await POST(post(body));
    const received = pingTool.handler.mock.calls[0][0] as Record<string, unknown>;
    expect(received).toEqual({ query: "ok" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
