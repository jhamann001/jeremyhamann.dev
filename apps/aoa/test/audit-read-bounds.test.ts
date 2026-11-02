import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy } = vi.hoisted(() => ({ scopeSpy: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
import { listAuditLog } from "@/lib/data/audit-log";
import { listRowChanges } from "@/lib/data/row-changes";
import {
  applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS,
  AUDIT_READ_STATEMENT_TIMEOUT_MS, AUDIT_READ_LOCK_TIMEOUT_MS,
} from "@/lib/data/audit-read-bounds";

describe("Audit read bounds", () => {
  beforeEach(() => { scopeSpy.mockReset(); scopeSpy.mockResolvedValue({ ok: true }); });

  it("keeps the bounds within both authorized repeatable-read seams", async () => {
    const ops = { role: "OPERATIONS", email: "audit-bounds@example.invalid" };
    await listAuditLog(ops);
    await listRowChanges(ops);
    expect(scopeSpy).toHaveBeenCalledTimes(2);
    for (const call of scopeSpy.mock.calls) {
      expect(call[2]).toEqual({ ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: "RepeatableRead" });
    }
    scopeSpy.mockClear();
    for (const read of [listAuditLog, listRowChanges]) {
      expect(await read({ ...ops, role: "ADVISOR" })).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("uses transaction-local statement, lock and JIT limits without changing RLS", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    await applyAuditReadDatabaseBounds({ $executeRaw: execute } as unknown as Parameters<typeof applyAuditReadDatabaseBounds>[0]);
    expect(execute).toHaveBeenCalledTimes(3);
    for (const [index, setting, value] of [
      [0, "statement_timeout", AUDIT_READ_STATEMENT_TIMEOUT_MS],
      [1, "lock_timeout", AUDIT_READ_LOCK_TIMEOUT_MS],
    ] as const) {
      expect(execute.mock.calls[index][0].join("")).toContain(`'${setting}'`);
      expect(execute.mock.calls[index][0].join("")).toContain(", true");
      expect(execute.mock.calls[index][1]).toBe(String(value));
    }
    expect(execute.mock.calls[2][0].join("")).toBe("SELECT set_config('jit', 'off', true)");
  });
});
