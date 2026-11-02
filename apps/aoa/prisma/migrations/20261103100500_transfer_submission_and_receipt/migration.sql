-- ATW-06 (ticket): Operations submission log, tracking updates and the
-- versioned receipt review with its comparison lines, as transfer children.
-- Receipt versions are insert-only so earlier reviews stay visible. Receipt
-- lines carry no security identifier or dollar column. Same RLS shape as
-- app.transfer (VIEWER reads, the five write roles insert/update, no DELETE).

CREATE TABLE "app"."transfer_submission" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "control_number" text NOT NULL,
  "submitted_on" date NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_submission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_submission_control_number_check"
    CHECK (length(btrim(control_number)) BETWEEN 1 AND 64),
  CONSTRAINT "transfer_submission_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_submission_transfer_id_idx"
  ON "app"."transfer_submission"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_submission" TO app_rw;
REVOKE DELETE ON "app"."transfer_submission" FROM app_rw;

ALTER TABLE "app"."transfer_submission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_submission" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_submission_read_all_roles
  ON "app"."transfer_submission"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_submission_insert_write_roles
  ON "app"."transfer_submission"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_submission_update_write_roles
  ON "app"."transfer_submission"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_tracking_update" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "tracking_stage" text NOT NULL,
  "expected_completion_on" date,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_tracking_update_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_tracking_update_stage_check"
    CHECK (length(btrim(tracking_stage)) BETWEEN 1 AND 80),
  CONSTRAINT "transfer_tracking_update_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_tracking_update_transfer_id_idx"
  ON "app"."transfer_tracking_update"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_tracking_update" TO app_rw;
REVOKE DELETE ON "app"."transfer_tracking_update" FROM app_rw;

ALTER TABLE "app"."transfer_tracking_update" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_tracking_update" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_tracking_update_read_all_roles
  ON "app"."transfer_tracking_update"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_tracking_update_insert_write_roles
  ON "app"."transfer_tracking_update"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_tracking_update_update_write_roles
  ON "app"."transfer_tracking_update"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_receipt" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "version" integer NOT NULL,
  "partial" boolean NOT NULL,
  "next_action" text,
  "follow_up_owner" text,
  "next_check_on" date,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_receipt_version_check" CHECK (version >= 1),
  CONSTRAINT "transfer_receipt_partial_follow_up_check"
    CHECK (NOT partial OR (next_action IS NOT NULL AND follow_up_owner IS NOT NULL AND next_check_on IS NOT NULL)),
  CONSTRAINT "transfer_receipt_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "transfer_receipt_transfer_id_version_key"
  ON "app"."transfer_receipt"("transfer_id", "version");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_receipt" TO app_rw;
REVOKE DELETE ON "app"."transfer_receipt" FROM app_rw;

ALTER TABLE "app"."transfer_receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_receipt" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_receipt_read_all_roles
  ON "app"."transfer_receipt"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_receipt_insert_write_roles
  ON "app"."transfer_receipt"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_receipt_update_write_roles
  ON "app"."transfer_receipt"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_receipt_line" (
  "id" text NOT NULL,
  "receipt_id" text NOT NULL,
  "line_number" integer NOT NULL,
  "classification" text NOT NULL,
  "quantity" numeric(24,6),
  "line_status" text NOT NULL,
  "variance_percentage" numeric(14,6),
  "review_note" text,
  "explanation" text,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_receipt_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_receipt_line_classification_check"
    CHECK (classification IN ('matched', 'mismatched', 'unexpected')),
  CONSTRAINT "transfer_receipt_line_status_check"
    CHECK (line_status IN ('verified', 'outstanding')),
  CONSTRAINT "transfer_receipt_line_receipt_id_fkey"
    FOREIGN KEY ("receipt_id") REFERENCES "app"."transfer_receipt"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "transfer_receipt_line_receipt_id_line_number_key"
  ON "app"."transfer_receipt_line"("receipt_id", "line_number");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_receipt_line" TO app_rw;
REVOKE DELETE ON "app"."transfer_receipt_line" FROM app_rw;

ALTER TABLE "app"."transfer_receipt_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_receipt_line" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_receipt_line_read_all_roles
  ON "app"."transfer_receipt_line"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_receipt_line_insert_write_roles
  ON "app"."transfer_receipt_line"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_receipt_line_update_write_roles
  ON "app"."transfer_receipt_line"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
