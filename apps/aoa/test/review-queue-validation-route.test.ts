import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, flagSpy, validateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), flagSpy: vi.fn(), validateSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/cron/review-queue-auth", () => ({ requireReviewQueueCronAuth: authSpy }));
vi.mock("@/lib/flags", () => ({ reviewQueueMaterializationEnabled: flagSpy }));
vi.mock("@/lib/data/review-queue-validation", () => ({
  validateTradeReviewMaterialization: validateSpy,
}));

import * as route from "@/app/api/cron/review-queue/validate/route";

const post = (body: unknown) => new Request("https://ops-portal.example/api/cron/review-queue/validate", {
  method: "POST",
  headers: { authorization: "Bearer test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("review queue known-client validation", () => {
  beforeEach(() => {
    validateSpy.mockReset();
    authSpy.mockResolvedValue(true);
    flagSpy.mockReturnValue(true);
    validateSpy.mockResolvedValue({
      found: true,
      activeSignals: 2,
      ambiguityDetected: true,
      types: ["TRADE_PROFILE_CONFLICT", "TRADE_PROFILE_MULTIPLE_UNCONFIRMED"],
      maxCandidateCount: 3,
      maxAccountCount: 0,
      lastCheckedAt: "2026-08-19T16:00:00.000Z",
    });
  });

  it("accepts a reference only in the body and returns counts-only evidence", async () => {
    const response = await route.POST(post({ clientReference: "001EXAMPLE" }));
    expect(response.status).toBe(200);
    expect(validateSpy).toHaveBeenCalledWith("001EXAMPLE");
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("001EXAMPLE");
  });

  it("rejects malformed references and does no database validation", async () => {
    expect((await route.POST(post({ clientReference: "../client name" }))).status).toBe(400);
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("bounds a chunked or missing-length request body while reading it", async () => {
    const body = JSON.stringify({ clientReference: "A".repeat(5000) });
    const oversized = new Request("https://ops-portal.example/api/cron/review-queue/validate", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body,
    });
    expect(oversized.headers.get("content-length")).toBeNull();
    expect((await route.POST(oversized)).status).toBe(400);
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("is independently unavailable while materialization is dark", async () => {
    flagSpy.mockReturnValue(false);
    expect((await route.POST(post({ clientReference: "001EXAMPLE" }))).status).toBe(404);
    expect(validateSpy).not.toHaveBeenCalled();
  });
});
