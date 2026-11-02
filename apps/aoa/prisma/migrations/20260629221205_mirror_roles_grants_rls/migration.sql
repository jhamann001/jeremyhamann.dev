-- Always-On Advice — data-class separation, least-privilege roles, and RLS.
--
-- This migration is hand-authored (Prisma scaffolded the empty folder). It sets
-- up the parts Prisma does not model:
--   * the `mirror` schema (ingested CRM/custodian data; written ONLY by n8n)
--   * two DB roles: app_rw (app runtime, least privilege) and ingest_rw (n8n)
--   * grants implementing read-write(app) / append-only(audit) / read-only(mirror)
--   * Row-Level Security: book-of-business scoping by Okta-role → visible rows
--
-- NOTE (Phase 1 / cloud): on Cloud SQL the two roles will likely be provisioned
-- via Terraform + IAM database auth rather than created here. The CREATE ROLE
-- blocks below are idempotent so they are safe in local/dev regardless.

-- ---------------------------------------------------------------------------
-- mirror schema (Prisma does not manage this; n8n owns the data)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS mirror;

-- ---------------------------------------------------------------------------
-- DB roles (distinct from app/Okta roles). LOGIN: local uses trust auth.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ingest_rw') THEN
    CREATE ROLE ingest_rw LOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- mirror tables (first pass — see docs/salesforce-mirror-mapping.md).
-- Denormalized lead_advisor_email is the RLS key (ingestion stamps it).
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.advisor (
  sf_id      text PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL,
  title      text,
  active     boolean NOT NULL DEFAULT true,
  synced_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mirror.household (
  sf_id              text PRIMARY KEY,
  name               text NOT NULL,
  status             text,
  lead_advisor_email text NOT NULL,
  aum                numeric(14,2),
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX household_lead_advisor_idx ON mirror.household (lead_advisor_email);

CREATE TABLE mirror.client (
  sf_id              text PRIMARY KEY,
  household_id       text NOT NULL REFERENCES mirror.household (sf_id) ON DELETE CASCADE,
  first_name         text,
  last_name          text,
  email              text,
  lead_advisor_email text NOT NULL,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_household_idx ON mirror.client (household_id);
CREATE INDEX client_lead_advisor_idx ON mirror.client (lead_advisor_email);

-- ---------------------------------------------------------------------------
-- Grants
--   app_rw    : read-write app, append-only audit, read-only mirror
--   ingest_rw : write mirror only (upsert; no delete)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app, audit, mirror TO app_rw;
GRANT USAGE ON SCHEMA mirror TO ingest_rw;

-- app schema: full DML + sequences (Auth.js adapter writes here).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- audit schema: append-only (INSERT + SELECT, never UPDATE/DELETE).
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- mirror schema: app reads only; ingest writes (no delete).
GRANT SELECT ON ALL TABLES IN SCHEMA mirror TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror GRANT SELECT ON TABLES TO app_rw;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mirror TO ingest_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;

-- ---------------------------------------------------------------------------
-- Row-Level Security — book-of-business scoping.
-- Per request the app sets GUCs from the authenticated session:
--   SELECT set_config('app.user_role',  'ADVISOR', true);
--   SELECT set_config('app.user_email', 'rachel@example.com', true);
-- Missing GUC -> current_setting(..., true) returns NULL -> policies fail closed.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.household ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.household FORCE ROW LEVEL SECURITY;
ALTER TABLE mirror.client ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.client FORCE ROW LEVEL SECURITY;

-- Ingestion bypasses scoping (it must write the whole firm's data).
CREATE POLICY household_ingest_all ON mirror.household FOR ALL TO ingest_rw USING (true) WITH CHECK (true);
CREATE POLICY client_ingest_all    ON mirror.client    FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Operations / Admin / Head of Advisory see the whole firm.
CREATE POLICY household_ops_all ON mirror.household FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
);
CREATE POLICY client_ops_all ON mirror.client FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
);

-- Advisors / Client Service see only their own book.
CREATE POLICY household_own_book ON mirror.household FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
  AND lead_advisor_email = current_setting('app.user_email', true)
);
CREATE POLICY client_own_book ON mirror.client FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
  AND lead_advisor_email = current_setting('app.user_email', true)
);
