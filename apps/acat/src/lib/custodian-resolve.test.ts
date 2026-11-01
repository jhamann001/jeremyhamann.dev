import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { resolveCustodianForContra } = await import("./custodian-resolve");
const { prisma } = await import("@/lib/prisma");

const findFirst = prisma.custodian.findFirst as ReturnType<typeof vi.fn>;
const findMany = prisma.custodian.findMany as ReturnType<typeof vi.fn>;
const create = prisma.custodian.create as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  delete process.env.ENFORCE_CUSTODIAN_TRACKER_PROJECTION;
});

describe("resolveCustodianForContra", () => {
  it("returns null for empty/blank/null contra without touching the DB", async () => {
    expect(await resolveCustodianForContra("")).toBeNull();
    expect(await resolveCustodianForContra("   ")).toBeNull();
    expect(await resolveCustodianForContra(null)).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns an exact case-insensitive match without creating", async () => {
    findFirst.mockResolvedValue({ id: "CUST-1", name: "Fidelity" });
    const result = await resolveCustodianForContra("fidelity");
    expect(result).toEqual({ id: "CUST-1", name: "Fidelity" });
    expect(create).not.toHaveBeenCalled();
  });

  it("resolves a known alias to its existing canonical row", async () => {
    findFirst.mockImplementation(({ where }: { where: { name: { equals: string } } }) => {
      if (where.name.equals.toLowerCase() === "e*trade") {
        return Promise.resolve({ id: "CUST-ET", name: "E*Trade" });
      }
      return Promise.resolve(null);
    });
    const result = await resolveCustodianForContra("E*Trade");
    expect(result).toEqual({ id: "CUST-ET", name: "E*Trade" });
    expect(create).not.toHaveBeenCalled();
  });

  it("matches an existing row by normalized form (punctuation/whitespace)", async () => {
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([{ id: "CUST-JPM", name: "J.P. Morgan" }]);
    const result = await resolveCustodianForContra("J P Morgan");
    expect(result).toEqual({ id: "CUST-JPM", name: "J.P. Morgan" });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a NEEDS_SETUP custodian for a genuinely-new name", async () => {
    findFirst.mockResolvedValue(null);
    findMany.mockResolvedValue([]);
    create.mockResolvedValue({ id: "CUST-NEW", name: "Brand New Bank" });
    const result = await resolveCustodianForContra("Brand New Bank");
    expect(create).toHaveBeenCalledWith({
      data: { name: "Brand New Bank", reviewStatus: "NEEDS_SETUP" },
      select: { id: true, name: true },
    });
    expect(result).toEqual({ id: "CUST-NEW", name: "Brand New Bank" });
  });
});
