import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { resolveCustodianForContra } = await import("./custodian-resolve");
const { prisma } = await import("@/lib/prisma");

const findFirst = prisma.custodian.findFirst as ReturnType<typeof vi.fn>;
const findMany = prisma.custodian.findMany as ReturnType<typeof vi.fn>;
const create = prisma.custodian.create as ReturnType<typeof vi.fn>;
const upsert = prisma.custodian.upsert as ReturnType<typeof vi.fn>;

afterEach(() => {
  delete process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION;
  vi.clearAllMocks();
});

describe("resolveCustodianForContra projection", () => {
  it("the authority switch still returns an existing custodian", async () => {
    markCase("custodian-resolve-projection", "the authority switch still returns an existing custodian");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    findFirst.mockResolvedValue({ id: "CUST-1", name: "Fidelity" });
    await expect(resolveCustodianForContra("Fidelity")).resolves.toEqual({ id: "CUST-1", name: "Fidelity" });
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("the authority switch does not mint a custodian", async () => {
    markCase("custodian-resolve-projection", "the authority switch does not mint a custodian");
    process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION = "1";
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([]);
    await expect(resolveCustodianForContra("Brand New Bank")).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
