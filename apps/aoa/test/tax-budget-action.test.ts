import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, withUserScopeSpy, redirectSpy, revalidateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  withUserScopeSpy: vi.fn(),
  redirectSpy: vi.fn(),
  revalidateSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({ withUserScope: withUserScopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { saveTaxBudget } from "@/app/(authenticated)/client-portrait/[id]/actions";
import { TAX_BUDGET_SET, TAX_BUDGET_UPDATE } from "@/lib/audit";

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  taxBudgetRecord: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

let tx: FakeTx;

beforeEach(() => {
  authSpy.mockResolvedValue({
    user: { email: "advisor@example.com", role: "ADVISOR" },
  });
  tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ sf_id: "003CLIENT" }]),
    taxBudgetRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({
        id: "tb-1",
        budget: 150000,
        realized: 42000,
        note: "Manual plan",
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  withUserScopeSpy.mockImplementation(
    async (_identity: unknown, fn: (t: FakeTx) => unknown) => fn(tx),
  );
});

afterEach(() => vi.clearAllMocks());

describe("saveTaxBudget", () => {
  it("fails closed for VIEWER before opening an RLS scope", async () => {
    authSpy.mockResolvedValue({
      user: { email: "viewer@example.com", role: "VIEWER" },
    });
    const result = await saveTaxBudget("003CLIENT", {
      budget: 1,
      realized: 0,
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid values before opening an RLS scope", async () => {
    const result = await saveTaxBudget("003CLIENT", {
      budget: -1,
      realized: 0,
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(withUserScopeSpy).not.toHaveBeenCalled();
  });

  it("returns the same generic refusal for an out-of-book client", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    const result = await saveTaxBudget("003OTHER", {
      budget: 1,
      realized: 0,
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(tx.taxBudgetRecord.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("creates the current-year row and audit event in one scoped transaction", async () => {
    const result = await saveTaxBudget("003CLIENT", {
      budget: 150000,
      realized: 42000,
      note: " Manual plan ",
    });
    expect(result).toEqual({
      ok: true,
      budget: { budget: 150000, realized: 42000, note: "Manual plan" },
    });

    expect(tx.taxBudgetRecord.upsert).toHaveBeenCalledTimes(1);
    const write = tx.taxBudgetRecord.upsert.mock.calls[0][0];
    expect(write.where.client_sf_id_year.client_sf_id).toBe("003CLIENT");
    expect(write.create).toMatchObject({
      client_sf_id: "003CLIENT",
      budget: 150000,
      realized: 42000,
      note: "Manual plan",
      set_by: "advisor@example.com",
    });
    expect(write.create.year).toBe(new Date().getUTCFullYear());

    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe(TAX_BUDGET_SET);
    expect(audit.entityType).toBe("tax_budget");
    expect(audit.entityId).toBe("tb-1");
    expect(JSON.parse(audit.detail)).toEqual({
      clientSfId: "003CLIENT",
      year: new Date().getUTCFullYear(),
      budget: 150000,
      realized: 42000,
      notePresent: true,
    });
    expect(revalidateSpy).toHaveBeenCalledWith("/client-portrait/003CLIENT");
  });

  it("uses the update audit action when the client/year row already exists", async () => {
    tx.taxBudgetRecord.findUnique.mockResolvedValue({ id: "tb-1" });
    await saveTaxBudget("003CLIENT", { budget: 1, realized: 0, note: "" });
    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe(TAX_BUDGET_UPDATE);
  });

  it("converts a database/RLS rejection to a clean form result", async () => {
    tx.taxBudgetRecord.upsert.mockRejectedValue(new Error("RLS"));
    const result = await saveTaxBudget("003CLIENT", {
      budget: 1,
      realized: 0,
      note: "",
    });
    expect(result.ok).toBe(false);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });
});
