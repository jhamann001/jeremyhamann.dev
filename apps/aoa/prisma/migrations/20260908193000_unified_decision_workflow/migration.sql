-- Unified decision workflow: one durable queue for general decisions and
-- workstream-linked exceptions. Draft interaction is intentionally not stored;
-- case creation, final resolution, and task changes are the auditable actions.

CREATE TYPE "app"."DecisionCaseSource" AS ENUM ('MANUAL', 'ASSET_TRANSFER');
CREATE TYPE "app"."DecisionCaseStatus" AS ENUM ('OPEN', 'SNOOZED', 'RESOLVED');
CREATE TYPE "app"."DecisionOwnerTeam" AS ENUM ('OPERATIONS', 'CLIENT_SERVICE', 'ADVISORY', 'TRADE_DESK');
CREATE TYPE "app"."DecisionTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');
CREATE TYPE "app"."DecisionTaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

CREATE TABLE "app"."decision_case" (
  "id" text NOT NULL,
  "source" "app"."DecisionCaseSource" NOT NULL,
  "source_key" VARCHAR(191) NOT NULL,
  "source_label" VARCHAR(180),
  "source_version" integer NOT NULL DEFAULT 1,
  "source_fingerprint" CHAR(64),
  "source_snapshot" jsonb NOT NULL DEFAULT '{}',
  "transfer_id" text,
  "client_name" VARCHAR(180),
  "household_name" VARCHAR(180),
  "household_sf_id" VARCHAR(64),
  "category" VARCHAR(64) NOT NULL DEFAULT 'Unclassified',
  "question" VARCHAR(500) NOT NULL,
  "context" VARCHAR(1000) NOT NULL DEFAULT '',
  "owner_team" "app"."DecisionOwnerTeam" NOT NULL,
  "status" "app"."DecisionCaseStatus" NOT NULL DEFAULT 'OPEN',
  "blocks_transfer" boolean NOT NULL DEFAULT false,
  "resolution_code" VARCHAR(64),
  "resolution_summary" VARCHAR(1000),
  "version" integer NOT NULL DEFAULT 0,
  "resolved_by" VARCHAR(320),
  "resolved_at" timestamptz(6),
  "created_by" VARCHAR(320),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_case_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_case_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "decision_case_source_version_check" CHECK ("source_version" >= 1),
  CONSTRAINT "decision_case_version_check" CHECK ("version" >= 0),
  CONSTRAINT "decision_case_question_check" CHECK (length(btrim("question")) BETWEEN 1 AND 500),
  CONSTRAINT "decision_case_context_check" CHECK (length("context") <= 1000),
  CONSTRAINT "decision_case_transfer_source_check" CHECK (
    ("source" = 'ASSET_TRANSFER' AND "transfer_id" IS NOT NULL)
    OR ("source" = 'MANUAL')
  ),
  CONSTRAINT "decision_case_resolution_check" CHECK (
    (
      "status" = 'RESOLVED'
      AND "resolution_code" IS NOT NULL
      AND length(btrim("resolution_summary")) BETWEEN 1 AND 1000
      AND "resolved_by" IS NOT NULL
      AND "resolved_at" IS NOT NULL
      AND "version" > 0
    ) OR (
      "status" <> 'RESOLVED'
      AND "resolution_code" IS NULL
      AND "resolution_summary" IS NULL
      AND "resolved_by" IS NULL
      AND "resolved_at" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "decision_case_source_key_key" ON "app"."decision_case"("source_key");
CREATE INDEX "decision_case_status_created_at_idx" ON "app"."decision_case"("status", "created_at" DESC);
CREATE INDEX "decision_case_owner_team_status_idx" ON "app"."decision_case"("owner_team", "status");
CREATE INDEX "decision_case_transfer_id_status_idx" ON "app"."decision_case"("transfer_id", "status");

CREATE TABLE "app"."decision_task" (
  "id" text NOT NULL,
  "decision_id" text NOT NULL,
  "transfer_id" text,
  "parent_task_id" text,
  "task_key" VARCHAR(96) NOT NULL,
  "title" VARCHAR(220) NOT NULL,
  "owner_team" "app"."DecisionOwnerTeam" NOT NULL,
  "status" "app"."DecisionTaskStatus" NOT NULL DEFAULT 'TODO',
  "priority" "app"."DecisionTaskPriority" NOT NULL DEFAULT 'NORMAL',
  "sort_order" integer NOT NULL DEFAULT 0,
  "completed_by" VARCHAR(320),
  "completed_at" timestamptz(6),
  "created_by" VARCHAR(320),
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_task_decision_id_fkey"
    FOREIGN KEY ("decision_id") REFERENCES "app"."decision_case"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "decision_task_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "decision_task_parent_task_id_fkey"
    FOREIGN KEY ("parent_task_id") REFERENCES "app"."decision_task"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "decision_task_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 220),
  CONSTRAINT "decision_task_completion_check" CHECK (
    ("status" = 'DONE' AND "completed_at" IS NOT NULL)
    OR ("status" <> 'DONE' AND "completed_at" IS NULL AND "completed_by" IS NULL)
  )
);

CREATE UNIQUE INDEX "decision_task_decision_id_task_key_key" ON "app"."decision_task"("decision_id", "task_key");
CREATE INDEX "decision_task_transfer_id_status_idx" ON "app"."decision_task"("transfer_id", "status");
CREATE INDEX "decision_task_owner_team_status_idx" ON "app"."decision_task"("owner_team", "status");
CREATE INDEX "decision_task_parent_task_id_idx" ON "app"."decision_task"("parent_task_id");

CREATE TABLE "app"."decision_case_event" (
  "id" bigserial NOT NULL,
  "decision_id" text NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "actor_email" VARCHAR(320),
  "actor_role" VARCHAR(32),
  "from_status" "app"."DecisionCaseStatus",
  "to_status" "app"."DecisionCaseStatus",
  "note_present" boolean NOT NULL DEFAULT false,
  "detail" jsonb NOT NULL DEFAULT '{}',
  "at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_case_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_case_event_decision_id_fkey"
    FOREIGN KEY ("decision_id") REFERENCES "app"."decision_case"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "decision_case_event_action_check" CHECK (
    "action" IN ('CREATED', 'SOURCE_REFRESHED', 'REOPENED', 'RESOLVED', 'TASK_UPDATED')
  )
);

CREATE INDEX "decision_case_event_decision_id_at_idx" ON "app"."decision_case_event"("decision_id", "at" DESC);
CREATE INDEX "decision_case_event_at_idx" ON "app"."decision_case_event"("at" DESC);

GRANT SELECT, INSERT, UPDATE ON "app"."decision_case", "app"."decision_task" TO app_rw;
GRANT SELECT, INSERT ON "app"."decision_case_event" TO app_rw;
REVOKE DELETE ON "app"."decision_case", "app"."decision_task", "app"."decision_case_event" FROM app_rw;
REVOKE UPDATE ON "app"."decision_case_event" FROM app_rw;

ALTER TABLE "app"."decision_case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_case" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_task" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_case_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_case_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY decision_case_read_all_roles ON "app"."decision_case"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER'));
CREATE POLICY decision_case_insert_write_roles ON "app"."decision_case"
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE'));
CREATE POLICY decision_case_update_write_roles ON "app"."decision_case"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE'));

CREATE POLICY decision_task_read_all_roles ON "app"."decision_task"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER'));
CREATE POLICY decision_task_insert_write_roles ON "app"."decision_task"
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE'));
CREATE POLICY decision_task_update_write_roles ON "app"."decision_task"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE'));

CREATE POLICY decision_case_event_read_all_roles ON "app"."decision_case_event"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER'));
CREATE POLICY decision_case_event_insert_write_roles ON "app"."decision_case_event"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE')
    AND "actor_role" = current_setting('app.user_role', true)
    AND "actor_email" = NULLIF(current_setting('app.user_email', true), '')
  );

-- Narrative case/task rows are intentionally excluded from the generic
-- audit.log_row_change trigger. Server actions write redacted audit.AuditLog
-- events in the same transaction; decision_case_event retains the detailed,
-- RLS-protected workflow trail.
