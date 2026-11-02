-- ATW-09 (ticket): fee reimbursement, the linked investment request, ACAT
-- residuals and ACAT rejections as transfer children. A residual keeps the
-- original control number and never changes the transfer's value or stage. A
-- rejection row stays in history; its response and review state are updated
-- in place. No fee-amount column. Same RLS shape as app.transfer (VIEWER
-- reads, the five write roles insert/update, no DELETE).

CREATE TABLE "app"."transfer_fee_reimbursement" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "evidenced" boolean NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_fee_reimbursement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_fee_reimbursement_evidenced_check" CHECK (evidenced),
  CONSTRAINT "transfer_fee_reimbursement_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_fee_reimbursement_transfer_id_idx"
  ON "app"."transfer_fee_reimbursement"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_fee_reimbursement" TO app_rw;
REVOKE DELETE ON "app"."transfer_fee_reimbursement" FROM app_rw;

ALTER TABLE "app"."transfer_fee_reimbursement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_fee_reimbursement" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_fee_reimbursement_read_all_roles
  ON "app"."transfer_fee_reimbursement"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_fee_reimbursement_insert_write_roles
  ON "app"."transfer_fee_reimbursement"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_fee_reimbursement_update_write_roles
  ON "app"."transfer_fee_reimbursement"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_investment_link" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "linked_investment_request" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_investment_link_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_investment_link_request_check"
    CHECK (length(btrim(linked_investment_request)) BETWEEN 1 AND 64),
  CONSTRAINT "transfer_investment_link_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_investment_link_transfer_id_idx"
  ON "app"."transfer_investment_link"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_investment_link" TO app_rw;
REVOKE DELETE ON "app"."transfer_investment_link" FROM app_rw;

ALTER TABLE "app"."transfer_investment_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_investment_link" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_investment_link_read_all_roles
  ON "app"."transfer_investment_link"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_investment_link_insert_write_roles
  ON "app"."transfer_investment_link"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_investment_link_update_write_roles
  ON "app"."transfer_investment_link"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_residual" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "original_control_number" text NOT NULL,
  "tracker_stage" text,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_residual_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_residual_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_residual_transfer_id_idx"
  ON "app"."transfer_residual"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_residual" TO app_rw;
REVOKE DELETE ON "app"."transfer_residual" FROM app_rw;

ALTER TABLE "app"."transfer_residual" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_residual" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_residual_read_all_roles
  ON "app"."transfer_residual"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_residual_insert_write_roles
  ON "app"."transfer_residual"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_residual_update_write_roles
  ON "app"."transfer_residual"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_acat_rejection" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "completion_estimate" date,
  "arrival_paused" boolean NOT NULL DEFAULT true,
  "follow_up_owner" text NOT NULL,
  "response" text,
  "awaiting_operations_review" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_acat_rejection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_acat_rejection_review_check"
    CHECK (NOT awaiting_operations_review OR response IS NOT NULL),
  CONSTRAINT "transfer_acat_rejection_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_acat_rejection_transfer_id_idx"
  ON "app"."transfer_acat_rejection"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_acat_rejection" TO app_rw;
REVOKE DELETE ON "app"."transfer_acat_rejection" FROM app_rw;

ALTER TABLE "app"."transfer_acat_rejection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_acat_rejection" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_acat_rejection_read_all_roles
  ON "app"."transfer_acat_rejection"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_acat_rejection_insert_write_roles
  ON "app"."transfer_acat_rejection"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_acat_rejection_update_write_roles
  ON "app"."transfer_acat_rejection"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
