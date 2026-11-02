import { beforeEach, describe, expect, it, vi } from "vitest";

const { paused } = vi.hoisted(() => ({ paused: vi.fn(() => false) }));
vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: paused }));

import middleware from "@/middleware";

type MiddlewareRequest = { nextUrl: URL; auth: unknown; method: string };
const run = middleware as unknown as (request: MiddlewareRequest) => Response | undefined;
const request = (pathname: string, auth: unknown = null, method = "GET"): MiddlewareRequest => ({
  nextUrl: new URL(pathname, "https://example.test"), auth, method,
});

describe("Households API middleware session failure", () => {
  beforeEach(() => paused.mockReturnValue(false));

  it("returns private JSON401 only for the exact page-fetch route", async () => {
    const response = run(request("/api/households?page=2"))!;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Location")).toBeNull();
  });

  it("does not weaken authentication for authenticated fetches or sibling routes", () => {
    expect(run(request("/api/households", { user: { email: "synthetic@example.test" } }))).toBeUndefined();
    for (const path of ["/api/households-admin", "/api/households/nested", "/households"]) {
      const response = run(request(path))!;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toContain("callbackUrl=");
    }
  });

  it("returns JSON401 for only the two exact optional badge reads", async () => {
    for (const path of ["/api/navigation/badges", "/api/navigation/acat-count"]) {
      const response = run(request(path))!;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Location")).toBeNull();
      expect(run(request(path, { user: {} }))).toBeUndefined();
    }
    for (const path of ["/api/navigation/badges-admin", "/api/navigation/acat-count/nested"]) {
      expect(run(request(path))!.status).toBe(302);
    }
  });

  it("returns JSON401 for the exact household email search POST, never a redirect carrying it", async () => {
    const response = run(request("/api/navigation/household-email/search", null, "POST"))!;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Location")).toBeNull();
    expect(run(request("/api/navigation/household-email/search", { user: {} }, "POST"))).toBeUndefined();
    for (const path of ["/api/navigation/household-email/search/nested", "/api/navigation/household-email/searches"]) {
      expect(run(request(path, null, "POST"))!.status).toBe(302);
    }
  });

  it("retains maintenance writes protection while allowing authenticated reads", () => {
    paused.mockReturnValue(true);
    expect(run(request("/api/households", { user: {} }, "GET"))).toBeUndefined();
    expect(run(request("/api/households", { user: {} }, "POST"))?.status).toBe(503);
  });
});
