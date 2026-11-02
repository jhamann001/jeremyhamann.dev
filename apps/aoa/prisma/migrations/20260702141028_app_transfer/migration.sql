-- CreateEnum
CREATE TYPE "TransferStage" AS ENUM ('DISCOVERY', 'DECISION', 'ACCOUNTS_OPEN', 'IN_TRANSFER', 'FUNDED');

-- CreateEnum
CREATE TYPE "TransferSource" AS ENUM ('APP', 'IMPORT');

-- CreateEnum
CREATE TYPE "TransferOwner" AS ENUM ('OPERATIONS', 'CLIENT_SERVICE', 'ADVISOR');

-- CreateEnum
CREATE TYPE "TransferDecisionChoice" AS ENUM ('BRING_IN', 'LEAVE_GIFT', 'UNDECIDED');

-- CreateEnum
CREATE TYPE "TransferAccountStatus" AS ENUM ('TO_OPEN', 'OPEN');

-- CreateTable
CREATE TABLE "transfer" (
    "id" TEXT NOT NULL,
    "source" "TransferSource" NOT NULL,
    "client_first_name" TEXT NOT NULL,
    "client_last_name" TEXT NOT NULL,
    "client_sf_id" TEXT,
    "household_name" TEXT,
    "household_sf_id" TEXT,
    "value" DECIMAL(14,2) NOT NULL,
    "stage" "TransferStage" NOT NULL DEFAULT 'DISCOVERY',
    "stage_entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "owner_kind" "TransferOwner" NOT NULL DEFAULT 'OPERATIONS',
    "owner_name" TEXT,
    "next_step" TEXT,
    "next_step_owner" TEXT,
    "pending_nudge" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_task" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transfer_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_decision" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "cost_basis" DECIMAL(14,2),
    "decision" "TransferDecisionChoice" NOT NULL DEFAULT 'UNDECIDED',
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transfer_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_account" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "TransferAccountStatus" NOT NULL DEFAULT 'TO_OPEN',
    "opened_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transfer_account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_stage_idx" ON "transfer"("stage");

-- CreateIndex
CREATE INDEX "transfer_household_sf_id_idx" ON "transfer"("household_sf_id");

-- CreateIndex
CREATE INDEX "transfer_client_sf_id_idx" ON "transfer"("client_sf_id");

-- CreateIndex
CREATE INDEX "transfer_task_transfer_id_idx" ON "transfer_task"("transfer_id");

-- CreateIndex
CREATE INDEX "transfer_decision_transfer_id_idx" ON "transfer_decision"("transfer_id");

-- CreateIndex
CREATE INDEX "transfer_account_transfer_id_idx" ON "transfer_account"("transfer_id");

-- AddForeignKey
ALTER TABLE "transfer_task" ADD CONSTRAINT "transfer_task_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_decision" ADD CONSTRAINT "transfer_decision_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_account" ADD CONSTRAINT "transfer_account_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-authored below (the mirror_roles_grants_rls / app_deal idiom): grants +
-- RLS for the app.transfer domain — ALL FOUR tables (TDD ticket, ADR-4).
-- Locked posture (the owner, 2026-07-02, matching deals): ALL app roles read ALL
-- transfers + children; writes are role-gated (VIEWER excluded) with
-- WITH CHECK; NO DELETE for anyone (tasks are unchecked, transfers restaged —
-- never removed); missing GUCs fail closed. Children carry the SAME role
-- predicates (not row-parented policies — the read posture is all-rows anyway,
-- and write role-gating is the control that matters).
-- ---------------------------------------------------------------------------

-- Grants: the roles migration's DEFAULT PRIVILEGES already hand app_rw full DML
-- on new app tables; the transfer domain must be hard-undeletable for the app
-- runtime, so revoke DELETE (permission denied — stronger than a merely absent
-- policy).
GRANT SELECT, INSERT, UPDATE ON "app"."transfer" TO app_rw;
REVOKE DELETE ON "app"."transfer" FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."transfer_task" TO app_rw;
REVOKE DELETE ON "app"."transfer_task" FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."transfer_decision" TO app_rw;
REVOKE DELETE ON "app"."transfer_decision" FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."transfer_account" TO app_rw;
REVOKE DELETE ON "app"."transfer_account" FROM app_rw;

ALTER TABLE "app"."transfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_task" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_decision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_decision" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_account" FORCE ROW LEVEL SECURITY;

-- Read: any valid app role (VIEWER included) sees every transfer + children.
-- current_setting(..., true) is NULL when the GUC is unset -> IN () is not
-- true -> fails closed (no rows outside withUserScope).
CREATE POLICY transfer_read_all_roles ON "app"."transfer"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_task_read_all_roles ON "app"."transfer_task"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_decision_read_all_roles ON "app"."transfer_decision"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_account_read_all_roles ON "app"."transfer_account"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

-- Writes: the write roles only — VIEWER cannot INSERT/UPDATE even if the UI
-- misbehaves (the DB policies police the T3 server actions).
CREATE POLICY transfer_insert_write_roles ON "app"."transfer"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_update_write_roles ON "app"."transfer"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_task_insert_write_roles ON "app"."transfer_task"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_task_update_write_roles ON "app"."transfer_task"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_decision_insert_write_roles ON "app"."transfer_decision"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_decision_update_write_roles ON "app"."transfer_decision"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_account_insert_write_roles ON "app"."transfer_account"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_account_update_write_roles ON "app"."transfer_account"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

-- NO DELETE policy for anyone: transfers, tasks, decisions and accounts are
-- never deleted in this phase (restage / uncheck instead).

-- Owner-role bypass (the exact analogue of deal_owner_all): FORCE RLS binds
-- table owners too, so the seed — run via DIRECT_DATABASE_URL as the owner —
-- needs an unconditional policy on each table. Local owner is `aoa`; prod
-- owner is `aoa_admin` (Terraform google_sql_user + scripts/migrate-prod.sh).
-- pg_roles-guarded like the CREATE ROLE blocks so the migration applies in
-- either environment (and the shadow DB).
DO $$
DECLARE
  owner_roles text;
  tbl text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO owner_roles
    FROM pg_roles
   WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    FOREACH tbl IN ARRAY ARRAY['transfer', 'transfer_task', 'transfer_decision', 'transfer_account']
    LOOP
      EXECUTE format(
        'CREATE POLICY %I ON "app".%I FOR ALL TO %s USING (true) WITH CHECK (true)',
        tbl || '_owner_all',
        tbl,
        owner_roles
      );
    END LOOP;
  END IF;
END $$;
