import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("prisma/migrations/20260902190000_trade_reconciliation_runs/migration.sql");
const runDateMigration = read("prisma/migrations/20260904120000_trade_reconciliation_run_date/migration.sql");
const runIdentityMigration = read("prisma/migrations/20260904190000_trade_reconciliation_run_identity/migration.sql");
const data = read("lib/data/trade-reconciliation.ts");
const actions = read("app/(authenticated)/operations/trade-reconciliation/actions.ts");

describe("Trade Reconciliation persistence controls", () => {
  it("keeps runs, reviews, and notes append-only for app_rw", () => {
    expect(migration).toContain('GRANT SELECT, INSERT ON "app"."trade_reconciliation_run" TO app_rw');
    expect(migration).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*trade_reconciliation_(run|review|note)/i);
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("limits every row to Operations/Admin and binds actor identity", () => {
    expect(migration).toContain("IN ('ADMIN', 'OPERATIONS')");
    expect(migration).toContain("current_setting('app.user_email', true)");
    expect(actions).toContain("canAccessOperationsTools(role)");
    expect(actions).toContain("operationsTradeReconciliationPreviewEnabled()");
  });

  it("is idempotent within one run date while preserving later reruns", () => {
    expect(migration).toContain('UNIQUE ("business_date", "algorithm_version", "source_digest")');
    expect(runIdentityMigration).toContain('DROP CONSTRAINT "trade_reconciliation_run_idempotency_key"');
    expect(runIdentityMigration).toContain('UNIQUE ("run_date", "business_date", "algorithm_version", "source_digest")');
    expect(data).toContain("pg_advisory_xact_lock");
    expect(data).toContain("run_date_business_date_algorithm_version_source_digest");
    expect(data).toContain("run_date: new Date(`${runDate}T00:00:00.000Z`)");
  });

  it("stores the operational run date separately from the reconciled trade date", () => {
    expect(runDateMigration).toContain('ADD COLUMN "run_date" DATE');
    expect(runDateMigration).toContain("historical run and trade");
    expect(runDateMigration).toContain("COALESCE(");
    expect(runDateMigration).toContain('"business_date"');
    expect(runDateMigration).not.toContain('CHECK ("run_date" > "business_date")');
    expect(data).toContain("run_date: new Date(`${runDate}T00:00:00.000Z`)");
    expect(data).toContain("tradeDate: dateOnly(selected.business_date)");
    expect(data).toContain("runDate: dateOnly(selected.run_date)");
  });

  it("stores masked result rows and never logs source payloads or narratives", () => {
    expect(data).toContain("persistedRows");
    expect(data).not.toMatch(/console\.(log|error)\([^\n]*(payload|sources|rows)/);
    expect(data).toContain("explanationPresent: true");
    expect(data).toContain("notePresent: true");
    expect(data).toContain('entityType: "trade_reconciliation_review_batch"');
    expect(data).toContain("reviewCount: rowFingerprints.length");
    expect(data).not.toContain("detail: { explanation");
  });
});
