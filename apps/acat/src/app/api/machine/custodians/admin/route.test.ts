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

const upsert = prisma.custodian.upsert as ReturnType<typeof vi.fn>;
const findUnique = prisma.custodian.findUnique as ReturnType<typeof vi.fn>;
const findUser = prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>;

const stored = { id: "c1", name: "Betterment", reviewStatus: "VERIFIED", avgProcessingDays: 7, fees: [] };
const post = (body: unknown, raw?: string) =>
  POST(new Request("https://tracker.test/api/machine/custodians/admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-acting-user-email": "admin@example.test" },
    body: raw ?? JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "1");
  vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "1");
  verifyCustodianAdminCaller.mockResolvedValue({ email: "sa@example.test" });
  rateLimit.mockResolvedValue({ allowed: true });
  findUser.mockResolvedValue({ role: "ADMIN", active: true });
  upsert.mockResolvedValue({ id: "c1" });
  findUnique.mockResolvedValue(stored);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/machine/custodians/admin", () => {
  it("creates and returns the stored custodian", async () => {
    const response = await post({ name: "  Betterment  " });
    expect(response.status).toBe(201);
    expect(upsert).toHaveBeenCalledWith({
      where: { name: "Betterment" },
      update: { reviewStatus: "VERIFIED" },
      create: { name: "Betterment", reviewStatus: "VERIFIED" },
    });
    expect(await response.json()).toMatchObject({
      custodian: { id: "c1", name: "Betterment", configuredExpectedProcessingDays: 7 },
    });
    markCase("machine-custodian-admin-create", "creates and returns the stored custodian");
  });

  it("blank name returns 400 and does not write", async () => {
    for (const name of ["", "   "]) {
      const response = await post({ name });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining("Name is required") });
    }
    expect(upsert).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-create", "blank name returns 400 and does not write");
  });

  it("switches off returns 404 and does not write", async () => {
    vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "0");
    const response = await post({ name: "Betterment" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(verifyCustodianAdminCaller).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-create", "switches off returns 404 and does not write");
  });

  it("non-admin acting user returns 403 and does not write", async () => {
    findUser.mockResolvedValue({ role: "USER", active: true });
    const response = await post({ name: "Betterment" });
    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-create", "non-admin acting user returns 403 and does not write");
  });

  it("database failure returns 500", async () => {
    upsert.mockRejectedValue(new Error("db down"));
    const response = await post({ name: "Betterment" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    markCase("machine-custodian-admin-create", "database failure returns 500");
  });
});
