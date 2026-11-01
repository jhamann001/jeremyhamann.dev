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
import { PATCH, DELETE } from "./[feeId]/route";

const findUnique = prisma.custodian.findUnique as ReturnType<typeof vi.fn>;
const findFee = prisma.custodianFee.findUnique as ReturnType<typeof vi.fn>;
const createFee = prisma.custodianFee.create as ReturnType<typeof vi.fn>;
const updateFee = prisma.custodianFee.update as ReturnType<typeof vi.fn>;
const deleteFee = prisma.custodianFee.delete as ReturnType<typeof vi.fn>;
const findUser = prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>;

const stored = { id: "c1", name: "E*Trade", avgProcessingDays: 7, fees: [{ id: "f1", feeType: "Outgoing ACAT" }] };
const BASE = "https://tracker.test/api/machine/custodians/admin/c1/fees";
const init = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json", "x-acting-user-email": "admin@example.test" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const feeParams = { params: Promise.resolve({ id: "c1", feeId: "f1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "1");
  vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "1");
  verifyCustodianAdminCaller.mockResolvedValue({ email: "sa@example.test" });
  rateLimit.mockResolvedValue({ allowed: true });
  findUser.mockResolvedValue({ role: "ADMIN", active: true });
  findUnique.mockResolvedValue(stored);
  findFee.mockResolvedValue({ id: "f1", custodianId: "c1" });
  createFee.mockResolvedValue({ id: "f1" });
  updateFee.mockResolvedValue({ id: "f1" });
  deleteFee.mockResolvedValue({ id: "f1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("machine custodian fee routes", () => {
  it("adds a fee rule and returns the stored custodian", async () => {
    const response = await POST(
      new Request(BASE, init("POST", { feeType: "Outgoing ACAT", amount: 75 })),
      { params: Promise.resolve({ id: "c1" }) }
    );
    expect(response.status).toBe(201);
    expect(createFee).toHaveBeenCalledWith({
      data: {
        custodianId: "c1", feeType: "Outgoing ACAT", amount: 75,
        accountType: "ANY", transferType: "ANY", direction: "ANY",
      },
    });
    expect(await response.json()).toMatchObject({ custodian: { id: "c1" } });
    markCase("machine-custodian-admin-fees", "adds a fee rule and returns the stored custodian");
  });

  it("edits a fee rule and returns the stored custodian", async () => {
    const response = await PATCH(new Request(`${BASE}/f1`, init("PATCH", { notes: "Call contra" })), feeParams);
    expect(response.status).toBe(200);
    expect(updateFee).toHaveBeenCalledWith({ where: { id: "f1" }, data: { notes: "Call contra" } });
    expect(await response.json()).toMatchObject({ custodian: { id: "c1" } });
    markCase("machine-custodian-admin-fees", "edits a fee rule and returns the stored custodian");
  });

  it("deletes a fee rule and returns the stored custodian", async () => {
    const response = await DELETE(new Request(`${BASE}/f1`, init("DELETE")), feeParams);
    expect(response.status).toBe(200);
    expect(deleteFee).toHaveBeenCalledWith({ where: { id: "f1" } });
    expect(await response.json()).toMatchObject({ custodian: { id: "c1" } });
    markCase("machine-custodian-admin-fees", "deletes a fee rule and returns the stored custodian");
  });

  it("a fee from another custodian returns 404 and is not changed", async () => {
    findFee.mockResolvedValue({ id: "f1", custodianId: "other" });
    const patched = await PATCH(new Request(`${BASE}/f1`, init("PATCH", { notes: "x" })), feeParams);
    const deleted = await DELETE(new Request(`${BASE}/f1`, init("DELETE")), feeParams);
    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual({ error: "Fee not found" });
    expect(updateFee).not.toHaveBeenCalled();
    expect(deleteFee).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-fees", "a fee from another custodian returns 404 and is not changed");
  });

  it("missing fee type returns 400", async () => {
    const response = await POST(
      new Request(BASE, init("POST", { amount: 5 })),
      { params: Promise.resolve({ id: "c1" }) }
    );
    expect(response.status).toBe(400);
    expect(createFee).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-fees", "missing fee type returns 400");
  });

  it("switches off returns 404 for all three methods and does not write", async () => {
    vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "");
    const responses = [
      await POST(new Request(BASE, init("POST", { feeType: "x" })), { params: Promise.resolve({ id: "c1" }) }),
      await PATCH(new Request(`${BASE}/f1`, init("PATCH", { notes: "x" })), feeParams),
      await DELETE(new Request(`${BASE}/f1`, init("DELETE")), feeParams),
    ];
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(createFee).not.toHaveBeenCalled();
    expect(updateFee).not.toHaveBeenCalled();
    expect(deleteFee).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-fees", "switches off returns 404 for all three methods and does not write");
  });
});
