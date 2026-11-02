import { beforeEach, describe, expect, it, vi } from "vitest";
const { paused } = vi.hoisted(() => ({ paused: vi.fn(() => false) }));
vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: paused }));
import middleware from "@/middleware";
type RequestShape = { nextUrl: URL; auth: unknown; method: string };
const run = middleware as unknown as (request: RequestShape) => Response | undefined;
const request = (path: string, auth: unknown = null, method = "GET") => ({ nextUrl: new URL(path, "https://example.test"), auth, method });
describe("Job monitoring API session expiry", () => {
  beforeEach(() => paused.mockReturnValue(false));
  it("returns private JSON401 for exact monitoring reads, never login HTML", async () => {
    for (const path of ["/api/data-health/jobs?q=synthetic", "/api/data-health/jobs/dev-synthetic/runs?cursor=opaque"]) {
      const response = run(request(path))!;
      expect(response.status).toBe(401); expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(run(request(path, { user: {} }))).toBeUndefined();
    }
  });
  it("does not exempt documents, siblings, or mutations from their existing gates", () => {
    for (const path of ["/data-health/jobs", "/api/data-health/jobs-admin", "/api/data-health/jobs/dev-synthetic/edit"]) expect(run(request(path))?.status).toBe(302);
    expect(run(request("/api/cron/data-jobs", null, "POST"))).toBeUndefined(); // dedicated OIDC route authenticates itself
    paused.mockReturnValue(true);
    expect(run(request("/api/cron/data-jobs", null, "POST"))?.status).toBe(503);
  });
});
