import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyIdToken, findMany, rateLimit, logError } = vi.hoisted(() => ({
  verifyIdToken: vi.fn(), findMany: vi.fn(),
  rateLimit: vi.fn(), logError: vi.fn(),
}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verifyIdToken; } }));
vi.mock("@/lib/prisma", () => ({ prisma: { custodian: { findMany } } }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError, warn: vi.fn() } }));

import * as route from "./route";

const SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const token = (email = SA, email_verified = true) => ({ getPayload: () => ({ email, email_verified }) });
const request = (authorization = "Bearer synthetic") =>
  new Request("https://tracker.test/api/machine/custodians/snapshot", { headers: { authorization } });

const content = Buffer.from("synthetic-fee-schedule");
const sha256 = "65c53ce90264b5b6a0292531bafb20ca44f9e52d5ae1c4f1e80d84a17a00d5b3";
const createdAt = new Date("2026-01-02T03:04:05.000Z");
const updatedAt = new Date("2026-01-03T03:04:05.000Z");
const row = {
  id: "c1", name: "Synthetic Custodian", reviewStatus: "VERIFIED", acatFeeAmount: 0,
  transferType: "ACAT_API", documentationStatus: "DOCUMENTED", dtcNumber: "1234",
  receivingAccountNumber: "000", signature: "client", letterOfAcceptance: "yes",
  medallionRequired: "no", liquidationMethod: "none", returnMethod: "mail",
  watchouts: "none", paperworkOnFile: true, transfersToDate: 2, avgProcessingDays: 7,
  contactEmail: "ops@example.test", contactMethod: "EMAIL", contactDetails: "desk",
  fees: [{
    id: "f1", feeType: "acat", accountType: "ANY", transferType: "FULL", direction: "IN",
    amount: 0, amountText: null, notes: null, documentation: null, createdAt, updatedAt,
  }],
  feeScheduleDocuments: [{
    id: "d1", filename: "schedule.pdf", contentType: "application/pdf",
    byteSize: 22, sha256, content, createdAt, createdBy: "admin@example.test",
  }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  delete process.env.MACHINE_AUTH_AUDIENCE;
  delete process.env.ALLOW_CUSTODIAN_SNAPSHOT_EXPORT;
  verifyIdToken.mockResolvedValue(token());
  rateLimit.mockResolvedValue({ allowed: true });
  findMany.mockResolvedValue([]);
});

describe("machine custodian snapshot endpoint", () => {
  it("flag off returns not_found", async () => {
    for (const value of [undefined, "0", "true"] as const) {
      delete process.env.ALLOW_CUSTODIAN_SNAPSHOT_EXPORT;
      if (value !== undefined) vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", value);
      const res = await route.GET(request());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(findMany).not.toHaveBeenCalled();
      expect(verifyIdToken).not.toHaveBeenCalled();
    }
  });

  it("flag on rejects an unauthorized caller", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    for (const setup of [
      () => request("Bearer "),
      () => {
        verifyIdToken.mockResolvedValue(token("outsider@example.com"));
        return request();
      },
    ]) {
      findMany.mockClear();
      const res = await route.GET(setup());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it("flag on returns the stored snapshot", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findMany.mockResolvedValue([row]);
    for (const email of [SA, DEV_SA]) {
      verifyIdToken.mockResolvedValue(token(email));
      const res = await route.GET(request());
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.json();
      expect(body.schemaVersion).toBe(1);
      expect(body.custodians[0].fees[0]).toEqual({
        id: "f1", feeType: "acat", accountType: "ANY", transferType: "FULL", direction: "IN",
        amount: 0, amountText: null, notes: null, documentation: null,
        createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-01-03T03:04:05.000Z",
      });
      expect(body.custodians[0].feeScheduleDocuments[0]).toEqual({
        id: "d1", filename: "schedule.pdf", contentType: "application/pdf",
        byteSize: 22, sha256, createdAt: "2026-01-02T03:04:05.000Z", createdBy: "admin@example.test",
      });
      expect(JSON.stringify(body)).not.toContain("synthetic-fee-schedule");
      expect(rateLimit).toHaveBeenCalledWith("machine-custodian-snapshot", email, {
        maxTokens: 30, interval: 60_000,
      });
    }
  });

  it("refuses the snapshot when the file checksum does not match", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findMany.mockResolvedValue([{
      ...row,
      feeScheduleDocuments: [{ ...row.feeScheduleDocuments[0], sha256: "0".repeat(64) }],
    }]);
    const res = await route.GET(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "snapshot_refused" });
  });

  it("returns an empty snapshot", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findMany.mockResolvedValue([]);
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schemaVersion: 1, custodians: [] });
  });

  it("returns unavailable without leaking the database error", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    findMany.mockRejectedValue(new Error("sensitive database error"));
    const res = await route.GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(JSON.stringify(logError.mock.calls)).not.toContain("sensitive");
  });

  it("rate limits before reading", async () => {
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    rateLimit.mockResolvedValue({ allowed: false });
    const res = await route.GET(request());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("exports GET only", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "revalidate", "runtime"]);
  });
});
