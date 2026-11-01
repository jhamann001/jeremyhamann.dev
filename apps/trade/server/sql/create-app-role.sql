-- =============================================================================
-- create-app-role.sql — least-privilege runtime role for the trade-request app
-- security scanner: wc-id-1194 (publicly-exposed service whose identity reaches sensitive data)
-- Target: Cloud SQL instance `trade-request-db` (POSTGRES_15), database `trade_request`
-- =============================================================================
--
-- WHY
-- ---
-- The Cloud Run service `trade-request` is intentionally public: ingress `all`
-- plus `roles/run.invoker` on `allUsers`, because staff reach it in a browser
-- and there is no LB/IAP in front to attach an OIDC token. We are NOT closing
-- the front door. We are shrinking what the identity behind it can do.
--
-- Today the app connects as `postgres`, which on Cloud SQL is a member of
-- `cloudsqlsuperuser` — it can DROP every table, TRUNCATE the audit trail,
-- create roles, and read every other database on the instance. Any RCE or SQLi
-- in a publicly reachable Express route inherits all of that. After this change
-- the app holds DML on 21 named tables and nothing else.
--
-- `postgres` is currently the ONLY user on the instance, so there is no
-- existing least-privilege role to switch to — this script creates one.
--
-- DDL IS NOT AFFECTED
-- -------------------
-- The application performs NO DDL at runtime. Verified:
--   * Dockerfile CMD is `server/dist/index.js` — no migrate wrapper, no entrypoint script.
--   * `server/src/index.ts` startup does `pool.query('SELECT 1')` only (index.ts:120).
--   * connect-pg-simple is constructed WITHOUT `createTableIfMissing`
--     (server/src/middleware/auth.ts:168), so it never CREATEs the session table.
--   * No CREATE/ALTER/DROP/TRUNCATE statement exists anywhere in server/src
--     outside of __tests__ (which run against a local test DB, not prod).
-- Migrations run ONLY in CI, from the "Run database migrations" step of
-- .github/workflows/deploy-prod.yml, through the Cloud SQL Auth Proxy, under a
-- pg advisory lock. That step keeps using `postgres` (see MIGRATION_DB_USER in
-- the workflow). A pure-DML role is therefore viable.
--
-- PASSWORD
-- --------
-- No password is written in this file. It is read at run time from the
-- APP_DB_PASSWORD environment variable of the shell running psql. Generate it,
-- put it in Secret Manager, and export it — see the runbook in the PR body.
--
-- IDEMPOTENCY
-- -----------
-- Safe to re-run. CREATE ROLE is guarded by a pg_roles existence check; GRANT
-- and ALTER DEFAULT PRIVILEGES are naturally idempotent in Postgres. Re-running
-- also re-sets the password to whatever APP_DB_PASSWORD currently holds, which
-- is how you rotate it.
--
-- HOW TO RUN
-- ----------
--   # 1. The secret. These projects enforce constraints/gcp.resourceLocations,
--   #    which REJECTS the default (global) replication with FAILED_PRECONDITION.
--   #    Every other secret in this project is user-managed in us-central1.
--   printf '%s' "$APP_DB_PASSWORD" | gcloud secrets create db-app-password \
--     --project=example-project \
--     --replication-policy=user-managed --locations=us-central1 --data-file=-
--
--   # 2. The proxy. Use a NON-default port: a local Postgres on 5432 will win
--   #    the bind race and psql will silently run this file against your laptop
--   #    instead of production. Ask the server who it is before trusting it.
--   cloud-sql-proxy --port 5433 example-project:us-central1:trade-request-db &
--   psql "host=127.0.0.1 port=5433 dbname=trade_request user=postgres" \
--     -tAc "SELECT version();"          # must say PostgreSQL 17.x, not Homebrew
--
--   # 3. Run it.
--   export APP_DB_PASSWORD='...'
--   psql "host=127.0.0.1 port=5433 dbname=trade_request user=postgres" \
--     -v ON_ERROR_STOP=1 -f server/sql/create-app-role.sql
-- =============================================================================

\set ON_ERROR_STOP on

-- Pull the password out of the environment so it never lands in this file,
-- in shell history via -c, or in the psql log as a literal.
\set app_password `printf '%s' "$APP_DB_PASSWORD"`

\echo 'Creating/updating role trade_request_app ...'

-- -----------------------------------------------------------------------------
-- 1. The role
-- -----------------------------------------------------------------------------
-- Every attribute is explicitly negative. NOINHERIT means that even if someone
-- later makes this role a member of a privileged group, it does not silently
-- pick up that group's rights without an explicit SET ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trade_request_app') THEN
    CREATE ROLE trade_request_app LOGIN;
  END IF;
END
$$;

-- NOSUPERUSER / NOREPLICATION / NOBYPASSRLS are deliberately NOT stated.
-- On Cloud SQL the `postgres` role is cloudsqlsuperuser, not a true superuser,
-- and may not set those three attributes even to negate them:
--     ERROR: permission denied to alter role
--     DETAIL: Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.
-- All three already default to OFF on a newly created role, so omitting them
-- weakens nothing. Verified on the live instance after running this file:
--     rolsuper=f  rolreplication=f  rolbypassrls=f
ALTER ROLE trade_request_app
  WITH LOGIN
       NOCREATEDB
       NOCREATEROLE
       NOINHERIT
       PASSWORD :'app_password';

-- Keep the app off the maintenance connection budget reserved for humans and
-- for the CI migration step. Cloud Run is max-instances 3 x DB_POOL_MAX 25 = 75.
ALTER ROLE trade_request_app CONNECTION LIMIT 80;

-- -----------------------------------------------------------------------------
-- 2. Database + schema access
-- -----------------------------------------------------------------------------
GRANT CONNECT ON DATABASE trade_request TO trade_request_app;
GRANT USAGE   ON SCHEMA public          TO trade_request_app;

-- Belt and braces. Postgres 15 already removed the implicit CREATE-on-public
-- grant to PUBLIC, so this is normally a no-op — but state it, so the intent
-- survives a future restore from a pre-15 dump.
REVOKE CREATE ON SCHEMA public FROM trade_request_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 3. Table privileges — derived per table from server/src
-- -----------------------------------------------------------------------------
-- Each grant below is the exact set of verbs the application issues against
-- that table. DELETE is deliberately withheld from users, trade_requests and
-- audit_logs: those are the tables an auditor cares about, and nothing in the
-- codebase ever deletes from them (user removal is `UPDATE users SET
-- is_active = false`, server/src/routes/users.ts:175).

-- users — SELECT/INSERT/UPDATE. `SELECT ... FOR UPDATE` at routes/users.ts:117
-- and :163 is why UPDATE is required beyond the plain UPDATE statements.
--   S: middleware/auth.ts, mcp/oauth/{provider,googleCallback}.ts, routes/{users,auth}.ts
--   I: routes/users.ts   U: middleware/auth.ts:102, routes/users.ts:127/:175
GRANT SELECT, INSERT, UPDATE ON TABLE users TO trade_request_app;

-- session — full DML. Owned entirely by connect-pg-simple
-- (middleware/auth.ts:168): SELECT on load, INSERT ... ON CONFLICT DO UPDATE on
-- save, UPDATE on touch, DELETE on logout, and DELETE on the 15-minute
-- `pruneSessionInterval` sweep. Drop DELETE here and sessions never expire.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE session TO trade_request_app;

-- clients / accounts — READ ONLY. Warehouse is the production source of truth
-- for both (see migration 20260323000000_warehouse-integration.sql). The only
-- INSERTs are in server/src/db/seed.sql, which is dev/test seeding and is never
-- executed against prod.
GRANT SELECT ON TABLE clients  TO trade_request_app;
GRANT SELECT ON TABLE accounts TO trade_request_app;

-- trade_requests — SELECT/INSERT/UPDATE, no DELETE. Requests are never removed;
-- they move through the status CHECK constraint.
--   I: routes/requests.ts   U: routes/requests.ts:1087/:1288/:1693, services/requestChecklist.ts:52
GRANT SELECT, INSERT, UPDATE ON TABLE trade_requests TO trade_request_app;

-- audit_logs — APPEND ONLY. INSERT at routes/requests.ts, SELECT at
-- services/requestQueries.ts. No UPDATE, no DELETE, by design.
GRANT SELECT, INSERT ON TABLE audit_logs TO trade_request_app;

-- notifications — SELECT/INSERT/UPDATE. UPDATE is the read_at marker
-- (routes/notifications.ts:78 and :103). Rows are never deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE notifications TO trade_request_app;

-- digest_runs — INSERT ... ON CONFLICT (run_date) DO NOTHING, the daily Slack
-- digest idempotency guard (services/digest.ts:386). SELECT granted so an
-- operator query through the app path works.
GRANT SELECT, INSERT ON TABLE digest_runs TO trade_request_app;

-- ---- MCP OAuth 2.1 storage (server/src/mcp/oauth/store.ts) ------------------

-- oauth_clients — Dynamic Client Registration INSERT + lookup SELECT. Client
-- records are never mutated or deleted by the app.
GRANT SELECT, INSERT ON TABLE oauth_clients TO trade_request_app;

-- mcp_pending_auth — INSERT on authorize, SELECT on callback, DELETE on consume
-- (store.ts:95). This is one of only five tables where the app deletes rows.
GRANT SELECT, INSERT, DELETE ON TABLE mcp_pending_auth TO trade_request_app;

-- oauth_authorization_codes — single-use codes; consumed by
-- `UPDATE ... SET consumed_at ... WHERE consumed_at IS NULL` (store.ts:189),
-- not by DELETE.
GRANT SELECT, INSERT, UPDATE ON TABLE oauth_authorization_codes TO trade_request_app;

-- oauth_access_tokens — UPDATE is revocation: store.ts:356/:525 and the
-- deactivate-user cascade at routes/users.ts:191.
GRANT SELECT, INSERT, UPDATE ON TABLE oauth_access_tokens TO trade_request_app;

-- oauth_refresh_tokens — UPDATE is rotation (store.ts:347) and family
-- revocation (store.ts:520, routes/users.ts:187).
GRANT SELECT, INSERT, UPDATE ON TABLE oauth_refresh_tokens TO trade_request_app;

-- mcp_pats — personal access tokens. UPDATE is last_used_at (store.ts:457) and
-- revoked_at (store.ts:492/:502, routes/users.ts:183).
GRANT SELECT, INSERT, UPDATE ON TABLE mcp_pats TO trade_request_app;

-- ---- Drift / registry ------------------------------------------------------

-- registry_drift_runs — v1 per-household drift. `INSERT ... ON CONFLICT
-- (run_date_local, household_name) DO UPDATE` (services/registryDriftRunner.ts:506)
-- needs BOTH insert and update: Postgres checks the UPDATE privilege for the
-- conflict arm even when it never fires.
GRANT SELECT, INSERT, UPDATE ON TABLE registry_drift_runs TO trade_request_app;

-- position_drift_accounts — v2 per-account drift. Same DO UPDATE upsert shape
-- (services/positionDriftAccountsPersistence.ts:123).
GRANT SELECT, INSERT, UPDATE ON TABLE position_drift_accounts TO trade_request_app;

-- client_exclusions / account_exclusions — full CRUD from routes/exclusions.ts.
-- DELETE is a real user action (remove a standing exclusion):
-- exclusions.ts:407 (account), :586 and :860 (client).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE client_exclusions  TO trade_request_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account_exclusions TO trade_request_app;

-- security_sector — ticker→sector cache. `ON CONFLICT (ticker) DO UPDATE`
-- (services/securitySector.ts:38) and DO NOTHING (:84).
GRANT SELECT, INSERT, UPDATE ON TABLE security_sector TO trade_request_app;

-- drift_alert_sends — the per-day "already posted to Slack" claim.
-- INSERT ... DO NOTHING (services/positionDriftAccountsAlert.ts:201) and a
-- DELETE that releases the claim when the Slack post itself fails (:242).
GRANT SELECT, INSERT, DELETE ON TABLE drift_alert_sends TO trade_request_app;

-- drift_status_overrides — trader overrides. Upsert with DO UPDATE
-- (services/driftStatusOverrides.ts:102), UPDATE of recheck_notified_at (:171),
-- DELETE to clear an override (:120).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE drift_status_overrides TO trade_request_app;

-- NOT GRANTED, deliberately: `pgmigrations`. That is node-pg-migrate's own
-- bookkeeping table. It is written only by the CI migration step running as
-- `postgres`. The application never reads or writes it, and it should stay that
-- way — an app that cannot see the migration ledger cannot rewrite it.

-- -----------------------------------------------------------------------------
-- 4. Sequences
-- -----------------------------------------------------------------------------
-- The schema currently contains ZERO sequences — every primary key is either a
-- natural key or a UUID from uuid_generate_v4(). Confirmed: no SERIAL,
-- BIGSERIAL, GENERATED AS IDENTITY or nextval() anywhere in server/migrations.
-- This grant is therefore a no-op today and exists so that the day someone adds
-- a SERIAL column, the app can already use it.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trade_request_app;

-- -----------------------------------------------------------------------------
-- 5. Function execution
-- -----------------------------------------------------------------------------
-- Column DEFAULTs are evaluated with the privileges of the INSERTing role, and
-- ten tables default their id to uuid_generate_v4(). Postgres grants EXECUTE on
-- functions to PUBLIC by default so this normally already holds — but if anyone
-- ever tightens that, every INSERT starts failing, so make it explicit.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'uuid_generate_v4' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.uuid_generate_v4() TO trade_request_app';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 6. Default privileges for FUTURE objects
-- -----------------------------------------------------------------------------
-- Migrations run as `postgres`, so tables created by future migrations are
-- owned by `postgres` and would otherwise be invisible to the app until someone
-- remembers to come back here. FOR ROLE postgres is load-bearing: default
-- privileges are recorded per creating role, and a clause without it would
-- attach to whoever happens to be running this script.
--
-- TRADE-OFF, stated plainly: this is the one place the script is broader than
-- the per-table matrix above — it hands future tables the full DML set,
-- including DELETE. That is deliberate. The alternative is that a migration
-- merges, the new table has no grants, and the first request that touches it
-- 500s in production. Tighten a specific new table here if it deserves the
-- append-only treatment audit_logs gets.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trade_request_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO trade_request_app;

-- -----------------------------------------------------------------------------
-- 7. Verification — read the result back, do not assume it
-- -----------------------------------------------------------------------------
\echo ''
\echo 'Role attributes (all of the can_* columns must read f):'
SELECT rolname,
       rolsuper     AS can_super,
       rolcreatedb  AS can_createdb,
       rolcreaterole AS can_createrole,
       rolbypassrls AS can_bypassrls,
       rolcanlogin,
       rolconnlimit
FROM pg_roles
WHERE rolname = 'trade_request_app';

\echo ''
\echo 'Granted privileges per table (expect 21 rows):'
SELECT table_name,
       string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE grantee = 'trade_request_app'
  AND table_schema = 'public'
GROUP BY table_name
ORDER BY table_name;

\echo ''
\echo 'Sanity check — this must return ZERO rows (no table the app can DDL):'
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'trade_request_app'
  AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER');

\echo ''
\echo 'Done. Before deploying, run the two verification steps from the PR runbook (step 6):'
\echo '  1. Confirm the new role can connect and SELECT — it must succeed.'
\echo '  2. Confirm the new role CANNOT create a table — it must fail with permission denied.'
\echo ''
\echo 'Connect through the Cloud SQL Auth Proxy on 127.0.0.1:5432, database trade_request,'
\echo 'as role trade_request_app, taking the password from the APP_DB_PASSWORD environment'
\echo 'variable. The exact commands are in the PR body so this file stays free of anything'
\echo 'shaped like a credential (security scanner SECRET-1585 matched the previous wording here).'
