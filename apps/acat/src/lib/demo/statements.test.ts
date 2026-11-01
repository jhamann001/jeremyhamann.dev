// @vitest-environment node

import { describe, expect, it } from "vitest";
import { planDemoTransfers } from "./seed";
import { pipelineStatements } from "./statements";
import { loadUniverse } from "./universe";

const NOW = new Date("2026-10-27T15:00:00Z");

describe("demo statement pipeline", () => {
  it("holds one statement per delivering account the seeded transfers use", () => {
    const universe = loadUniverse();
    const statements = pipelineStatements(universe, NOW);
    const numbers = statements.map((s) => s.account_number);
    expect(new Set(numbers).size).toBe(numbers.length);
    const { transfers } = planDemoTransfers(universe, NOW);
    for (const t of transfers.filter((x) => x.statementAccountNumber && x.statement && x.assets.length > 0)) {
      expect(numbers).toContain(t.statementAccountNumber);
    }
  });

  it("holds the outside account of each household with no transfer, so a visitor can open one and reconcile it", () => {
    const universe = loadUniverse();
    const { transfers } = planDemoTransfers(universe, NOW);
    const busy = new Set(transfers.map((t) => t.household));
    const free = universe.households.filter((h) => !busy.has(h.id));
    expect(free.length).toBeGreaterThan(0);

    const statements = pipelineStatements(universe, NOW);
    for (const household of free) {
      const owner = universe.people.find((p) => p.household === household.id)!;
      const found = statements.filter((s) => s.client_name.includes(owner.last));
      expect(found).toHaveLength(1);
      const [statement] = found;
      expect(statement.custodian).toBe("BNY Investments");
      expect(statement.account_number).toMatch(/^BNY-\d{8}$/);
      expect(statement.positions.length).toBeGreaterThan(0);
      expect(statement.positions.every((p) => p.transferring === "YES" && p.quantity > 0)).toBe(true);
      expect(statement.statement_date).toBe("2026-09-30");
      expect(Date.parse(statement.processed_at)).toBeLessThan(NOW.getTime());
    }
    expect(pipelineStatements(universe, NOW)).toEqual(statements);
  });
});
