import { describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { applyLegacyImport, type LegacyImportInput } from "@/lib/operations/legacy-import-engine";
import { parseLegacyTradeReconciliationCsv } from "@/lib/operations/legacy-import";

// Executes the real engine with an in-memory transaction double. These tests
// prove callback ordering and zero attempted inserts after revocation, not real
// PostgreSQL rollback/RLS semantics (those remain integration-test gates).
function syntheticInput(): LegacyImportInput {
  const parsed = parseLegacyTradeReconciliationCsv([
    "id,trade_date,run_time,total_apex,total_meridian,perfect_matches,breaks,unmatched_apex,unmatched_meridian,match_rate,Notes",
    "761704106,2026-09-01,9/2/2026 6:30:00 AM,1,1,1,0,0,0,100,Synthetic historical run note",
  ].join("\n"));
  expect(parsed.issues).toEqual([]);
  expect(parsed.rows).toHaveLength(1);
  return { requests: [], reviewedMappings: [], reconciliations: parsed.rows, issues: [] };
}

function engineDouble(onLock: () => void = () => {}) {
  const events: string[] = [];
  let stored: { source_digest: string } | null = null;
  let attemptedInserts = 0;
  const tx = {
    $queryRaw: async () => { events.push("advisory-lock"); onLock(); return [{ locked: "" }]; },
    operationsSlackNotification: { count: async () => { events.push("slack-count"); return 0; } },
    operationsFeeRequest: { create: async () => { attemptedInserts++; throw new Error("unexpected fee insert"); } },
    operationsFeeRequestEvent: { createMany: async () => { attemptedInserts++; throw new Error("unexpected fee event"); } },
    tradeReconciliationRun: {
      findFirst: async () => { events.push("read-existing"); return stored; },
      create: async ({ data }: { data: { source_digest: string } }) => {
        events.push("insert-run"); attemptedInserts++; stored = { source_digest: data.source_digest };
        return stored;
      },
    },
    tradeReconciliationNoteEvent: { createMany: async () => { events.push("insert-note"); attemptedInserts++; return { count: 1 }; } },
  };
  const owner = {
    $transaction: async (fn: (transaction: Prisma.TransactionClient) => Promise<unknown>, options: Record<string, unknown>) => {
      expect(options.isolationLevel).toBe("Serializable");
      events.push("transaction-start");
      try { const result = await fn(tx as unknown as Prisma.TransactionClient); events.push("transaction-return"); return result; }
      catch (error) { events.push("transaction-reject"); throw error; }
    },
  } as unknown as PrismaClient;
  return { owner, events, inserts: () => attemptedInserts };
}

describe("private import pre-write authority revalidation", () => {
  it.each(["job_approval_expired", "job_execution_revoked", "job_identity_invalid"])(
    "stops before every insert when %s becomes known after the advisory lock", async (reason) => {
      let blocked = false;
      const db = engineDouble(() => { blocked = true; });
      await expect(applyLegacyImport(db.owner, syntheticInput(),
        async () => { db.events.push("target-verified"); },
        async () => { db.events.push("plan-verified"); },
        async () => { db.events.push("execution-rechecked"); if (blocked) throw new Error(reason); },
      )).rejects.toThrow(reason);
      expect(db.inserts()).toBe(0);
      expect(db.events.indexOf("execution-rechecked")).toBeGreaterThan(db.events.indexOf("advisory-lock"));
      expect(db.events.indexOf("execution-rechecked")).toBeGreaterThan(db.events.indexOf("plan-verified"));
      expect(db.events).not.toContain("transaction-return");
    },
  );

  it("does not call the late authority callback if the approved plan is already rejected", async () => {
    const db = engineDouble();
    let lateChecks = 0;
    await expect(applyLegacyImport(db.owner, syntheticInput(), async () => {},
      async () => { throw new Error("approval_plan_changed"); },
      async () => { lateChecks++; },
    )).rejects.toThrow("approval_plan_changed");
    expect(lateChecks).toBe(0);
    expect(db.inserts()).toBe(0);
  });

  it("runs the successful late check exactly once and before the first insert", async () => {
    const db = engineDouble();
    await expect(applyLegacyImport(db.owner, syntheticInput(), async () => {}, async () => {},
      async () => { db.events.push("execution-rechecked"); },
    )).resolves.toMatchObject({ inserted: { fee_store_daily_reconciliation: 1 } });
    expect(db.events.filter((event) => event === "execution-rechecked")).toHaveLength(1);
    expect(db.events.indexOf("execution-rechecked")).toBeLessThan(db.events.indexOf("insert-run"));
    expect(db.inserts()).toBe(2); // One run plus its original append-only note.
  });

  it("preserves workstation engine compatibility without a job callback", async () => {
    const db = engineDouble();
    await expect(applyLegacyImport(db.owner, syntheticInput(), async () => {}, async () => {}))
      .resolves.toMatchObject({ inserted: { fee_store_daily_reconciliation: 1 } });
    expect(db.inserts()).toBe(2);
  });
});
