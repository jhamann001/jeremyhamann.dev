/**
 * POST / DELETE /api/push/subscribe — the handler, driven with fetch-like requests.
 *
 * The two actions are mocked: what this file is about is the TRANSPORT and the three gates in front
 * of it — the feature flag, the session, and the bounded body — plus the `ActionResult` → HTTP
 * mapping. What the actions themselves write is proved against a real database in
 * `src/server/push.actions.integration.test.ts`.
 *
 * Nothing here connects to a database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  env: { NODE_ENV: "test" as const, APP_ENV: "local" as const },
  isWebPushEnabled: vi.fn(() => true),
}));
vi.mock("@/lib/env", () => mockEnv);

const mockSession = vi.hoisted(() => ({ requireViewerOrThrow: vi.fn() }));
vi.mock("@/lib/session", () => mockSession);

const mockActions = vi.hoisted(() => ({ subscribePush: vi.fn(), unsubscribePush: vi.fn() }));
vi.mock("@/server/push.actions", () => mockActions);

const { UnauthorizedError } = await import("@/lib/errors");
const { DELETE, POST } = await import("@/app/api/push/subscribe/route");

const VIEWER = { id: "u1", email: "ops@wm-helpdesk.local", name: "Otto", image: null, groups: ["ops_team"], isDev: false };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const KEYS = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

function request(method: string, body: unknown): Request {
  return new Request("https://desk.wm-helpdesk.local/api/push/subscribe", {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.isWebPushEnabled.mockReturnValue(true);
  mockSession.requireViewerOrThrow.mockResolvedValue(VIEWER);
  mockActions.subscribePush.mockResolvedValue({ ok: true, data: { id: "sub_1" } });
  mockActions.unsubscribePush.mockResolvedValue({ ok: true, data: { deleted: true } });
});

describe("the feature gate", () => {
  it("404s both methods before authentication when the VAPID keys are unset", async () => {
    mockEnv.isWebPushEnabled.mockReturnValue(false);
    for (const response of [
      await POST(request("POST", { endpoint: ENDPOINT, keys: KEYS })),
      await DELETE(request("DELETE", { endpoint: ENDPOINT })),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(mockSession.requireViewerOrThrow).not.toHaveBeenCalled();
    expect(mockActions.subscribePush).not.toHaveBeenCalled();
    expect(mockActions.unsubscribePush).not.toHaveBeenCalled();
  });
});

describe("the session gate", () => {
  it("answers 401, not a redirect — the service worker cannot follow one", async () => {
    mockSession.requireViewerOrThrow.mockRejectedValue(new UnauthorizedError("no session"));
    const response = await POST(request("POST", { endpoint: ENDPOINT, keys: KEYS }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(mockActions.subscribePush).not.toHaveBeenCalled();
  });
});

describe("POST", () => {
  it("hands the browser's own subscription shape to the action and returns its id", async () => {
    const response = await POST(request("POST", { endpoint: ENDPOINT, keys: KEYS, replaces: "https://old.example/x" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "sub_1" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockActions.subscribePush).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      keys: KEYS,
      replaces: "https://old.example/x",
    });
  });

  it("drops a `replaces` that is not a string rather than coercing one", async () => {
    await POST(request("POST", { endpoint: ENDPOINT, keys: KEYS, replaces: 42 }));
    expect(mockActions.subscribePush).toHaveBeenCalledWith({ endpoint: ENDPOINT, keys: KEYS, replaces: undefined });
  });

  it("400s a body that is not a JSON object, without calling the action", async () => {
    for (const body of ["", "not json", "[]", "null", '"a string"']) {
      const response = await POST(request("POST", body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockActions.subscribePush).not.toHaveBeenCalled();
  });

  it("refuses an oversized body at the stream rather than after buffering it", async () => {
    const huge = JSON.stringify({ endpoint: ENDPOINT, keys: KEYS, pad: "x".repeat(20_000) });
    const response = await POST(request("POST", huge));
    expect(response.status).toBe(400);
    expect(mockActions.subscribePush).not.toHaveBeenCalled();
  });

  it("maps the action's refusals onto status codes without leaking a body", async () => {
    const cases = [
      [{ ok: false, code: "VALIDATION", message: "p256dh must be 65 bytes of base64url" }, 400],
      [{ ok: false, code: "NOT_FOUND", message: "x" }, 404],
      [{ ok: false, code: "FORBIDDEN", message: "x" }, 403],
      [{ ok: false, code: "CONFLICT", message: "x" }, 409],
      [{ ok: false, code: "INTERNAL", message: "x" }, 500],
    ] as const;
    for (const [result, status] of cases) {
      mockActions.subscribePush.mockResolvedValueOnce(result);
      const response = await POST(request("POST", { endpoint: ENDPOINT, keys: KEYS }));
      expect(response.status, result.code).toBe(status);
      const payload = (await response.json()) as Record<string, unknown>;
      // Only a VALIDATION failure explains itself, and only about the shape of a subscription.
      if (result.code === "VALIDATION") expect(payload.message).toContain("base64url");
      else expect(payload.message).toBeUndefined();
    }
  });
});

describe("DELETE", () => {
  it("removes the named endpoint and reports whether anything was there", async () => {
    const response = await DELETE(request("DELETE", { endpoint: ENDPOINT }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(mockActions.unsubscribePush).toHaveBeenCalledWith({ endpoint: ENDPOINT });
  });

  it("400s without an endpoint", async () => {
    for (const body of [{}, { endpoint: 42 }, ""]) {
      expect((await DELETE(request("DELETE", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(mockActions.unsubscribePush).not.toHaveBeenCalled();
  });

  it("answers 404 for an endpoint that is not the viewer's, with no body to probe with", async () => {
    mockActions.unsubscribePush.mockResolvedValueOnce({ ok: false, code: "NOT_FOUND", message: "subscription not found" });
    const response = await DELETE(request("DELETE", { endpoint: ENDPOINT }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
