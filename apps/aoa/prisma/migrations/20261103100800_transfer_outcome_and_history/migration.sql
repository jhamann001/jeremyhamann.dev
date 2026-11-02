-- ATW-10 (ticket): movement outcomes (the four values in the CHECK below),
-- correction history and unbound stage-change history as transfer children. Recording an outcome deletes nothing. Same RLS shape as
-- app.transfer (VIEWER reads, the five write roles insert/update, no DELETE).

CREATE TABLE "app"."transfer_outcome" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "follow_up_on" date,
  "resumed" boolean NOT NULL DEFAULT false,
  "prior_assignment" text,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_outcome_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_outcome_outcome_check"
    CHECK (outcome IN ('Client declined', 'Deferred', 'Canceled', 'Purged')),
  CONSTRAINT "transfer_outcome_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_outcome_transfer_id_idx"
  ON "app"."transfer_outcome"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_outcome" TO app_rw;
REVOKE DELETE ON "app"."transfer_outcome" FROM app_rw;

ALTER TABLE "app"."transfer_outcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_outcome" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_outcome_read_all_roles
  ON "app"."transfer_outcome"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_outcome_insert_write_roles
  ON "app"."transfer_outcome"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_outcome_update_write_roles
  ON "app"."transfer_outcome"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_correction" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "correction" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_correction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_correction_length_check"
    CHECK (length(btrim(correction)) BETWEEN 1 AND 2000),
  CONSTRAINT "transfer_correction_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_correction_transfer_id_idx"
  ON "app"."transfer_correction"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_correction" TO app_rw;
REVOKE DELETE ON "app"."transfer_correction" FROM app_rw;

ALTER TABLE "app"."transfer_correction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_correction" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_correction_read_all_roles
  ON "app"."transfer_correction"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_correction_insert_write_roles
  ON "app"."transfer_correction"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_correction_update_write_roles
  ON "app"."transfer_correction"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_stage_change" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "previous_stage" "app"."TransferStage" NOT NULL,
  "new_stage" "app"."TransferStage" NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_stage_change_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_stage_change_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_stage_change_transfer_id_idx"
  ON "app"."transfer_stage_change"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_stage_change" TO app_rw;
REVOKE DELETE ON "app"."transfer_stage_change" FROM app_rw;

ALTER TABLE "app"."transfer_stage_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_stage_change" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_stage_change_read_all_roles
  ON "app"."transfer_stage_change"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_stage_change_insert_write_roles
  ON "app"."transfer_stage_change"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_stage_change_update_write_roles
  ON "app"."transfer_stage_change"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
