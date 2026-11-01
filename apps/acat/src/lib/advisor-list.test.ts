import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "@/lib/test-flywheel";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));

const { loadAdvisorAcats, resolveAdvisorListAccess } = await import("./advisor-list");
const { prisma } = await import("@/lib/prisma");

beforeEach(() => vi.clearAllMocks());

describe("advisor list", () => {
  it("loads the advisor query with the existing bounds", async () => {
    vi.mocked(prisma.acatRecord.findMany).mockResolvedValue([
      { id: "A", clientName: "Client", status: "Submitted", acatDate: "2026-04-01", feeAmount: "$75.00", notes: "internal" },
    ] as never);
    const rows = await loadAdvisorAcats();
    expect(prisma.acatRecord.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      include: { custodian: true },
      orderBy: [{ acatDate: "desc" }, { id: "desc" }],
      take: 5000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("feeAmount");
    expect(rows[0]).not.toHaveProperty("notes");
    markCase("advisor-list", "loads the advisor query with the existing bounds");
  });

  it("allows only active ADVISOR or ADMIN rows", async () => {
    const find = vi.mocked(prisma.allowedUser.findUnique);
    const cases = [
      [{ active: true, role: "ADVISOR" }, "allowed"],
      [{ active: true, role: "ADMIN" }, "allowed"],
      [{ active: true, role: "USER" }, "not_allowed"],
      [{ active: false, role: "ADVISOR" }, "not_allowed"],
      [null, "not_allowed"],
    ] as const;
    for (const [row, expected] of cases) {
      find.mockResolvedValueOnce(row as never);
      expect(await resolveAdvisorListAccess(" Advisor@example.com ")).toBe(expected);
    }
    expect(find).toHaveBeenLastCalledWith({
      where: { email: "advisor@example.com" },
      select: { active: true, role: true },
    });
    markCase("advisor-list", "allows only active ADVISOR or ADMIN rows");
  });
});
