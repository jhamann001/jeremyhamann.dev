import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyIdToken, findUnique, rateLimit, logError } = vi.hoisted(() => ({
  verifyIdToken: vi.fn(), findUnique: vi.fn(),
  rateLimit: vi.fn(), logError: vi.fn(),
}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verifyIdToken; } }));
vi.mock("@/lib/prisma", () => ({ prisma: { custodianFeeScheduleDocument: { findUnique } } }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError, warn: vi.fn() } }));

import * as route from "./route";

const SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const token = (email = SA, email_verified = true) => ({ getPayload: () => ({ email, email_verified }) });
const request = (authorization = "Bearer synthetic") =>
  new Request("https://tracker.test/api/machine/custodians/fee-schedules/d1", {
    headers: { authorization },
  });
const params = Promise.resolve({ documentId: "d1" });

const content = Buffer.from("synthetic-fee-schedule");
const sha256 = "65c53ce90264b5b6a0292531bafb20ca44f9e52d5ae1c4f1e80d84a17a00d5b3";
const createdAt = new Date("2026-01-02T03:04:05.000Z");
const document = {
  id: "d1", filename: "schedule.pdf", contentType: "application/pdf",
  byteSize: 22, sha256, content, createdAt, createdBy: "admin@example.test",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.ALLOW_CUSTODIAN_SNAPSHOT_EXPORT;
  verifyIdToken.mockResolvedValue(token());
  rateLimit.mockResolvedValue({ allowed: true });
  findUnique.mockResolvedValue(null);
});

describe("machine custodian fee-schedule byte endpoint", () => {
  it("flag off returns not_found", async () => {
    for (const value of [undefined, "0", "true"] as const) {
      delete process.env.ALLOW_CUSTODIAN_SNAPSHOT_EXPORT;
      if (value !== undefined) vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", value);
      const res = await route.GET(request(), { params });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(findUnique).not.toHaveBeenCalled();
    }
  });

  it("flag on rejects an unauthorized caller", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    const res = await route.GET(request("Bearer "), { params });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("flag on returns the matching file bytes", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findUnique.mockResolvedValue(document);
    const res = await route.GET(request(), { params });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("22");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="schedule.pdf"');
  });

  it("refuses the snapshot when the downloaded bytes do not match", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findUnique.mockResolvedValue({ ...document, sha256: "0".repeat(64) });
    const res = await route.GET(request(), { params });
    expect(res.status).toBe(409);
    const body = Buffer.from(await res.arrayBuffer());
    expect(JSON.parse(body.toString())).toEqual({ error: "snapshot_refused" });
    expect(body.equals(content)).toBe(false);
  });

  it("returns not_found for a missing document", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findUnique.mockResolvedValue(null);
    const res = await route.GET(request(), { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("rate limits before reading", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    rateLimit.mockResolvedValue({ allowed: false });
    const res = await route.GET(request(), { params });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(findUnique).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith("machine-custodian-snapshot-file", SA, {
      maxTokens: 120, interval: 60_000,
    });
  });

  it("exports GET only", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "revalidate", "runtime"]);
  });
});
