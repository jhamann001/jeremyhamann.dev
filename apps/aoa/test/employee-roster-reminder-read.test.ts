import { beforeEach, describe, expect, it, vi } from "vitest";

const { scope, tx } = vi.hoisted(() => ({
  scope: vi.fn(),
  tx: { $executeRaw: vi.fn(), employeeRosterUpload: { findFirst: vi.fn() } },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
import { employeeRosterReminder } from "@/lib/data/employee-roster";

describe("bounded optional roster read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    tx.$executeRaw.mockResolvedValue(1);
    tx.employeeRosterUpload.findFirst.mockResolvedValue(null);
  });

  it("does not read for unauthorized roles", async () => {
    for (const role of [undefined, "VIEWER", "ADVISOR", "unknown"]) {
      expect(await employeeRosterReminder({ role })).toBeNull();
    }
    expect(scope).not.toHaveBeenCalled();
  });

  it("bounds the actual statement and lock wait in the existing RLS transaction", async () => {
    const identity = { role: "OPERATIONS", email: "ops@example.test" };
    await employeeRosterReminder(identity, new Date("2026-09-17T12:00:00Z"));
    expect(scope).toHaveBeenCalledWith(identity, expect.any(Function), { timeout: 2_500, maxWait: 1_000 });
    const sql = tx.$executeRaw.mock.calls[0][0].join("");
    expect(sql).toContain("set_config('statement_timeout', '1500', true)");
    expect(sql).toContain("set_config('lock_timeout', '500', true)");
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.employeeRosterUpload.findFirst.mock.invocationCallOrder[0]);
    expect(tx.employeeRosterUpload.findFirst).toHaveBeenCalledExactlyOnceWith({ where: { status: "APPLIED" }, select: { effective_date: true } });
  });

  it("lets failures reach the explicit unavailable UI without retry or fabricated status", async () => {
    tx.employeeRosterUpload.findFirst.mockRejectedValueOnce(new Error("timeout"));
    await expect(employeeRosterReminder({ role: "ADMIN" })).rejects.toThrow("timeout");
    expect(tx.employeeRosterUpload.findFirst).toHaveBeenCalledTimes(1);
  });
});
