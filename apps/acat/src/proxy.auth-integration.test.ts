// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import { encode } from "next-auth/jwt";

// Exercise the real NextAuth cookie decoder, jwt/session callbacks, and proxy.
// Only external services are mocked; no production credentials/data are used.
const mocks = vi.hoisted(() => ({
  findAllowedUser: vi.fn(),
  queryRaw: vi.fn(),
  rateLimit: vi.fn(),
  headers: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { allowedUser: { findUnique: mocks.findAllowedUser }, $queryRaw: mocks.queryRaw },
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rate-limit-redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit-redis")>();
  return {
    ...actual,
    rateLimit: mocks.rateLimit,
    parseClientIp: () => "127.0.0.1",
    rateLimitKey: (email: string | null) => actual.rateLimitKey(email, "127.0.0.1"),
  };
});

const TEST_SECRET = "synthetic-acat-auth-regression-secret-not-a-live-credential";
const COOKIE_NAME = "authjs.session-token";
let proxy: typeof import("./proxy").default;
let requireAdmin: typeof import("@/lib/auth-helpers").requireAdmin;

async function runProxy(request: NextRequest): Promise<Response> {
  const response = await proxy(request, {} as NextFetchEvent);
  if (!(response instanceof Response)) throw new Error("Proxy did not return a response");
  return response;
}

async function requestWithCookie(path: string, role = "USER", method = "GET", email = "security-fixture@example.test") {
  const now = Math.floor(Date.now() / 1000);
  const cookie = await encode({
    secret: TEST_SECRET,
    salt: COOKIE_NAME,
    maxAge: 4 * 60 * 60,
    token: {
      email,
      role,
      // A newly checked cookie must still not outvote a changed DB role.
      lastRoleCheckAt: now,
      lastActivityAt: now,
    },
  });
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { cookie: `${COOKIE_NAME}=${cookie}` },
  });
}

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  vi.stubEnv("NEXTAUTH_SECRET", TEST_SECRET);
  vi.stubEnv("AUTH_URL", "http://localhost:3000");
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
  vi.stubEnv("AUTH_TRUST_HOST", "true");
  vi.stubEnv("DEV_AUTH_BYPASS", "0");
  proxy = (await import("./proxy")).default;
  requireAdmin = (await import("@/lib/auth-helpers")).requireAdmin;
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.findAllowedUser.mockResolvedValue({ active: true, role: "USER" });
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
});
afterAll(() => vi.unstubAllEnvs());

describe("protected proxy with real encrypted sessions", () => {
  it("allows a current USER and preserves security/rate headers", async () => {
    const request = await requestWithCookie("/api/acats");
    const response = await runProxy(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("Content-Security-Policy")).toContain("nonce-");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("119");
    expect(mocks.findAllowedUser).toHaveBeenCalledWith({
      where: { email: "security-fixture@example.test" },
      select: { active: true, role: true },
    });
  });

  it.each([
    ["/api/acats", "GET"],
    ["/api/acats", "POST"],
    ["/api/fees", "GET"],
    ["/api/fees", "POST"],
    ["/api/asset-mapping", "GET"],
    ["/api/asset-mapping/accounts", "GET"],
    ["/api/mcp/pat", "POST"],
  ])("denies a freshly demoted USER at %s %s", async (path, method) => {
    mocks.findAllowedUser.mockResolvedValue({ active: true, role: "ADVISOR" });
    const response = await runProxy(await requestWithCookie(path, "USER", method));
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  it.each([
    ["inactive", { active: false, role: "USER" }],
    ["deleted", null],
    ["unknown role", { active: true, role: "UNRECOGNIZED" }],
  ])("rejects a signed cookie when the current user is %s", async (_name, user) => {
    mocks.findAllowedUser.mockResolvedValue(user);
    const response = await runProxy(await requestWithCookie("/api/acats"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("fails closed when the current permission lookup fails", async () => {
    mocks.findAllowedUser.mockRejectedValue(new Error("synthetic unavailable database"));
    const response = await runProxy(await requestWithCookie("/api/acats"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("still allows a current ADVISOR's scoped surface", async () => {
    mocks.findAllowedUser.mockResolvedValue({ active: true, role: "ADVISOR" });
    const response = await runProxy(await requestWithCookie("/api/advisor/acats"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects to sign-in on the caller's own origin, not NEXTAUTH_URL's", async () => {
    // The container platform's start check calls "/" by this host over plain http and follows the
    // redirect; the public https address (NEXTAUTH_URL) is one it can't reach from there. Next turns
    // a same-origin Location into a relative one.
    const response = await runProxy(new NextRequest("http://containerstarthealthcheck/records?view=mine"));
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("http://containerstarthealthcheck/login?callbackUrl=%2Frecords%3Fview%3Dmine");
  });

  it("redirects a demoted browser to the advisor page", async () => {
    mocks.findAllowedUser.mockResolvedValue({ active: true, role: "ADVISOR" });
    const response = await runProxy(await requestWithCookie("/"));
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("http://localhost:3000/advisor");
  });

  it("cannot recover old ADMIN authority by rereading the original cookie in a handler", async () => {
    mocks.findAllowedUser.mockResolvedValue({ active: true, role: "USER" });
    const request = await requestWithCookie("/api/acats", "ADMIN");
    const response = await runProxy(request);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    // Route handlers read the original request cookie, not the Set-Cookie
    // response. They must independently refresh instead of trusting its role.
    mocks.headers.mockResolvedValue(request.headers);
    const gate = await requireAdmin();
    expect(gate).toBeInstanceOf(Response);
    expect((gate as Response).status).toBe(403);
    expect(mocks.findAllowedUser).toHaveBeenCalledTimes(2);
  });

  it("keys the API quota by account, and a demo persona's by account and visitor IP", async () => {
    await runProxy(await requestWithCookie("/api/acats"));
    expect(mocks.rateLimit).toHaveBeenLastCalledWith("api-auth-global", "user:security-fixture@example.test", expect.anything());

    await runProxy(await requestWithCookie("/api/acats", "USER", "GET", "jordan.reyes@example.com"));
    expect(mocks.rateLimit).toHaveBeenLastCalledWith("api-auth-global", "user:jordan.reyes@example.com", expect.anything());

    vi.stubEnv("PERSONA_SIGN_IN", "on");
    try {
      await runProxy(await requestWithCookie("/api/acats", "USER", "GET", "jordan.reyes@example.com"));
      expect(mocks.rateLimit).toHaveBeenLastCalledWith("api-auth-global", "user:jordan.reyes@example.com:ip:127.0.0.1", expect.anything());
      await runProxy(await requestWithCookie("/api/acats"));
      expect(mocks.rateLimit).toHaveBeenLastCalledWith("api-auth-global", "user:security-fixture@example.test", expect.anything());
    } finally {
      vi.stubEnv("PERSONA_SIGN_IN", "");
    }
  });

  it.each([
    "/login",
    "/api/auth/session",
    "/api/health",
    "/api/machine/acats",
    "/api/mcp/oauth/token",
    "/api/cron/daily-digest",
  ])("leaves independent authentication for public route %s intact", async (path) => {
    mocks.findAllowedUser.mockRejectedValue(new Error("must not be called"));
    const response = await runProxy(await requestWithCookie(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.findAllowedUser).not.toHaveBeenCalled();
  });
});

describe("the public demo's limits in the proxy", () => {
  const history = (entries: number, bytes = 0) =>
    mocks.queryRaw.mockResolvedValue([{ n: BigInt(entries), bytes: BigInt(bytes) }]);
  beforeEach(() => vi.stubEnv("PERSONA_SIGN_IN", "on"));
  afterEach(() => vi.stubEnv("PERSONA_SIGN_IN", ""));

  it("refuses changes once the record history is full, and still serves reads", async () => {
    history(20_000);
    const write = await runProxy(await requestWithCookie("/api/acats", "USER", "POST"));
    expect(write.status).toBe(429);
    expect((await write.json()).error).toBe("The demo holds up to 20,000 history entries until its nightly reset at 07:00 UTC. Please try again tomorrow.");
    const read = await runProxy(await requestWithCookie("/api/acats"));
    expect(read.headers.get("x-middleware-next")).toBe("1");
  });

  it("counts history bytes too, and lets changes through under both limits", async () => {
    history(10, 20 * 1024 * 1024);
    expect((await runProxy(await requestWithCookie("/api/acats/REC-1", "USER", "PATCH"))).status).toBe(429);
    history(10, 1000);
    const ok = await runProxy(await requestWithCookie("/api/acats/REC-1", "USER", "PATCH"));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
  });

  it("doesn't check history outside the demo", async () => {
    vi.stubEnv("PERSONA_SIGN_IN", "");
    const ok = await runProxy(await requestWithCookie("/api/acats", "USER", "POST"));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("gives building a transfer form its own tight limit", async () => {
    history(0);
    await runProxy(await requestWithCookie("/api/acats/REC-1/manual-form-recommendation", "USER", "POST"));
    expect(mocks.rateLimit).toHaveBeenLastCalledWith("transfer-form", expect.any(String), { maxTokens: 10, interval: 60_000 });
  });

  it.each(["/api/machine/acats", "/API/Cron/daily-digest", "/api/mcp/oauth/register", "/mcp/oauth/authorize", "/.well-known/oauth-protected-resource"])(
    "answers 404 for private path %s in a demo build", async (path) => {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
      try {
        const response = await runProxy(new NextRequest(`http://localhost:3000${path}`, { method: "POST" }));
        expect(response.status).toBe(404);
      } finally {
        vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
      }
    });

  it("leaves the nightly reset to its own token check in a demo build", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    try {
      const response = await runProxy(new NextRequest("http://localhost:3000/api/internal/demo-reset", { method: "POST" }));
      expect(response.status).not.toBe(404);
    } finally {
      vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    }
  });
});

