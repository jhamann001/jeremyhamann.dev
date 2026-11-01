import { beforeEach, describe, expect, it, vi } from "vitest";

// Real route handlers and authorization; mock only Google's signature verifier
// and data/services. Every read requires its own scoped identity check.
const { verifyIdToken, findCustodians, findTransfers, findTransfer, findByRecord, timings, rateLimit } = vi.hoisted(() => ({
  verifyIdToken: vi.fn(), findCustodians: vi.fn(), findTransfers: vi.fn(),
  findTransfer: vi.fn(), findByRecord: vi.fn(), timings: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verifyIdToken; } }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  custodian: { findMany: findCustodians },
  acatRecord: { findMany: findTransfers, findFirst: findTransfer, findUnique: findByRecord },
} }));
vi.mock("@/lib/custodian-timing-data", () => ({ loadObservedCustodianTimings: timings }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { GET as library } from "./custodians/route";
import { GET as transfers } from "./acats/route";
import { GET as transfer } from "./acats/[acatTransferId]/route";
import { GET as byRecord } from "./acats/by-record/[id]/route";
import { getAllowedServiceAccounts, verifyMachineCaller } from "@/lib/machine-auth";

const DEV_SA = "ops-portal-dev-run@ops-portal-dev.iam.gserviceaccount.com";
const readers = [
  { path: "/api/machine/acats", read: (r: Request) => transfers(r as Parameters<typeof transfers>[0]) },
  { path: "/api/machine/acats/synthetic", read: (r: Request) => transfer(r as Parameters<typeof transfer>[0], { params: Promise.resolve({ acatTransferId: "synthetic" }) }) },
  { path: "/api/machine/acats/by-record/synthetic", read: (r: Request) => byRecord(r as Parameters<typeof byRecord>[0], { params: Promise.resolve({ id: "synthetic" }) }) },
];

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.MACHINE_AUTH_ALLOWED_SAS;
  delete process.env.MACHINE_AUTH_AUDIENCE;
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: DEV_SA, email_verified: true }) });
  findCustodians.mockResolvedValue([]);
  findTransfers.mockResolvedValue([]);
  findTransfer.mockResolvedValue(null);
  findByRecord.mockResolvedValue(null);
  timings.mockResolvedValue(new Map());
  rateLimit.mockResolvedValue({ allowed: true });
});

describe("scoped dev identity isolation", () => {
  it.each(readers)("reverifies $path after a successful library read without querying unauthorized transfers", async ({ path, read }) => {
    const allowed = await library(new Request("https://tracker.test/api/machine/custodians", {
      headers: { authorization: "Bearer synthetic" },
    }));
    expect(allowed.status).toBe(200);
    vi.clearAllMocks();
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: DEV_SA, email_verified: false }) });

    const response = await read(new Request(`https://tracker.test${path}?scope=custodian-library`, {
      headers: {
        authorization: "Bearer synthetic",
        "x-original-url": "/api/machine/custodians",
        "x-rewrite-url": "/api/machine/custodians",
      },
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(findTransfers).not.toHaveBeenCalled();
    expect(findTransfer).not.toHaveBeenCalled();
    expect(findByRecord).not.toHaveBeenCalled();
    expect(findCustodians).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it.each(readers)("allows a fresh verified dev read on $path without broadening the global policy", async ({ path, read }) => {
    const request = new Request(`https://tracker.test${path}`, { headers: { authorization: "Bearer synthetic" } });
    const response = await read(request);
    expect(response.status).toBe(path === "/api/machine/acats" ? 200 : 404);
    expect(verifyIdToken).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledWith(
      path === "/api/machine/acats" ? "machine-acat-list" : "machine-acat-read",
      DEV_SA,
      { maxTokens: path === "/api/machine/acats" ? 60 : 120, interval: 60_000 },
    );
    expect(getAllowedServiceAccounts()).toEqual(new Set(["ops-portal-run@ops-portal.iam.gserviceaccount.com"]));
    expect(await verifyMachineCaller(request)).toBeNull();
  });

  it.each(readers)("denies $path when dev exceeds its existing read rate limit", async ({ path, read }) => {
    rateLimit.mockResolvedValue({ allowed: false });
    const response = await read(new Request(`https://tracker.test${path}`, { headers: { authorization: "Bearer synthetic" } }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(findTransfers).not.toHaveBeenCalled();
    expect(findTransfer).not.toHaveBeenCalled();
    expect(findByRecord).not.toHaveBeenCalled();
  });

  it.each(readers)("denies mutations to $path even if a read handler is called directly", async ({ path, read }) => {
    const response = await read(new Request(`https://tracker.test${path}`, { method: "POST", headers: { authorization: "Bearer synthetic" } }));
    expect(response.status).toBe(401);
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(findTransfers).not.toHaveBeenCalled();
    expect(findTransfer).not.toHaveBeenCalled();
    expect(findByRecord).not.toHaveBeenCalled();
  });

  it("keeps mutations off the transfer read and rejects the dev service account on the machine writes", async () => {
    const list = await import("./acats/route");
    const transfer = await import("./acats/[acatTransferId]/route");
    const byRecord = await import("./acats/by-record/[id]/route");
    expect(list).toHaveProperty("POST");
    for (const method of ["PUT", "PATCH", "DELETE"]) expect(list).not.toHaveProperty(method);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(transfer).not.toHaveProperty(method);
    expect(byRecord).toHaveProperty("PATCH");
    for (const method of ["POST", "PUT", "DELETE"]) expect(byRecord).not.toHaveProperty(method);

    const created = await list.POST(new Request("https://tracker.test/api/machine/acats", {
      method: "POST",
      headers: { authorization: "Bearer synthetic" },
      body: JSON.stringify({ clientName: "Ada", apexAccountId: "BLSTACCTQZ7K", direction: "In" }),
    }));
    expect(created.status).toBe(401);
    const patched = await byRecord.PATCH(new Request("https://tracker.test/api/machine/acats/by-record/synthetic", {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic" },
      body: JSON.stringify({ status: "WaitingOnClient" }),
    }), { params: Promise.resolve({ id: "synthetic" }) });
    expect(patched.status).toBe(401);
    expect(findTransfers).not.toHaveBeenCalled();
    expect(findByRecord).not.toHaveBeenCalled();
  });
});
