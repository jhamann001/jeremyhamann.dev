import { beforeEach, describe, expect, it, vi } from "vitest";

const { scope, tx } = vi.hoisted(() => ({
  scope: vi.fn(), tx: { $executeRaw: vi.fn(), $queryRaw: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
import { navCounts } from "@/lib/data/nav-counts";

describe("sidebar badge SQL resource bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    tx.$executeRaw.mockResolvedValue(1);
    tx.$queryRaw.mockResolvedValue([{ households: 7, clients: 7, openDeals: 7, activeTransfers: 7, crmOpenExceptions: 7 }]);
  });
  it("bounds all five counts together in one statement after transaction-local SQL limits", async () => {
    const identity = { role: "OPERATIONS", email: "synthetic@example.test" };
    expect(await navCounts(identity)).toEqual({ households: 7, clients: 7, openDeals: 7, activeTransfers: 7, crmOpenExceptions: 7 });
    expect(scope).toHaveBeenCalledExactlyOnceWith(identity, expect.any(Function), { timeout: 15_000, maxWait: 5_000 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const batch = tx.$queryRaw.mock.calls[0][0].join("");
    for (const alias of ["households", "clients", '"openDeals"', '"activeTransfers"', '"crmOpenExceptions"']) {
      expect(batch).toContain(`AS ${alias}`);
    }
    const setup = tx.$executeRaw.mock.calls[0][0].join("");
    expect(setup).toContain("set_config('statement_timeout', '10000', true)");
    expect(setup).toContain("set_config('lock_timeout', '2000', true)");
    for (const order of tx.$queryRaw.mock.invocationCallOrder) expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(order);
  });
  it("does not run any badge query if database-side cancellation cannot be configured", async () => {
    tx.$executeRaw.mockRejectedValueOnce(new Error("setup failed"));
    await expect(navCounts({ role: "ADMIN" })).rejects.toThrow("setup failed");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
