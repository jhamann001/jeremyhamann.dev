import { describe, expect, it, vi } from "vitest";
vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: () => false }));
import middleware from "@/middleware";
const run = middleware as unknown as (request: { auth: unknown; method: string; nextUrl: URL }) => Response | undefined;
describe("Trade Requests workspace JSON authentication boundary", () => {
  it.each(["/api/trade-requests/requests", "/api/trade-requests/counts", "/api/trade-requests/export"])("returns a private 401 for %s, not the sign-in redirect", async (path) => {
    const response = run({ auth: null, method: "GET", nextUrl: new URL(path, "https://ops-portal.example.test") })!;
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
  it.each(["/api/trade-requests/requests/extra", "/api/trade-requests", "/trade-requests/queue"])("preserves the existing redirect for %s", (path) => {
    const response = run({ auth: null, method: "GET", nextUrl: new URL(path, "https://ops-portal.example.test") })!;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("callbackUrl=");
  });
  it("leaves authenticated requests to the route's own flag and role checks", () => {
    expect(run({ auth: { user: { role: "VIEWER" } }, method: "GET", nextUrl: new URL("https://ops-portal.example.test/api/trade-requests/requests") })).toBeUndefined();
  });
});
