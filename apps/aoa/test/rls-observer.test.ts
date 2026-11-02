import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: transaction } }));
import { withUserScope } from "@/lib/rls";

describe("withUserScope passive acquisition observer", () => {
  beforeEach(() => { transaction.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([false, true])("observes acquisition before unchanged RLS setup (combined=%s)", async combined => {
    const order: string[] = [];
    const execute = vi.fn(async () => { order.push("setup"); });
    const tx = { $executeRaw: execute };
    transaction.mockImplementationOnce(async run => run(tx));
    const result = { allowed: true };
    const observer = vi.fn(() => { order.push("acquired"); });
    const callback = vi.fn(async received => {
      expect(received).toBe(tx); order.push("query"); return result;
    });
    const options = { maxWait: 2_000, timeout: 5_000, onTransactionAcquired: observer,
      ...(combined ? { initialSettingsSql: Prisma.sql`, set_config('jit', 'off', true)` } : {}) };
    expect(await withUserScope({ role: "ADVISOR", email: "scope@example.invalid" }, callback, options)).toBe(result);
    expect(order).toEqual(combined ? ["acquired", "setup", "query"] : ["acquired", "setup", "setup", "query"]);
    expect(observer).toHaveBeenCalledExactlyOnceWith();
    expect(transaction.mock.calls[0][1]).toEqual({ maxWait: 2_000, timeout: 5_000 });
    const values = execute.mock.calls.map(call => call.slice(1));
    expect(values.flat()).toEqual(["ADVISOR", "scope@example.invalid", ...(combined ? [options.initialSettingsSql] : [])]);
  });

  it("ignores observer failure and still establishes fail-closed scope", async () => {
    const execute = vi.fn(async () => {});
    transaction.mockImplementationOnce(async run => run({ $executeRaw: execute }));
    const run = vi.fn(async () => "result");
    expect(await withUserScope({ role: "unknown" }, run, {
      onTransactionAcquired: () => { throw new Error("observer unavailable"); },
    })).toBe("result");
    expect(execute.mock.calls.map(call => call.slice(1)).flat()).toEqual(["VIEWER", ""]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("preserves setup failure and never executes scoped work afterward", async () => {
    const error = new Error("setup failed");
    const execute = vi.fn(async () => { throw error; });
    transaction.mockImplementationOnce(async run => run({ $executeRaw: execute }));
    const observer = vi.fn(); const run = vi.fn();
    await expect(withUserScope({ role: "OPERATIONS" }, run, { onTransactionAcquired: observer })).rejects.toBe(error);
    expect(observer).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not observe a transaction that fails before acquisition", async () => {
    const error = new Error("acquisition failed");
    transaction.mockRejectedValueOnce(error);
    const observer = vi.fn(); const run = vi.fn();
    await expect(withUserScope({}, run, { onTransactionAcquired: observer })).rejects.toBe(error);
    expect(observer).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it("retains behavior when no observer is supplied", async () => {
    const execute = vi.fn(async () => {});
    transaction.mockImplementationOnce(async run => run({ $executeRaw: execute }));
    expect(await withUserScope({}, async () => 7)).toBe(7);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(transaction.mock.calls[0][1]).toEqual({});
  });
});
