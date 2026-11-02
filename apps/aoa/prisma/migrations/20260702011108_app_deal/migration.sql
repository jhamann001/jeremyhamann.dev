-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('POTENTIAL', 'COMMITTED', 'FUNDING', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "DealSource" AS ENUM ('APP', 'IMPORT');

-- CreateTable
CREATE TABLE "deal" (
    "id" TEXT NOT NULL,
    "source" "DealSource" NOT NULL,
    "sf_deal_id" TEXT,
    "name" TEXT NOT NULL,
    "client_first_name" TEXT NOT NULL,
    "client_last_name" TEXT NOT NULL,
    "household_name" TEXT,
    "household_sf_id" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "stage" "DealStage" NOT NULL,
    "stage_raw" TEXT,
    "created_date" DATE NOT NULL,
    "close_date" DATE,
    "last_activity_date" DATE,
    "owner_name" TEXT,
    "owner_sf_user_id" TEXT,
    "secondary_owner" TEXT,
    "person_aum" DECIMAL(14,2),
    "potential_aum" DECIMAL(14,2),
    "cedar_ridge_user_id" TEXT,
    "statements" BOOLEAN NOT NULL DEFAULT true,
    "plaid_linked" BOOLEAN NOT NULL DEFAULT false,
    "account_last4" TEXT,
    "account_type" TEXT,
    "transferring_firm" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deal_sf_deal_id_key" ON "deal"("sf_deal_id");

-- CreateIndex
CREATE INDEX "deal_stage_idx" ON "deal"("stage");

-- CreateIndex
CREATE INDEX "deal_household_sf_id_idx" ON "deal"("household_sf_id");

-- ---------------------------------------------------------------------------
-- Hand-authored below (the mirror_roles_grants_rls idiom): grants + RLS for
-- app.deal — the FIRST RLS on an app-schema table (TDD ticket, ADR-4).
-- Locked posture (the owner, 2026-07-01): ALL app roles read ALL deals; writes are
-- role-gated (VIEWER excluded) with WITH CHECK; NO DELETE for anyone (restage
-- to LOST instead); missing GUCs fail closed. The future per-advisor
-- book-scoping tightening is documented in ADR-4, deliberately NOT built.
-- ---------------------------------------------------------------------------

-- Grants: the roles migration's DEFAULT PRIVILEGES already hand app_rw full DML
-- on new app tables; deals must be hard-undeletable for the app runtime, so
-- revoke DELETE (permission denied — stronger than a merely absent policy).
GRANT SELECT, INSERT, UPDATE ON "app"."deal" TO app_rw;
REVOKE DELETE ON "app"."deal" FROM app_rw;

ALTER TABLE "app"."deal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."deal" FORCE ROW LEVEL SECURITY;

-- Read: any valid app role (VIEWER included) sees the whole pipeline.
-- current_setting(..., true) is NULL when the GUC is unset -> IN () is not
-- true -> fails closed (no rows outside withUserScope).
CREATE POLICY deal_read_all_roles ON "app"."deal"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

-- Writes: the write roles only — VIEWER cannot INSERT/UPDATE even if the UI
-- misbehaves (the DB policies police the D3 server actions).
CREATE POLICY deal_insert_write_roles ON "app"."deal"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY deal_update_write_roles ON "app"."deal"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

-- NO DELETE policy for anyone: deals are never deleted in this phase.

-- Owner-role bypass (the exact analogue of household_ingest_all): FORCE RLS
-- binds table owners too, so the seed and the D4 import — both run via
-- DIRECT_DATABASE_URL as the owner — need an unconditional policy. Local owner
-- is `aoa`; prod owner is `aoa_admin` (Terraform google_sql_user +
-- scripts/migrate-prod.sh). pg_roles-guarded like the CREATE ROLE blocks so the
-- migration applies in either environment (and the shadow DB).
DO $$
DECLARE
  owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO owner_roles
    FROM pg_roles
   WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    EXECUTE format(
      'CREATE POLICY deal_owner_all ON "app"."deal" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;
