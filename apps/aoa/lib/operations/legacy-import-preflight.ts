import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { validateLegacyImportDatabaseIdentity, type LegacyImportTarget, type VerifiedLegacyImportCloudMetadata } from "./legacy-import-target";

export type LegacyImportMigration = { name: string; checksum: string };
const TABLES = [
  "operations_fee_request", "operations_fee_request_event", "operations_slack_notification",
  "trade_reconciliation_run", "trade_reconciliation_note_event",
];

/** Catalog-only checks, inside the same transaction that reads or writes rows. */
export async function verifyLegacyImportDatabase(
  tx: Prisma.TransactionClient,
  target: LegacyImportTarget,
  cloud: VerifiedLegacyImportCloudMetadata,
  expectedMigrations: readonly LegacyImportMigration[],
): Promise<string> {
  // inet::text includes a netmask (/32 for IPv4); Cloud SQL returns a bare IP.
  // host() normalizes that representation without relaxing exact-IP validation.
  const identities = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT current_database() AS name, host(inet_server_addr()) AS server_address,
      current_user::text AS current_user, session_user::text AS session_user,
      rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  if (identities.length !== 1) throw new Error("database_identity_invalid");
  validateLegacyImportDatabaseIdentity(target, cloud, identities[0]);

  const ledgers = await tx.$queryRaw<Array<{ ledger: string | null }>>`
    SELECT to_regclass('app._prisma_migrations')::text AS ledger`;
  if (!ledgers[0]?.ledger) throw new Error("schema_not_ready");
  const migrations = await tx.$queryRaw<Array<{ name: string; checksum: string; finished: boolean }>>`
    SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished
      FROM app._prisma_migrations WHERE rolled_back_at IS NULL ORDER BY migration_name`;
  if (!expectedMigrations.length || migrations.length !== expectedMigrations.length
    || migrations.some((row, index) => !row.finished
      || row.name !== expectedMigrations[index].name || row.checksum !== expectedMigrations[index].checksum)) {
    throw new Error("schema_migration_mismatch");
  }

  const relations = await tx.$queryRaw<Array<{ name: string; owner: string; rls: boolean; forced: boolean }>>`
    SELECT c.relname AS name, r.rolname AS owner, c.relrowsecurity AS rls,
      c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'app' AND c.relname = ANY(${TABLES}::text[])
      AND c.relkind = 'r' ORDER BY c.relname`;
  if (relations.length !== TABLES.length
    || relations.some((row) => row.owner !== cloud.owner || !row.rls || !row.forced)) {
    throw new Error("schema_security_mismatch");
  }
  const columns = await tx.$queryRaw`
    SELECT table_name, column_name, data_type, udt_schema, udt_name, is_nullable,
      column_default, ordinal_position FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = ANY(${TABLES}::text[])
    ORDER BY table_name, ordinal_position`;
  const constraints = await tx.$queryRaw`
    SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ANY(${TABLES}::text[])
    ORDER BY c.relname, k.conname`;
  const policies = await tx.$queryRaw`
    SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'app' AND tablename = ANY(${TABLES}::text[])
    ORDER BY tablename, policyname`;
  const triggers = await tx.$queryRaw`
    SELECT c.relname, t.tgname, t.tgenabled::text, pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function_definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ANY(${TABLES}::text[]) AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname`;
  const indexes = await tx.$queryRaw`
    SELECT c.relname, i.relname AS indexname, pg_get_indexdef(x.indexrelid) AS definition,
      x.indisvalid, x.indisready
    FROM pg_index x JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ANY(${TABLES}::text[])
    ORDER BY c.relname, i.relname`;
  const acl = await tx.$queryRaw`
    SELECT table_name, NULL::text AS column_name, privilege_type, grantee, grantor, is_grantable
    FROM information_schema.table_privileges
    WHERE table_schema = 'app' AND table_name = ANY(${TABLES}::text[])
    UNION ALL
    SELECT table_name, column_name, privilege_type, grantee, grantor, is_grantable
    FROM information_schema.column_privileges
    WHERE table_schema = 'app' AND table_name = ANY(${TABLES}::text[])
    ORDER BY table_name, column_name, grantee, privilege_type, grantor, is_grantable`;
  return crypto.createHash("sha256")
    .update(JSON.stringify({ migrations, relations, columns, constraints, policies, triggers, indexes, acl }))
    .digest("hex");
}
