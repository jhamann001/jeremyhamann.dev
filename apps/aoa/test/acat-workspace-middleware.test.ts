import { describe, expect, it, vi } from "vitest";
vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: () => false }));
import middleware from "@/middleware";
const run = middleware as unknown as (request: { auth: unknown; method: string; nextUrl: URL }) => Response | undefined;
describe("ACAT workspace JSON authentication boundary", () => {
  it.each(["/api/acat-workspace?view=library", "/api/diagnostics/acat-legacy-links"])("returns a private 401 for %s, not branded HTML", async (path) => {
    const response = run({ auth: null, method: "GET", nextUrl: new URL(path, "https://ops-portal.example.test") })!;
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
  it.each(["/api/acat-workspace-extra", "/api/acat-workspace/nested", "/acat-tracking"])("preserves the existing redirect for %s", (path) => {
    const response = run({ auth: null, method: "GET", nextUrl: new URL(path, "https://ops-portal.example.test") })!;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("callbackUrl=");
  });
  it("still requires the endpoint's own role check for an authenticated request", () => {
    expect(run({ auth: { user: { role: "ADVISOR" } }, method: "GET", nextUrl: new URL("https://ops-portal.example.test/api/acat-workspace") })).toBeUndefined();
  });
});
