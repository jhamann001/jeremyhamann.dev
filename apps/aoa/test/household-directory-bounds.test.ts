import { describe, expect, it, vi } from "vitest";
const { scope } = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
import { getHouseholdDirectory } from "@/lib/data/households";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS } from "@/lib/navigation/household-query";
import {
  applyHouseholdDirectoryDatabaseBounds, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS,
  HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS, HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS,
} from "@/lib/data/household-directory-bounds";

describe("Household directory SQL bounds", () => {
  it("sets one transaction-local command before the unchanged scoped directory query", async () => {
    const order: string[] = [];
    const execute = vi.fn(async () => { order.push("bounds"); return 1; });
    const query = vi.fn(async () => { order.push("directory"); return []; });
    scope.mockImplementationOnce(async (_identity, run) => run({ $executeRaw: execute, $queryRaw: query }));
    const identity = { role: "ADVISOR", email: "synthetic@example.invalid" };
    await getHouseholdDirectory(identity, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
    expect(scope).toHaveBeenCalledWith(identity, expect.any(Function), HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS);
    expect(order).toEqual(["bounds", "directory"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS).toEqual({ timeout: 5_000, maxWait: 2_000 });
  });

  it("cancels SQL before the transaction deadline and restores settings automatically", async () => {
    const execute = vi.fn().mockResolvedValue(1);
    await applyHouseholdDirectoryDatabaseBounds({ $executeRaw: execute } as unknown as Parameters<typeof applyHouseholdDirectoryDatabaseBounds>[0]);
    expect(execute).toHaveBeenCalledTimes(1);
    const [template, statement, lock] = execute.mock.calls[0];
    expect(template.join("")).toContain("set_config('jit', 'off', true)");
    expect(template.join("")).toContain("set_config('statement_timeout', , true)");
    expect(template.join("")).toContain("set_config('lock_timeout', , true)");
    expect(statement).toBe(String(HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS));
    expect(lock).toBe(String(HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS));
    expect(HOUSEHOLD_DIRECTORY_LOCK_TIMEOUT_MS).toBeLessThan(HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS);
    expect(HOUSEHOLD_DIRECTORY_STATEMENT_TIMEOUT_MS).toBeLessThan(HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS.timeout);
  });

  it("shares only concurrent default reads for the same RLS identity", async () => {
    vi.stubEnv("HOUSEHOLD_DIRECTORY_FAST_PATH", "1");
    scope.mockReset();
    const releases: Array<() => void> = [];
    scope.mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve([]));
    }));
    try {
      const advisor = { role: "ADVISOR", email: "first@example.invalid" };
      const anotherAdvisor = { role: "ADVISOR", email: "second@example.invalid" };
      const first = getHouseholdDirectory(advisor, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
      const duplicate = getHouseholdDirectory(advisor, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
      const otherBook = getHouseholdDirectory(anotherAdvisor, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
      expect(duplicate).toBe(first);
      expect(otherBook).not.toBe(first);
      expect(scope).toHaveBeenCalledTimes(2);

      releases[0]();
      releases[1]();
      await Promise.all([first, duplicate, otherBook]);

      const nextRead = getHouseholdDirectory(advisor, DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
      expect(scope).toHaveBeenCalledTimes(3);
      releases[2]();
      await nextRead;
    } finally {
      vi.unstubAllEnvs();
      scope.mockReset();
    }
  });
});
