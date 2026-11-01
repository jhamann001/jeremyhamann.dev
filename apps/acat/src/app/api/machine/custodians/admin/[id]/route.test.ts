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
import { PATCH } from "./route";

const update = prisma.custodian.update as ReturnType<typeof vi.fn>;
const findUnique = prisma.custodian.findUnique as ReturnType<typeof vi.fn>;
const findUser = prisma.allowedUser.findUnique as ReturnType<typeof vi.fn>;

const stored = { id: "c1", name: "E*Trade", watchouts: "Call first", avgProcessingDays: 7, contactMethod: null, contactDetails: null, contactEmail: null, fees: [] };
const patch = (body: unknown) =>
  PATCH(
    new Request("https://tracker.test/api/machine/custodians/admin/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-acting-user-email": "admin@example.test" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "c1" }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "1");
  vi.stubEnv("ROLLOUT_ACAT_CUSTODIAN_ADMIN", "1");
  verifyCustodianAdminCaller.mockResolvedValue({ email: "sa@example.test" });
  rateLimit.mockResolvedValue({ allowed: true });
  findUser.mockResolvedValue({ role: "ADMIN", active: true });
  update.mockResolvedValue({ id: "c1" });
  findUnique.mockResolvedValue(stored);
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH /api/machine/custodians/admin/[id]", () => {
  it("saves playbook fields and returns the stored custodian", async () => {
    const response = await patch({ watchouts: "Call first", dtcNumber: "0443", reviewStatus: "VERIFIED" });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { watchouts: "Call first", dtcNumber: "0443", reviewStatus: "VERIFIED" },
    });
    expect(await response.json()).toMatchObject({ custodian: { id: "c1", watchouts: "Call first" } });
    markCase("machine-custodian-admin-update", "saves playbook fields and returns the stored custodian");
  });

  it("blank name returns 400 and leaves the row unchanged", async () => {
    const response = await patch({ name: "   " });
    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-update", "blank name returns 400 and leaves the row unchanged");
  });

  it("recentClients is rejected", async () => {
    const response = await patch({ recentClients: "Jane Doe" });
    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-update", "recentClients is rejected");
  });

  it("synchronizes structured Email for legacy consumers", async () => {
    const response = await patch({ contactMethod: "EMAIL", contactDetails: "ops@custodian.example" });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: {
        contactMethod: "EMAIL",
        contactDetails: "ops@custodian.example",
        contactEmail: "ops@custodian.example",
      },
    });
  });

  it("synchronizes legacy email-only edits when the current method is Email", async () => {
    findUnique.mockResolvedValue({ ...stored, contactMethod: "EMAIL", contactDetails: "old@custodian.example" });
    const response = await patch({ contactEmail: "new@custodian.example" });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { contactEmail: "new@custodian.example", contactDetails: "new@custodian.example" },
    });
  });

  it.each([
    { contactMethod: "PHONE" },
    { contactDetails: "800 555 0100" },
    { contactMethod: "EMAIL", contactDetails: "not-an-email" },
  ])("rejects invalid contact payload %#", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("unknown custodian returns 404", async () => {
    findUnique.mockResolvedValue(null);
    const response = await patch({ watchouts: "x" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Custodian not found" });
    expect(update).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-update", "unknown custodian returns 404");
  });

  it("switches off returns 404 and does not write", async () => {
    vi.stubEnv("EPIC_ACAT_CUSTODIAN_ADMIN", "0");
    const response = await patch({ watchouts: "x" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    markCase("machine-custodian-admin-update", "switches off returns 404 and does not write");
  });

  it("database failure returns 500", async () => {
    update.mockRejectedValue(new Error("db down"));
    const response = await patch({ watchouts: "x" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    markCase("machine-custodian-admin-update", "database failure returns 500");
  });
});
