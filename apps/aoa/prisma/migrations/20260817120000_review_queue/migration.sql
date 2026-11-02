-- Central Operations/Admin review queue. Authoritative Trade Request and CRM
-- records are not copied; AOA stores a hashed detector/subject key, a minimal
-- redacted snapshot, and the workflow/provenance it owns.

CREATE TYPE "app"."ReviewQueueSource" AS ENUM ('TRADE_REQUEST', 'CRM_IDENTITY');
CREATE TYPE "app"."ReviewQueueStatus" AS ENUM ('NEW', 'IN_REVIEW', 'RESOLVED', 'SNOOZED');

CREATE TABLE "app"."review_queue_item" (
  "id" TEXT NOT NULL,
  "detector_key" CHAR(64) NOT NULL,
  "subject_key" CHAR(64) NOT NULL,
  "source" "app"."ReviewQueueSource" NOT NULL,
  "exception_type" VARCHAR(64) NOT NULL,
  "source_record_ref" VARCHAR(128),
  "resolution_href" VARCHAR(512) NOT NULL,
  "summary" VARCHAR(180) NOT NULL,
  "source_snapshot" JSONB NOT NULL DEFAULT '{}',
  "source_active" BOOLEAN NOT NULL DEFAULT true,
  "status" "app"."ReviewQueueStatus" NOT NULL DEFAULT 'NEW',
  "assigned_to" VARCHAR(320),
  "resolution_note" VARCHAR(1000) NOT NULL DEFAULT '',
  "snoozed_until" TIMESTAMPTZ(6),
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "source_resolved_at" TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "resolved_by" VARCHAR(320),
  "updated_by" VARCHAR(320),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "review_queue_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_queue_detector_key_hex" CHECK ("detector_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "review_queue_subject_key_hex" CHECK ("subject_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "review_queue_href_local" CHECK (
    "resolution_href" ~ '^/[A-Za-z0-9][A-Za-z0-9/_?&=.%+#-]*$'
    AND "resolution_href" !~ '//'
    AND "resolution_href" !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT "review_queue_note_length" CHECK (char_length("resolution_note") <= 1000),
  CONSTRAINT "review_queue_status_dates" CHECK (
    ("status" = 'RESOLVED' AND "resolved_at" IS NOT NULL)
    OR ("status" <> 'RESOLVED')
  ),
  CONSTRAINT "review_queue_snooze_date" CHECK (
    ("status" = 'SNOOZED' AND "snoozed_until" IS NOT NULL)
    OR ("status" <> 'SNOOZED')
  )
);

CREATE TABLE "app"."review_queue_event" (
  "id" BIGSERIAL NOT NULL,
  "item_id" TEXT NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "actor_email" VARCHAR(320),
  "actor_role" VARCHAR(32),
  "from_status" "app"."ReviewQueueStatus",
  "to_status" "app"."ReviewQueueStatus",
  "note_present" BOOLEAN NOT NULL DEFAULT false,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "review_queue_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_queue_event_item_id_fkey" FOREIGN KEY ("item_id")
    REFERENCES "app"."review_queue_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "app"."review_queue_sweep_state" (
  "id" VARCHAR(32) NOT NULL,
  "trade_cursor" VARCHAR(128),
  "crm_cursor" VARCHAR(128),
  "trade_complete" BOOLEAN NOT NULL DEFAULT false,
  "crm_complete" BOOLEAN NOT NULL DEFAULT false,
  "lease_token" CHAR(36),
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_started_at" TIMESTAMPTZ(6),
  "last_completed_at" TIMESTAMPTZ(6),
  "last_failure_at" TIMESTAMPTZ(6),
  "last_failure_source" VARCHAR(32),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "review_queue_sweep_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_queue_sweep_singleton" CHECK ("id" = 'default'),
  CONSTRAINT "review_queue_trade_cursor_safe" CHECK (
    "trade_cursor" IS NULL OR "trade_cursor" ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT "review_queue_crm_cursor_safe" CHECK (
    "crm_cursor" IS NULL OR "crm_cursor" ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT "review_queue_lease_token_uuid" CHECK (
    "lease_token" IS NULL OR "lease_token" ~ '^[0-9a-f-]{36}$'
  ),
  CONSTRAINT "review_queue_failure_source" CHECK (
    "last_failure_source" IS NULL OR
    "last_failure_source" IN ('TRADE_REQUEST', 'CRM_IDENTITY', 'MULTIPLE', 'MATERIALIZATION')
  )
);

CREATE UNIQUE INDEX "review_queue_item_detector_key_key"
  ON "app"."review_queue_item"("detector_key");
CREATE INDEX "review_queue_item_source_active_last_seen_idx"
  ON "app"."review_queue_item"("source", "source_active", "last_seen_at" DESC);
CREATE INDEX "review_queue_item_status_active_detected_idx"
  ON "app"."review_queue_item"("status", "source_active", "detected_at");
CREATE INDEX "review_queue_item_assigned_status_idx"
  ON "app"."review_queue_item"("assigned_to", "status");
CREATE INDEX "review_queue_item_subject_active_idx"
  ON "app"."review_queue_item"("subject_key", "source_active");
CREATE INDEX "review_queue_event_item_at_idx"
  ON "app"."review_queue_event"("item_id", "at" DESC);
CREATE INDEX "review_queue_event_at_idx"
  ON "app"."review_queue_event"("at" DESC);

GRANT SELECT, INSERT, UPDATE ON "app"."review_queue_item" TO app_rw;
REVOKE DELETE ON "app"."review_queue_item" FROM app_rw;
GRANT SELECT, INSERT ON "app"."review_queue_event" TO app_rw;
REVOKE UPDATE, DELETE ON "app"."review_queue_event" FROM app_rw;
GRANT USAGE, SELECT ON SEQUENCE "app"."review_queue_event_id_seq" TO app_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."review_queue_sweep_state" TO app_rw;
REVOKE DELETE ON "app"."review_queue_sweep_state" FROM app_rw;

ALTER TABLE "app"."review_queue_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."review_queue_item" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."review_queue_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."review_queue_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."review_queue_sweep_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."review_queue_sweep_state" FORCE ROW LEVEL SECURITY;

CREATE POLICY review_queue_item_ops_read ON "app"."review_queue_item"
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_item_ops_insert ON "app"."review_queue_item"
  FOR INSERT TO app_rw WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_item_ops_update ON "app"."review_queue_item"
  FOR UPDATE TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  ) WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_event_ops_read ON "app"."review_queue_event"
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_event_ops_insert ON "app"."review_queue_event"
  FOR INSERT TO app_rw WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_sweep_ops_read ON "app"."review_queue_sweep_state"
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_sweep_ops_insert ON "app"."review_queue_sweep_state"
  FOR INSERT TO app_rw WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY review_queue_sweep_ops_update ON "app"."review_queue_sweep_state"
  FOR UPDATE TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  ) WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );

DO $$
DECLARE owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO owner_roles
    FROM pg_roles WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    EXECUTE format(
      'CREATE POLICY review_queue_item_owner_all ON "app"."review_queue_item" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
    EXECUTE format(
      'CREATE POLICY review_queue_event_owner_all ON "app"."review_queue_event" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
    EXECUTE format(
      'CREATE POLICY review_queue_sweep_owner_all ON "app"."review_queue_sweep_state" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

-- Deliberately no generic audit.log_row_change trigger: resolution_note is
-- user-entered and may contain client context. The append-only event table plus
-- the redacted business audit event provide the required trail without copying
-- note text into the shared audit payload.
