// Runs server/sql/create-ops-portal-copy-role.sql and checks the role's reach. Other integration files TRUNCATE the
// public tables in parallel, and a GRANT racing a TRUNCATE on the same table fails one of them, so the file runs
// against copies of the tables in schema trb12_copy (search_path, and `ON SCHEMA public` read as that schema).
// Creates that schema and the cluster role trade_request_ops_portal_copy, and drops both afterwards. Skips without
// DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = 'integration-only-copy';
const SCHEMA = 'trb12_copy';
const SQL_FILE = fileURLToPath(new URL('../../../sql/create-ops-portal-copy-role.sql', import.meta.url));
const CATALOG = [
  'users',
  'clients',
  'accounts',
  'trade_requests',
  'audit_logs',
  'notifications',
  'client_exclusions',
  'account_exclusions',
  'digest_runs',
  'registry_drift_runs',
  'position_drift_accounts',
  'drift_alert_sends',
  'drift_status_overrides',
  'security_sector',
];
const NOT_COPIED = ['session', 'oauth_access_tokens', 'oauth_refresh_tokens', 'mcp_pats', 'pgmigrations'];

/** psql meta-commands removed, the password variable bound, and the schema redirected to the copies. */
function roleSql(): string {
  const body = readFileSync(SQL_FILE, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n')
    .replace(":'copy_password'", `'${PASSWORD}'`)
    .replaceAll('ON SCHEMA public', `ON SCHEMA ${SCHEMA}`);
  return `SET search_path = ${SCHEMA};\n${body}\nRESET search_path;`;
}

function asCopyRole(): pg.Client {
  const url = new URL(DATABASE_URL!);
  url.username = 'trade_request_ops_portal_copy';
  url.password = PASSWORD;
  return new pg.Client({ connectionString: url.toString(), options: `-c search_path=${SCHEMA}` });
}

async function codeOf(client: pg.Client, sql: string): Promise<string> {
  try {
    await client.query(sql);
    return 'ok';
  } catch (err) {
    return String((err as { code?: string }).code);
  }
}

describe.skipIf(!DATABASE_URL)('create-ops-portal-copy-role.sql (Postgres integration)', () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    for (const t of [...CATALOG, ...NOT_COPIED]) {
      await admin.query(`CREATE TABLE ${SCHEMA}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    }
    await admin.query(roleSql());
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trade_request_ops_portal_copy') THEN
        DROP OWNED BY trade_request_ops_portal_copy; DROP ROLE trade_request_ops_portal_copy;
      END IF;
    END $$`);
    await admin.end();
  });

  it('grants exactly the 14 record tables, without delete on users', async () => {
    const { rows } = await admin.query<{ table_schema: string; table_name: string; privileges: string }>(
      `SELECT table_schema, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
        WHERE grantee = 'trade_request_ops_portal_copy'
        GROUP BY table_schema, table_name ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([...CATALOG].sort());
    for (const r of rows) {
      expect(r.table_schema).toBe(SCHEMA);
      expect(r.privileges).toBe(r.table_name === 'users' ? 'INSERT,SELECT,UPDATE' : 'DELETE,INSERT,SELECT,UPDATE');
    }
  });

  it('can read every record table and write one inside a rolled-back transaction', async () => {
    const copy = asCopyRole();
    await copy.connect();
    try {
      for (const t of CATALOG) expect(await codeOf(copy, `SELECT count(*) FROM ${t}`)).toBe('ok');
      await copy.query('BEGIN');
      expect(await codeOf(copy, `INSERT INTO security_sector (ticker, source) VALUES ('ZZTEST', 'manual')`)).toBe('ok');
      expect(await codeOf(copy, `DELETE FROM security_sector WHERE ticker = 'ZZTEST'`)).toBe('ok');
      await copy.query('ROLLBACK');
    } finally {
      await copy.end();
    }
  });

  it('is refused everything else', async () => {
    const copy = asCopyRole();
    await copy.connect();
    try {
      for (const t of NOT_COPIED) expect(await codeOf(copy, `SELECT 1 FROM ${t} LIMIT 1`)).toBe('42501');
      expect(await codeOf(copy, 'DELETE FROM users')).toBe('42501');
      expect(await codeOf(copy, 'TRUNCATE trade_requests')).toBe('42501');
      expect(await codeOf(copy, 'CREATE TABLE copy_probe (id int)')).toBe('42501');
    } finally {
      await copy.end();
    }
  });

  it('re-runs cleanly and holds no elevated attributes', async () => {
    await admin.query(roleSql());
    const { rows } = await admin.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolconnlimit,
              pg_has_role('trade_request_ops_portal_copy', 'pg_read_all_data', 'MEMBER') AS reads_all
         FROM pg_roles WHERE rolname = 'trade_request_ops_portal_copy'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolconnlimit: 4,
      reads_all: false,
    });
  });
});
