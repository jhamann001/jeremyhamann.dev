import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `next-auth`'s entrypoint pulls in `next/server`, which vitest's node environment cannot resolve. The error
// classes come from the package it re-exports them from, so `instanceof AuthError` is the real check.
vi.mock("next-auth", async () => {
  const errors = await vi.importActual<typeof import("@auth/core/errors")>("@auth/core/errors");
  return { AuthError: errors.AuthError };
});

import { AuthError } from "next-auth";

const authMock = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/auth", () => authMock);

const devLoginMock = vi.hoisted(() => ({ DEV_PROVIDER_ID: "dev-persona", isDevLoginEnabled: vi.fn(() => true) }));
vi.mock("@/lib/dev-login", () => devLoginMock);

const loggerMock = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@/lib/logger", () => loggerMock);

import { POST } from "@/app/sign-in/persona/route";

function post(fields: Record<string, string>, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }): Request {
  return new Request("https://desk.wm-helpdesk.local/sign-in/persona", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function authErrorOfType(type: string): AuthError {
  const error = new AuthError("refused");
  (error as unknown as { type: string }).type = type;
  return error;
}

beforeEach(() => {
  devLoginMock.isDevLoginEnabled.mockReturnValue(true);
  authMock.signIn.mockResolvedValue("https://desk.wm-helpdesk.local/dashboard");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /sign-in/persona", () => {
  it("signs the persona in without Auth.js's own redirect and sends the browser to the destination", async () => {
    const res = await POST(post({ persona: "cs", callbackUrl: "/tickets/wm/2465" }));

    expect(authMock.signIn).toHaveBeenCalledWith("dev-persona", { persona: "cs", redirect: false });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/tickets/wm/2465");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sends a visitor who started at / back to /, which loads like any page (the case the server action broke)", async () => {
    const res = await POST(post({ persona: "ops", callbackUrl: "/" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("only ever sends the browser to a path on this site", async () => {
    for (const callbackUrl of ["https://evil.example/steal", "//evil.example", "https://0.0.0.0:3000/", ""]) {
      const res = await POST(post({ persona: "cs", callbackUrl }));
      expect(res.headers.get("Location"), callbackUrl).toBe("/dashboard");
    }
  });

  it("refuses a form posted from another site, without calling Auth.js", async () => {
    for (const headers of [
      { "sec-fetch-site": "cross-site" } as Record<string, string>,
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example", host: "desk.wm-helpdesk.local" },
      {},
    ]) {
      const res = await POST(post({ persona: "cs", callbackUrl: "/dashboard" }, headers));
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(authMock.signIn).not.toHaveBeenCalled();
  });

  it("accepts an older browser's same-origin form by its Origin header", async () => {
    const res = await POST(post({ persona: "cs" }, { origin: "https://desk.wm-helpdesk.local", host: "desk.wm-helpdesk.local" }));

    expect(res.status).toBe(303);
    expect(authMock.signIn).toHaveBeenCalledOnce();
  });

  it("turns a refusal into the sign-in page's own message, not a 500", async () => {
    authMock.signIn.mockRejectedValueOnce(authErrorOfType("AccessDenied"));

    const res = await POST(post({ persona: "cs", callbackUrl: "/dashboard" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/sign-in?error=AccessDenied");
  });

  it("logs a genuine fault and offers the page's try-again message", async () => {
    const boom = new Error("database is on fire");
    authMock.signIn.mockRejectedValueOnce(boom);

    const res = await POST(post({ persona: "cs", callbackUrl: "/dashboard" }));

    expect(res.headers.get("Location")).toBe("/sign-in?error=Callback");
    expect(loggerMock.logError).toHaveBeenCalledWith("route:/sign-in/persona", boom);
  });

  it("refuses without calling Auth.js when dev login is off, and says so on the sign-in page", async () => {
    devLoginMock.isDevLoginEnabled.mockReturnValue(false);

    const res = await POST(post({ persona: "cs", callbackUrl: "/dashboard" }));

    expect(res.headers.get("Location")).toBe("/sign-in?error=Configuration");
    expect(authMock.signIn).not.toHaveBeenCalled();
  });

  it("refuses a post with no persona without calling Auth.js", async () => {
    const res = await POST(post({ callbackUrl: "/dashboard" }));

    expect(res.headers.get("Location")).toBe("/sign-in?error=CredentialsSignin");
    expect(authMock.signIn).not.toHaveBeenCalled();
  });
});
