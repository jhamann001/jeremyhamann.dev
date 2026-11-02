import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260903233000_legacy_operations_import/migration.sql"),
  "utf8",
);
const householdScopeMigration = fs.readFileSync(
  path.join(root, "prisma/migrations/20260914133000_legacy_operations_household_scope/migration.sql"),
  "utf8",
);
const script = [
  "scripts/import-legacy-operations.ts", "lib/operations/legacy-import-engine.ts",
  "lib/operations/legacy-import-target.ts", "lib/operations/legacy-import-preflight.ts",
].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const tradeData = fs.readFileSync(path.join(root, "lib/data/trade-reconciliation.ts"), "utf8");
const tradeHistory = fs.readFileSync(path.join(root, "lib/data/reconciliation-history.ts"), "utf8");
const tradeUi = fs.readFileSync(path.join(root, "components/operations/TradeReconciliationPrototype.tsx"), "utf8");
const feeData = fs.readFileSync(path.join(root, "lib/data/operations-fee-requests.ts"), "utf8");

describe("legacy Operations import database boundary", () => {
  it("uses source + legacy ID uniqueness and content digests", () => {
    expect(migration).toContain("operations_fee_request_legacy_key");
    expect(migration).toContain("trade_reconciliation_run_legacy_key");
    expect(migration).toContain("legacy_source_digest");
    expect(script).toContain("existing_record_drift");
    expect(script).toContain("existing_mapping_drift");
  });

  it("does not weaken live authenticated write policies", () => {
    expect(migration).not.toMatch(/CREATE POLICY\s+\S+\s+ON\s+\S+\s+FOR\s+(?:ALL|INSERT).*TO\s+app_rw[\s\S]{0,500}legacy_source/i);
    expect(migration).not.toMatch(/GRANT\s+(UPDATE|DELETE)/i);
    expect(migration).toContain("owner_role text := quote_ident(current_user)");
    expect(migration).toContain("operations_fee_request_legacy_owner_insert");
    expect(migration).toContain("trade_reconciliation_run_legacy_owner_insert");
    expect(script).toContain("parseLegacyImportOptions");
    expect(script).toContain("verifyLegacyImportApproval");
    expect(script).toContain("apply_environment_gate_missing");
    expect(script).toContain("SET TRANSACTION READ ONLY");
    expect(script).toContain("current_database()");
    expect(script).toContain('project: "ops-portal-dev", instance: "aoa-dev-postgres"');
    expect(script).toContain('project: "ops-portal", instance: "aoa-postgres"');
    expect(script).toContain("inet_server_addr()");
    expect(script).toContain("apply_revalidation_failed");
    expect(script).toContain("loadLegacyImportDirectory(requests, reviewedMappings, tx)");
    expect(script).toContain("Prisma.TransactionIsolationLevel.Serializable");
    expect(script).not.toContain('argValue("--expected-database")');
  });

  it("stores legacy display names without manufacturing emails", () => {
    expect(migration).toContain('ALTER COLUMN "submitted_by_email" DROP NOT NULL');
    expect(migration).toContain('ADD COLUMN "submitted_by_name"');
    expect(script).toContain("submitted_by_email: null");
    expect(script).toContain("reviewed_by_email: null");
    expect(script).toContain("completed_by_email: null");
  });

  it("marks imported reconciliation as summary-only", () => {
    expect(script).toContain('algorithm_version: "legacy-summary-v1"');
    expect(script).toContain("payload: []");
    expect(script).toContain("run_date: new Date(`${row.runDate}T00:00:00.000Z`)");
    expect(script).not.toContain("tradeReconciliationReviewEvent.create");
    expect(tradeData).toContain('summaryOnly = run.legacy_source === "fee_store_daily_reconciliation"');
    expect(tradeData).toContain("run.exception_count + legacyUnmatchedApex + legacyUnmatchedMeridian");
    expect(tradeData).toContain("meridianMatchRate(run.raw_match_count, run.meridian_record_count)");
    expect(tradeHistory).not.toContain("COALESCE(r.legacy_match_rate, r.raw_match_rate)");
    expect(tradeHistory).toContain("r.exception_count + COALESCE(r.legacy_unmatched_apex, 0) + COALESCE(r.legacy_unmatched_alpha, 0)");
    expect(tradeUi).toContain("Historical summary only.");
    expect(tradeUi).toContain('label="Unmatched Meridian"');
  });

  it("retains same-date reruns in daily history", () => {
    expect(tradeHistory).toContain("FROM runs WHERE ${view} = 'daily'");
    expect(tradeHistory).toContain("PARTITION BY r.business_date ORDER BY r.run_date DESC, r.completed_at DESC, r.id DESC");
    expect(tradeHistory).toContain("FROM runs WHERE ${view} <> 'daily' AND latest = 1");
    expect(tradeHistory).toContain("SELECT COUNT(*) FROM history");
    expect(tradeHistory).toContain("LIMIT ${RECONCILIATION_HISTORY_PAGE_SIZE}");
    expect(tradeData).toContain("where: { id: requestedRunId }");
    expect(tradeData).not.toContain("take: 260");
  });

  it("hydrates historical account labels even when the source row is closed", () => {
    const hydration = feeData.slice(feeData.indexOf("const requestAccounts"), feeData.indexOf("return { requestClients"));
    expect(hydration).not.toContain("source_present");
    expect(hydration).toContain("custodian_account_id IN");
  });

  it("limits household-scoped imports to the exact reviewed source records", () => {
    expect(householdScopeMigration).toContain('CREATE TYPE "app"."OperationsFeeRequestScope" AS ENUM (\'CLIENT\', \'HOUSEHOLD\')');
    expect(householdScopeMigration).toContain("\"legacy_source\" = 'fee_store_fee_credits' AND \"legacy_source_id\" IN ('26', '27', '31', '40')");
    expect(householdScopeMigration).toContain("\"legacy_source\" = 'fee_store_billing_exceptions' AND \"legacy_source_id\" IN ('8', '11', '15', '18', '20', '24')");
    expect(householdScopeMigration).toContain('AND "legacy_client_name" IS NOT NULL');
    expect(householdScopeMigration).toContain('AND "legacy_household_sf_id" IS NOT NULL');
    expect(householdScopeMigration).toContain('IF NEW."scope" <> \'HOUSEHOLD\' THEN');
    expect(householdScopeMigration).toContain("legacy_client_not_in_household");
    expect(householdScopeMigration).toContain("legacy_account_not_in_household");
  });

  it("keeps live app requests client-scoped and legacy scope immutable", () => {
    expect(householdScopeMigration).toContain('AND "scope" = \'CLIENT\'');
    expect(householdScopeMigration).toContain('AND "legacy_source" IS NULL');
    expect(householdScopeMigration).toContain('NEW."scope" IS DISTINCT FROM OLD."scope"');
    expect(householdScopeMigration).not.toMatch(/CREATE POLICY[\s\S]{0,500}TO\s+(?:advisor|viewer)/i);
    expect(householdScopeMigration).not.toMatch(/GRANT\s+(?:UPDATE|DELETE)/i);
  });

  it("persists reviewed scope and original source display identity", () => {
    expect(script).toContain("scope: row.scope");
    expect(script).toContain("legacy_household_sf_id: row.householdSfId");
    expect(script).toContain("legacy_client_name: row.clientName");
    expect(feeData).toContain("request.legacy_client_name ?? client?.name");
    expect(feeData).toContain("request.legacy_household_sf_id");
    expect(feeData).toContain("ownerName:");
  });

  it("uses matching NFKC normalization in the resolver and directory selector", () => {
    expect(script).toContain("normalizeLegacyDirectoryName(row.clientName)");
    expect(script).toContain("normalize(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''), NFKC)");
  });
});
