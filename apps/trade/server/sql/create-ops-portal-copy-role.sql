-- =============================================================================
-- create-ops-portal-copy-role.sql — the login OPS_PORTAL's copy engine uses on this database (ticket)
-- Target: Cloud SQL instance `trade-request-db` (production) or `trade-request-dev-db` (dev), database
-- `trade_request`. Run by scripts/setup-ops-portal-copy-login.sh; never by the application or CI deploys.
-- =============================================================================
--
-- WHAT IT CAN DO
-- --------------
-- OPS_PORTAL's copy engine (Ops Portal lib/trade-requests/records/copy-engine.ts, ticket) reads the 14 Trade
-- Request record tables for full, change and report-only copies and for the drift readiness comparison, and
-- writes them during a rollback's copy-back. This role holds exactly that: SELECT, INSERT, UPDATE and DELETE on
-- 13 tables, and SELECT, INSERT and UPDATE on users (copy-back never deletes a user: the standalone sign-in,
-- session and MCP token tables reference them).
--
-- WHAT IT CANNOT DO
-- -----------------
-- No access to session, oauth_*, mcp_* or pgmigrations, or to any table a later migration adds; no TRUNCATE,
-- REFERENCES or TRIGGER; no DDL; no default privileges. It is created here with CREATE ROLE, not with
-- `gcloud sql users create`, so it is not a member of cloudsqlsuperuser.
--
-- PASSWORD
-- --------
-- Read at run time from OPS_PORTAL_COPY_DB_PASSWORD in the environment of the shell running psql; never written here.
-- Re-running re-sets the password to the current value (rotation) and re-applies the grants (idempotent).
-- =============================================================================

\set ON_ERROR_STOP on
\set copy_password `printf '%s' "$OPS_PORTAL_COPY_DB_PASSWORD"`

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trade_request_ops_portal_copy') THEN
    CREATE ROLE trade_request_ops_portal_copy LOGIN;
  END IF;
END
$$;

ALTER ROLE trade_request_ops_portal_copy
  WITH LOGIN
       NOCREATEDB
       NOCREATEROLE
       NOINHERIT
       PASSWORD :'copy_password';

-- The copy job opens at most two connections per side; the runtime role keeps its 80.
ALTER ROLE trade_request_ops_portal_copy CONNECTION LIMIT 4;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO trade_request_ops_portal_copy', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO trade_request_ops_portal_copy;
REVOKE CREATE ON SCHEMA public FROM trade_request_ops_portal_copy;

GRANT SELECT, INSERT, UPDATE ON TABLE users TO trade_request_ops_portal_copy;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    clients, accounts, trade_requests, audit_logs, notifications, client_exclusions, account_exclusions,
    digest_runs, registry_drift_runs, position_drift_accounts, drift_alert_sends, drift_status_overrides,
    security_sector
  TO trade_request_ops_portal_copy;

\echo 'Granted privileges per table (expect 14 rows):'
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
  FROM information_schema.role_table_grants
 WHERE grantee = 'trade_request_ops_portal_copy' AND table_schema = 'public'
 GROUP BY table_name
 ORDER BY table_name;
