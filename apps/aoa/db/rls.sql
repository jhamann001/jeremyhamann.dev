-- Always-On Advice — schema layout, grants, and Row-Level Security
--
-- DESIGN REFERENCE ONLY — do not run this by hand. The live implementation is
-- the hand-authored migration:
--   prisma/migrations/20260629221205_mirror_roles_grants_rls/migration.sql
-- This file is kept as an annotated explanation of the mirror/app/audit
-- separation, the append-only audit grant, and the book-of-business RLS
-- pattern (Okta group -> role -> visible rows).

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS mirror;

-- ---------------------------------------------------------------------------
-- Roles (DB roles, distinct from app/Okta roles)
--   app_rw      : the application's runtime role
--   ingest_rw   : n8n ingestion's role (mirror only)
-- ---------------------------------------------------------------------------
-- CREATE ROLE app_rw LOGIN;
-- CREATE ROLE ingest_rw LOGIN;

-- App can read/write app + read/insert audit + read mirror. Never write mirror.
-- GRANT USAGE ON SCHEMA app, audit, mirror TO app_rw;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
-- GRANT SELECT, INSERT             ON ALL TABLES IN SCHEMA audit TO app_rw;  -- append-only
-- GRANT SELECT                     ON ALL TABLES IN SCHEMA mirror TO app_rw; -- read-only

-- Ingestion writes mirror only.
-- GRANT USAGE ON SCHEMA mirror TO ingest_rw;
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mirror TO ingest_rw;  -- upsert; no delete

-- ---------------------------------------------------------------------------
-- Per-request identity
-- The app sets these GUCs at the start of each request/transaction from the
-- authenticated Okta session:
--   SET LOCAL app.user_role = 'ADVISOR';
--   SET LOCAL app.user_email = 'rachel@example.com';
-- RLS policies read them via current_setting(...).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Example RLS: a mirror household table scoped by advisor (book of business)
-- ---------------------------------------------------------------------------
-- ALTER TABLE mirror.household ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE mirror.household FORCE ROW LEVEL SECURITY;
--
-- -- Operations / Admin see everything.
-- CREATE POLICY household_ops_all ON mirror.household
--   FOR SELECT USING (current_setting('app.user_role', true) IN ('ADMIN','OPERATIONS'));
--
-- -- Advisors / client service see only their own book.
-- CREATE POLICY household_own_book ON mirror.household
--   FOR SELECT USING (
--     current_setting('app.user_role', true) IN ('ADVISOR','CLIENT_SERVICE')
--     AND lead_advisor_email = current_setting('app.user_email', true)
--   );

-- ---------------------------------------------------------------------------
-- Audit append-only is enforced by the grant above (INSERT+SELECT, no
-- UPDATE/DELETE). Do not add UPDATE/DELETE policies to audit.*.
-- ---------------------------------------------------------------------------
