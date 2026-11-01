import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyIdToken, findMany, timings, rateLimit, logError } = vi.hoisted(() => ({
  verifyIdToken: vi.fn(), findMany: vi.fn(), timings: vi.fn(),
  rateLimit: vi.fn(), logError: vi.fn(),
}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verifyIdToken; } }));
vi.mock("@/lib/prisma", () => ({ prisma: { custodian: { findMany } } }));
vi.mock("@/lib/custodian-timing-data", () => ({ loadObservedCustodianTimings: timings }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError, warn: vi.fn() } }));

import * as route from "./route";
const SA = "ops-portal-run@ops-portal.iam.gserviceaccount.com";
const DEV_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const token = (email = SA, email_verified = true) => ({ getPayload: () => ({ email, email_verified }) });
const request = (authorization = "Bearer synthetic") => new Request("https://tracker.test/api/machine/custodians", { headers: { authorization } });

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  delete process.env.MACHINE_AUTH_AUDIENCE;
  verifyIdToken.mockResolvedValue(token());
  rateLimit.mockResolvedValue({ allowed: true });
  findMany.mockResolvedValue([]);
  timings.mockResolvedValue(new Map());
});

describe("read-only custodian library endpoint", () => {
  it.each(["", "Basic invalid", "Bearer "])("rejects malformed/missing credentials %s before reads", async (header) => {
    const res = await route.GET(request(header));
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
    expect(timings).not.toHaveBeenCalled();
  });
  it.each(["signature", "audience", "expiry"])("fails closed on %s verification failure", async (message) => {
    verifyIdToken.mockRejectedValue(new Error(message));
    const res = await route.GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(findMany).not.toHaveBeenCalled();
  });
  it.each([["outsider@example.com", true], [SA, false]])("rejects unapproved/unverified caller", async (email, verified) => {
    verifyIdToken.mockResolvedValue(token(email as string, verified as boolean));
    expect((await route.GET(request())).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });
  it("verifies the canonical audience and rejects a similar but unapproved dev identity", async () => {
    await route.GET(request());
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "synthetic", audience: "https://transfer-tracker.invalid" });
    verifyIdToken.mockResolvedValue(token("ops-portal-run@ops-portal-dev.iam.gserviceaccount.com"));
    expect((await route.GET(request())).status).toBe(401);
  });
  it("allows canonical dev reads and rate limits the verified dev identity", async () => {
    verifyIdToken.mockResolvedValue(token(DEV_SA));
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(rateLimit).toHaveBeenCalledWith("machine-custodian-library", DEV_SA, { maxTokens: 30, interval: 60_000 });
  });
  it("rate limits before querying", async () => {
    rateLimit.mockResolvedValue({ allowed: false });
    const res = await route.GET(request());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(findMany).not.toHaveBeenCalled();
    expect(timings).not.toHaveBeenCalled();
    expect(rateLimit).toHaveBeenCalledWith("machine-custodian-library", SA, { maxTokens: 30, interval: 60_000 });
  });
  it("uses an explicit privacy-safe projection with all fee qualifiers and timestamps", async () => {
    await route.GET(request());
    const { select, orderBy } = findMany.mock.calls[0][0];
    expect(select).not.toHaveProperty("recentClients");
    expect(select).not.toHaveProperty("acatRecords");
    expect(select).not.toHaveProperty("requiresManualReview");
    expect(select).toMatchObject({ receivingAccountNumber: true, watchouts: true, contactEmail: true, acatFeeAmount: true });
    expect(select.fees.select).toEqual({ id: true, feeType: true, accountType: true, transferType: true, direction: true, amount: true, amountText: true, notes: true, documentation: true, createdAt: true, updatedAt: true });
    expect(orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
  });
  it.each([SA, DEV_SA])("returns every row with the same null/zero and timing semantics for %s", async (email) => {
    verifyIdToken.mockResolvedValue(token(email));
    const fees = [{ id: "f1", amount: 0, amountText: null }, { id: "f2", amount: null, amountText: "Varies" }];
    findMany.mockResolvedValue([
      { id: "c1", name: "Synthetic Custodian", avgProcessingDays: 7, fees },
      { id: "c2", name: "Synthetic New Custodian", avgProcessingDays: 0, fees: [] },
    ]);
    timings.mockResolvedValue(new Map([["c1", { observedAvgProcessingBusinessDays: 3, observedCompletedTransfers: 8 }]]));
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(Number.isNaN(Date.parse(body.retrievedAt))).toBe(false);
    expect(body.custodians).toHaveLength(2);
    expect(body.custodians[0]).toMatchObject({ configuredExpectedProcessingDays: 7, observedAvgProcessingBusinessDays: 3, observedCompletedTransfers: 8, fees });
    expect(body.custodians[0]).not.toHaveProperty("avgProcessingDays");
    expect(body.custodians[1]).toMatchObject({ configuredExpectedProcessingDays: 0, observedAvgProcessingBusinessDays: null, observedCompletedTransfers: 0 });
  });
  it("distinguishes an empty library from service failure", async () => {
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).custodians).toEqual([]);
  });
  it.each(["database", "timing", "rate limiter"])("returns an opaque no-store failure for %s errors", async (source) => {
    const fn = source === "database" ? findMany : source === "timing" ? timings : rateLimit;
    fn.mockRejectedValue(new Error("sensitive database error"));
    const res = await route.GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(logError.mock.calls)).not.toContain("sensitive");
  });
  it("exports GET only, never mutation handlers", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "revalidate"]);
  });
});
