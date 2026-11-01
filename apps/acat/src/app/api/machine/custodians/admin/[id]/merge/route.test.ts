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
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const findUnique = prisma.custodian.findUnique as ReturnType<typeof vi.fn>;
const deleteCustodian = prisma.custodian.delete as ReturnType<typeof vi.fn>;
const findRecords = prisma.acatRecord.findMany as ReturnType<typeof vi.fn>;
const updateRecords = prisma.acatRecord.updateMany as ReturnType<typeof vi.fn>;
const auditMany = prisma.auditLog.createMany as ReturnType<typeof vi.fn>;
const findUser = prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>;

const SOURCE = { id: "dupe", name: "E*Trade" };
const TARGET = { id: "canon", name: "E*Trade", avgProcessingDays: 7, fees: [] };
const merge = (body: unknown) =>
  POST(
    new Request("https://tracker.test/api/machine/custodians/admin/dupe/merge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acting-user-email": "admin@example.test" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "dupe" }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "1");
  vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "1");
  verifyCustodianAdminCaller.mockResolvedValue({ email: "sa@example.test" });
  rateLimit.mockResolvedValue({ allowed: true });
  findUser.mockResolvedValue({ role: "ADMIN", active: true });
  findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id === "dupe" ? SOURCE : where.id === "canon" ? TARGET : null)
  );
  findRecords.mockResolvedValue([{ id: "R1", transferringContra: "E*Trade", custodianName: "E*Trade" }]);
  updateRecords.mockResolvedValue({ count: 1 });
  auditMany.mockResolvedValue({ count: 1 });
  deleteCustodian.mockResolvedValue(SOURCE);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/machine/custodians/admin/[id]/merge", () => {
  it("merges and returns the kept custodian with the reassigned count", async () => {
    const response = await merge({ targetCustodianId: "canon" });
    expect(response.status).toBe(200);
    expect(updateRecords).toHaveBeenCalledWith({
      where: { custodianId: "dupe" },
      data: { custodianId: "canon", custodianName: "E*Trade", transferringContra: "E*Trade" },
    });
    expect(auditMany).toHaveBeenCalledWith({
      data: [{
        acatRecordId: "R1", action: "custodian-merge", field: "transferringContra",
        oldValue: "E*Trade", newValue: "E*Trade", performedBy: "admin@example.test",
      }],
    });
    expect(deleteCustodian).toHaveBeenCalledWith({ where: { id: "dupe" } });
    expect(await response.json()).toMatchObject({
      custodian: { id: "canon" }, reassigned: 1, deletedCustodianId: "dupe",
    });
    markCase("machine-custodian-admin-merge", "merges and returns the kept custodian with the reassigned count");
  });

  it("self merge returns 400", async () => {
    const response = await merge({ targetCustodianId: "dupe" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Cannot merge a custodian into itself" });
    expect(deleteCustodian).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-merge", "self merge returns 400");
  });

  it("missing target returns 404", async () => {
    const response = await merge({ targetCustodianId: "ghost" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Target custodian not found" });
    expect(deleteCustodian).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-merge", "missing target returns 404");
  });

  it("rate limited actor returns 429 before writing", async () => {
    rateLimit.mockImplementation((bucket: string) => Promise.resolve({ allowed: bucket !== "custodian-merge" }));
    const response = await merge({ targetCustodianId: "canon" });
    expect(response.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith(
      "custodian-merge", "admin@example.test", { maxTokens: 20, interval: 3_600_000 }
    );
    expect(updateRecords).not.toHaveBeenCalled();
    expect(deleteCustodian).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-merge", "rate limited actor returns 429 before writing");
  });

  it("switches off returns 404 and does not write", async () => {
    vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "");
    const response = await merge({ targetCustodianId: "canon" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(findUnique).not.toHaveBeenCalled();
    expect(deleteCustodian).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-merge", "switches off returns 404 and does not write");
  });
});
