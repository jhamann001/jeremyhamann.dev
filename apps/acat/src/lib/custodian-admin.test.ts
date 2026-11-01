import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

const { verifyCustodianAdminCaller, rateLimit } = vi.hoisted(() => ({
  verifyCustodianAdminCaller: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/machine-auth", () => ({ verifyCustodianAdminCaller }));
vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit }));
vi.mock("@/lib/custodian-timing-data", () => ({
  loadObservedCustodianTimings: vi.fn().mockResolvedValue(new Map()),
}));

import { prisma } from "@/lib/prisma";
import {
  authorizeCustodianAdmin,
  custodianAdminEnabled,
  custodianSnapshotExportEnabled,
  CustodianSnapshotRefusal,
  loadCustodianSnapshot,
  loadFeeScheduleBytes,
  resolveActingAdmin,
  toLibraryProfile,
} from "@/lib/custodian-admin";

const EPIC = "EPIC_ACAT_CUSTODIAN_ADMIN";
const ROLLOUT = "ROLLOUT_ACAT_CUSTODIAN_ADMIN";
const findUser = prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>;

const request = (email?: string) =>
  new Request("https://tracker.test/api/machine/custodians/admin", {
    method: "POST",
    headers: email ? { "x-acting-user-email": email } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  verifyCustodianAdminCaller.mockResolvedValue({ email: "sa@example.test" });
  rateLimit.mockResolvedValue({ allowed: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("custodian admin helpers", () => {
  it("enabled only when both switches are exactly 1", () => {
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(ROLLOUT, "1");
    expect(custodianAdminEnabled()).toBe(true);
    markCase("custodian-admin-lib", "enabled only when both switches are exactly 1");
  });

  it("disabled when either switch is unset or not 1", () => {
    expect(custodianAdminEnabled()).toBe(false);
    vi.stubEnv(EPIC, "1");
    expect(custodianAdminEnabled()).toBe(false);
    vi.stubEnv(ROLLOUT, "true");
    expect(custodianAdminEnabled()).toBe(false);
    vi.stubEnv(EPIC, "0");
    vi.stubEnv(ROLLOUT, "1");
    expect(custodianAdminEnabled()).toBe(false);
    markCase("custodian-admin-lib", "disabled when either switch is unset or not 1");
  });

  it("resolves an active ADMIN acting user case-insensitively", async () => {
    findUser.mockResolvedValue({ role: "ADMIN", active: true });
    expect(await resolveActingAdmin(request("  Admin@Example.TEST "))).toBe("admin@example.test");
    expect(findUser).toHaveBeenCalledWith({
      where: { email: "admin@example.test" },
      select: { role: true, active: true },
    });
    markCase("custodian-admin-lib", "resolves an active ADMIN acting user case-insensitively");
  });

  it("rejects a missing, inactive, non-admin or unknown acting user", async () => {
    expect(await resolveActingAdmin(request())).toBeNull();
    expect(findUser).not.toHaveBeenCalled();
    findUser.mockResolvedValueOnce({ role: "ADMIN", active: false });
    expect(await resolveActingAdmin(request("a@example.test"))).toBeNull();
    findUser.mockResolvedValueOnce({ role: "USER", active: true });
    expect(await resolveActingAdmin(request("a@example.test"))).toBeNull();
    findUser.mockResolvedValueOnce(null);
    expect(await resolveActingAdmin(request("a@example.test"))).toBeNull();
    markCase("custodian-admin-lib", "rejects a missing, inactive, non-admin or unknown acting user");
  });

  it("authorize returns 404 before verifying the caller when disabled", async () => {
    const result = await authorizeCustodianAdmin(request("a@example.test"), "create");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(404);
    expect(await (result as Response).json()).toEqual({ error: "not_found" });
    expect(verifyCustodianAdminCaller).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled();
    markCase("custodian-admin-lib", "authorize returns 404 before verifying the caller when disabled");
  });

  it("authorize returns 401 when the caller is not verified", async () => {
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(ROLLOUT, "1");
    verifyCustodianAdminCaller.mockResolvedValue(null);
    const result = (await authorizeCustodianAdmin(request("a@example.test"), "create")) as Response;
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "unauthorized" });
    expect(rateLimit).not.toHaveBeenCalled();
    markCase("custodian-admin-lib", "authorize returns 401 when the caller is not verified");
  });

  it("authorize returns 429 before resolving the acting user when rate limited", async () => {
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(ROLLOUT, "1");
    rateLimit.mockResolvedValue({ allowed: false });
    const result = (await authorizeCustodianAdmin(request("a@example.test"), "create")) as Response;
    expect(result.status).toBe(429);
    expect(await result.json()).toEqual({ error: "rate_limited" });
    expect(findUser).not.toHaveBeenCalled();
    markCase("custodian-admin-lib", "authorize returns 429 before resolving the acting user when rate limited");
  });

  it("toLibraryProfile maps processing days and timings", () => {
    const row = { id: "c1", name: "E*Trade", avgProcessingDays: 7, fees: [] } as never;
    const timings = new Map([["c1", { observedAvgProcessingBusinessDays: 4.5, observedCompletedTransfers: 3 }]]);
    expect(toLibraryProfile(row, timings as never)).toEqual({
      id: "c1", name: "E*Trade", fees: [],
      configuredExpectedProcessingDays: 7,
      observedAvgProcessingBusinessDays: 4.5,
      observedCompletedTransfers: 3,
    });
    expect(toLibraryProfile(row, new Map())).toMatchObject({
      observedAvgProcessingBusinessDays: null, observedCompletedTransfers: 0,
    });
    markCase("custodian-admin-lib", "toLibraryProfile maps processing days and timings");
  });
});

describe("loadCustodianSnapshot", () => {
  const content = Buffer.from("synthetic-fee-schedule");
  const sha256 = "65c53ce90264b5b6a0292531bafb20ca44f9e52d5ae1c4f1e80d84a17a00d5b3";
  const createdAt = new Date("2026-01-02T03:04:05.000Z");
  const updatedAt = new Date("2026-01-03T03:04:05.000Z");
  const findMany = prisma.custodian.findMany as ReturnType<typeof vi.fn>;
  const findUnique = prisma.custodianFeeScheduleDocument.findUnique as ReturnType<typeof vi.fn>;
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

  it("enables the export only when the switch is exactly 1", () => {
    expect(custodianSnapshotExportEnabled()).toBe(false);
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "0");
    expect(custodianSnapshotExportEnabled()).toBe(false);
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "true");
    expect(custodianSnapshotExportEnabled()).toBe(false);
    vi.stubEnv("ALLOW_CUSTODIAN_SNAPSHOT_EXPORT", "1");
    expect(custodianSnapshotExportEnabled()).toBe(true);
    markCase("custodian-snapshot", "enables the export only when the switch is exactly 1");
  });

  it("returns every stored custodian, fee rule, and file identity with the known checksum", async () => {
    findMany.mockResolvedValue([row]);
    const body = await loadCustodianSnapshot();
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty("recentClients");
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty("requiresManualReview");
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty("acatRecords");
    const { fees, feeScheduleDocuments, ...profile } = row;
    expect(feeScheduleDocuments[0].byteSize).toBe(22);
    expect(body).toEqual({
      schemaVersion: 1,
      custodians: [{
        ...profile,
        fees: [{ ...fees[0], createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() }],
        feeScheduleDocuments: [{
          id: "d1", filename: "schedule.pdf", contentType: "application/pdf",
          byteSize: 22, sha256, createdAt: createdAt.toISOString(), createdBy: "admin@example.test",
        }],
      }],
    });
    expect(JSON.stringify(body)).not.toContain("synthetic-fee-schedule");
    markCase("custodian-snapshot", "returns every stored custodian, fee rule, and file identity with the known checksum");
  });

  it("refuses the snapshot when the file checksum does not match", async () => {
    findMany.mockResolvedValue([{
      ...row,
      feeScheduleDocuments: [{ ...row.feeScheduleDocuments[0], sha256: "0".repeat(64) }],
    }]);
    await expect(loadCustodianSnapshot()).rejects.toBeInstanceOf(CustodianSnapshotRefusal);
    markCase("custodian-snapshot", "refuses the snapshot when the file checksum does not match");
  });

  it("refuses the snapshot when the byte count does not match", async () => {
    findMany.mockResolvedValue([{
      ...row,
      feeScheduleDocuments: [{ ...row.feeScheduleDocuments[0], byteSize: 21 }],
    }]);
    await expect(loadCustodianSnapshot()).rejects.toBeInstanceOf(CustodianSnapshotRefusal);
    findUnique.mockResolvedValue({
      filename: "schedule.pdf", contentType: "application/pdf", content, byteSize: 21, sha256,
    });
    await expect(loadFeeScheduleBytes("d1")).rejects.toBeInstanceOf(CustodianSnapshotRefusal);
    markCase("custodian-snapshot", "refuses the snapshot when the byte count does not match");
  });
});
