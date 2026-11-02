import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy } = vi.hoisted(() => ({ scopeSpy: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));

import {
  CRM_EXPLORER_TRANSACTION_MAX_WAIT_MS,
  CRM_EXPLORER_TRANSACTION_TIMEOUT_MS,
  applyCrmExplorerDatabaseBounds,
  getCrmIdentityDetail,
  listCrmIdentities,
} from "@/lib/data/crm-explorer";

const OPS = { role: "OPERATIONS", email: "ops@example.test" };

describe("CRM Explorer transaction bounds", () => {
  beforeEach(() => {
    process.env.CRM_IDENTITY_READS = "1";
    scopeSpy.mockReset();
    scopeSpy.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete process.env.CRM_IDENTITY_READS;
  });

  it("applies the extended bound only to Explorer list and detail reads", async () => {
    await listCrmIdentities(OPS);
    await getCrmIdentityDetail(OPS, "hld_example");

    expect(scopeSpy).toHaveBeenCalledTimes(2);
    for (const [index, call] of scopeSpy.mock.calls.entries()) {
      expect(call[2]).toEqual({
        timeout: CRM_EXPLORER_TRANSACTION_TIMEOUT_MS,
        maxWait: CRM_EXPLORER_TRANSACTION_MAX_WAIT_MS,
        ...(index === 0 ? { isolationLevel: "RepeatableRead" } : {}),
      });
    }
  });

  it("still rejects non-operations roles before opening a transaction", async () => {
    await expect(listCrmIdentities({ role: "ADVISOR", email: "advisor@example.test" }))
      .resolves.toEqual({ ok: false, reason: "forbidden" });
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("disables JIT only within the bounded CRM read transaction", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    await applyCrmExplorerDatabaseBounds({ $executeRaw: execute } as unknown as Parameters<typeof applyCrmExplorerDatabaseBounds>[0]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0].join("")).toBe("SELECT set_config('jit', 'off', true)");
    expect(execute.mock.calls[1][0].join("")).toContain("'statement_timeout'");
    expect(execute.mock.calls[1][1]).toBe("10000");
    expect(execute.mock.calls[2][0].join("")).toContain("'lock_timeout'");
    expect(execute.mock.calls[2][1]).toBe("2000");
  });
});
