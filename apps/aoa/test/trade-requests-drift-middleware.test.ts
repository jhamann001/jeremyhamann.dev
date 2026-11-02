import { describe, expect, it, vi } from "vitest";
vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: () => false }));
import middleware from "@/middleware";
const run = middleware as unknown as (request: { auth: unknown; method: string; nextUrl: URL }) => Response | undefined;
const request = (path: string) => run({ auth: null, method: "GET", nextUrl: new URL(path, "https://ops-portal.example.test") })!;

describe("Drift and Roster JSON authentication boundary (ticket)", () => {
  it.each([
    "/api/trade-requests/roster", "/api/trade-requests/drift/history", "/api/trade-requests/drift/allow-list",
    "/api/trade-requests/drift/exclusion-overlap", "/api/trade-requests/drift/runs/2026-10-16",
    "/api/trade-requests/drift/overrides/SYNTH00000000000000ALPHA001",
  ])("returns a private 401 for %s, not the sign-in redirect", async (path) => {
    const response = request(path);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
  it.each(["/trade-requests/drift", "/trade-requests/roster", "/api/trade-requests/drift", "/api/trade-requests/drift/runs/a/b"])(
    "keeps the sign-in redirect for %s", (path) => {
      const response = request(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("callbackUrl=");
    },
  );
});
