import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { verifyLegacyImportDatabase, type LegacyImportMigration } from "@/lib/operations/legacy-import-preflight";
import { validateLegacyImportCloudMetadata, type LegacyImportTarget } from "@/lib/operations/legacy-import-target";

const tables = [
  "operations_fee_request", "operations_fee_request_event", "operations_slack_notification",
  "trade_reconciliation_note_event", "trade_reconciliation_run",
];
const expectedMigrations: LegacyImportMigration[] = [
  { name: "20260901000000_synthetic_base", checksum: "a".repeat(64) },
  { name: "20260914000000_synthetic_import", checksum: "b".repeat(64) },
];
const cloud = (target: LegacyImportTarget = "prod") => validateLegacyImportCloudMetadata(target, {
  name: target === "prod" ? "aoa-postgres" : "aoa-dev-postgres",
  connectionName: target === "prod" ? "ops-portal:us-central1:aoa-postgres" : "ops-portal-dev:us-central1:aoa-dev-postgres",
  region: "us-central1", ipAddresses: [{ type: "PRIVATE", ipAddress: "10.22.33.44" }],
});

function catalog() {
  return {
    identities: [{ name: "aoa", server_address: "10.22.33.44", current_user: "aoa_admin", session_user: "aoa_admin", rolsuper: false, rolbypassrls: false }],
    ledgers: [{ ledger: "app._prisma_migrations" }],
    migrations: expectedMigrations.map((migration) => ({ ...migration, finished: true })),
    relations: tables.map((name) => ({ name, owner: "aoa_admin", rls: true, forced: true })),
    columns: [{ table_name: "operations_fee_request", column_name: "id", data_type: "text", udt_schema: "pg_catalog", udt_name: "text", is_nullable: "NO", column_default: null, ordinal_position: 1 }],
    constraints: [{ relname: "operations_fee_request", conname: "synthetic_primary_key", definition: "PRIMARY KEY (id)" }],
    policies: [{ tablename: "operations_fee_request", policyname: "synthetic_owner_read", permissive: "PERMISSIVE", roles: ["aoa_admin"], cmd: "SELECT", qual: "true", with_check: null }],
    triggers: [{ relname: "operations_fee_request", tgname: "synthetic_guard", tgenabled: "O", definition: "CREATE TRIGGER synthetic_guard BEFORE UPDATE ON app.operations_fee_request FOR EACH ROW EXECUTE FUNCTION app.synthetic_guard()", function_definition: "CREATE FUNCTION app.synthetic_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'" }],
    indexes: [{ relname: "operations_fee_request", indexname: "synthetic_primary_key", definition: "CREATE UNIQUE INDEX synthetic_primary_key ON app.operations_fee_request USING btree (id)", indisvalid: true, indisready: true }],
    acl: [
      { table_name: "operations_fee_request", column_name: "id", privilege_type: "SELECT", grantee: "aoa_admin", grantor: "aoa_admin", is_grantable: "YES" },
      { table_name: "operations_fee_request", column_name: null, privilege_type: "SELECT", grantee: "app_rw", grantor: "aoa_admin", is_grantable: "NO" },
    ],
  };
}

type Catalog = ReturnType<typeof catalog>;
function transaction(data: Catalog = catalog()) {
  const query = vi.fn();
  for (const key of ["identities", "ledgers", "migrations", "relations", "columns", "constraints", "policies", "triggers", "indexes", "acl"] as const) query.mockResolvedValueOnce(data[key]);
  const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
  return { tx, query };
}

describe("legacy import catalog preflight", () => {
  it.each(["dev", "prod"] as const)("verifies a matching %s owner before reading catalog security", async (target) => {
    const { tx, query } = transaction();
    expect(await verifyLegacyImportDatabase(tx, target, cloud(target), expectedMigrations)).toMatch(/^[a-f0-9]{64}$/);
    expect(query).toHaveBeenCalledTimes(10);
    const sql = query.mock.calls.map((call) => (call[0] as TemplateStringsArray).join("?"));
    expect(sql[0]).toContain("current_database()");
    // Explicit inet::text includes /32 for IPv4. Compare the host alone to
    // Cloud SQL's bare private IP without weakening the exact target check.
    expect(sql[0]).toContain("host(inet_server_addr()) AS server_address");
    expect(sql[0]).not.toContain("inet_server_addr()::text");
    expect(sql[0]).toContain("session_user");
    expect(sql[1]).toContain("to_regclass('app._prisma_migrations')");
    expect(sql[2]).toContain("WHERE rolled_back_at IS NULL ORDER BY migration_name");
    expect(sql[8]).toContain("pg_get_indexdef");
    expect(sql[9]).toContain("information_schema.table_privileges");
    expect(sql[9]).toContain("information_schema.column_privileges");
    expect(sql.every((statement) => statement.trimStart().startsWith("SELECT"))).toBe(true);
  });

  it.each([
    ["database_name_mismatch", { name: "unrelated_database" }],
    ["database_server_mismatch", { server_address: "127.0.0.1" }],
    ["database_server_mismatch", { server_address: "10.22.33.45" }],
    ["database_server_mismatch", { server_address: "10.22.33.44/32" }],
    ["database_owner_mismatch", { current_user: "app_rw" }],
    ["database_owner_mismatch", { session_user: "postgres" }],
    ["database_owner_privileges_unsafe", { rolsuper: true }],
    ["database_owner_privileges_unsafe", { rolbypassrls: true }],
  ] as const)("stops at %s without reading the migration ledger", async (code, override) => {
    const data = catalog();
    data.identities[0] = { ...data.identities[0], ...override };
    const { tx, query } = transaction(data);
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud(), expectedMigrations)).rejects.toThrow(code);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2])("rejects %s SQL identity rows before any further reads", async (count) => {
    const data = catalog();
    data.identities = Array.from({ length: count }, () => ({ ...catalog().identities[0] }));
    const { tx, query } = transaction(data);
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud(), expectedMigrations)).rejects.toThrow("database_identity_invalid");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched cloud target metadata before the ledger", async () => {
    const { tx, query } = transaction();
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud("dev"), expectedMigrations)).rejects.toThrow("cloud_target_mismatch");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", undefined])("rejects a missing migration ledger (%s)", async (ledger) => {
    const data = catalog();
    data.ledgers = ledger === undefined ? [] : [{ ledger: ledger as string }];
    const { tx, query } = transaction(data);
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud(), expectedMigrations)).rejects.toThrow("schema_not_ready");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing migration", (data: Catalog) => { data.migrations.pop(); }],
    ["unfinished migration", (data: Catalog) => { data.migrations[1].finished = false; }],
    ["unexpected migration", (data: Catalog) => { data.migrations.push({ name: "20260915000000_unapproved", checksum: "c".repeat(64), finished: true }); }],
    ["checksum drift", (data: Catalog) => { data.migrations[1].checksum = "c".repeat(64); }],
    ["wrong migration name", (data: Catalog) => { data.migrations[1].name = "20260914000000_unexpected"; }],
    ["duplicate migration", (data: Catalog) => { data.migrations[1] = { ...data.migrations[0] }; }],
    ["no installed migrations", (data: Catalog) => { data.migrations = []; }],
  ] as const)("rejects %s before reading table security", async (_label, alter) => {
    const data = catalog();
    alter(data);
    const { tx, query } = transaction(data);
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud(), expectedMigrations)).rejects.toThrow("schema_migration_mismatch");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not approve an empty expected migration manifest", async () => {
    const data = catalog();
    data.migrations = [];
    const { tx, query } = transaction(data);
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud(), [])).rejects.toThrow("schema_migration_mismatch");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing relation", (data: Catalog) => { data.relations.pop(); }],
    ["missing all relations", (data: Catalog) => { data.relations = []; }],
    ["wrong relation owner", (data: Catalog) => { data.relations[0].owner = "app_rw"; }],
    ["row-level security disabled", (data: Catalog) => { data.relations[0].rls = false; }],
    ["forced RLS disabled", (data: Catalog) => { data.relations[0].forced = false; }],
  ] as const)("rejects %s before generating a fingerprint", async (_label, alter) => {
    const data = catalog();
    alter(data);
    const { tx, query } = transaction(data);
    await expect(verifyLegacyImportDatabase(tx, "prod", cloud(), expectedMigrations)).rejects.toThrow("schema_security_mismatch");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("produces a repeatable SHA256 of the verified schema and security catalog", async () => {
    const data = catalog();
    const first = await verifyLegacyImportDatabase(transaction(data).tx, "prod", cloud(), expectedMigrations);
    const second = await verifyLegacyImportDatabase(transaction(catalog()).tx, "prod", cloud(), expectedMigrations);
    const { migrations, relations, columns, constraints, policies, triggers, indexes, acl } = data;
    expect(first).toBe(second);
    expect(first).toBe(createHash("sha256").update(JSON.stringify({ migrations, relations, columns, constraints, policies, triggers, indexes, acl })).digest("hex"));
    expect(first).not.toContain("aoa_admin");
    expect(first).not.toContain("10.22.33.44");
  });

  it.each([
    ["column type", (data: Catalog) => { data.columns[0].data_type = "character varying"; }],
    ["nullable column", (data: Catalog) => { data.columns[0].is_nullable = "YES"; }],
    ["constraint definition", (data: Catalog) => { data.constraints[0].definition = "PRIMARY KEY (id, legacy_source)"; }],
    ["policy expression", (data: Catalog) => { data.policies[0].qual = "false"; }],
    ["policy roles", (data: Catalog) => { data.policies[0].roles = ["aoa_admin", "app_rw"]; }],
    ["removed policy", (data: Catalog) => { data.policies = []; }],
    ["trigger definition", (data: Catalog) => { data.triggers[0].definition += " /* synthetic drift */"; }],
    ["trigger function body", (data: Catalog) => { data.triggers[0].function_definition += " /* synthetic drift */"; }],
    ["disabled trigger", (data: Catalog) => { data.triggers[0].tgenabled = "D"; }],
    ["removed trigger", (data: Catalog) => { data.triggers = []; }],
    ["index definition", (data: Catalog) => { data.indexes[0].definition = data.indexes[0].definition.replace("UNIQUE ", ""); }],
    ["index validity", (data: Catalog) => { data.indexes[0].indisvalid = false; }],
    ["index readiness", (data: Catalog) => { data.indexes[0].indisready = false; }],
    ["removed index", (data: Catalog) => { data.indexes = []; }],
    ["column grantee", (data: Catalog) => { data.acl[0].grantee = "app_rw"; }],
    ["column privilege", (data: Catalog) => { data.acl[0].privilege_type = "UPDATE"; }],
    ["column privilege grantor", (data: Catalog) => { data.acl[0].grantor = "app_rw"; }],
    ["column grant option", (data: Catalog) => { data.acl[0].is_grantable = "NO"; }],
    ["table privilege", (data: Catalog) => { data.acl[1].privilege_type = "DELETE"; }],
    ["table grant option", (data: Catalog) => { data.acl[1].is_grantable = "YES"; }],
    ["removed table privilege", (data: Catalog) => { data.acl.pop(); }],
    ["removed privilege", (data: Catalog) => { data.acl = []; }],
  ] as const)("changes the fingerprint when the %s changes after approval", async (_label, alter) => {
    const baseline = await verifyLegacyImportDatabase(transaction().tx, "prod", cloud(), expectedMigrations);
    const data = catalog();
    alter(data);
    const changed = await verifyLegacyImportDatabase(transaction(data).tx, "prod", cloud(), expectedMigrations);
    expect(changed).not.toBe(baseline);
  });
});
