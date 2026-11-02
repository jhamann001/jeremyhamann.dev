-- ATW-04 (ticket): paperwork, signature, app authorization, DRS service
-- request and mailed paperwork records as separate transfer children. Route
-- labels are derived, not stored. Same RLS shape as app.transfer (VIEWER reads,
-- the five write roles insert/update, no DELETE).

CREATE TABLE "app"."transfer_form_review" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "reviewed" boolean NOT NULL DEFAULT false,
  "receiving_form_title" text,
  "source_form_title" text,
  "title_owners_confirmed" text,
  "apex_account_id" text NOT NULL,
  "form_id" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_form_review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_form_review_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_form_review_transfer_id_idx"
  ON "app"."transfer_form_review"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_form_review" TO app_rw;
REVOKE DELETE ON "app"."transfer_form_review" FROM app_rw;

ALTER TABLE "app"."transfer_form_review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_form_review" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_form_review_read_all_roles
  ON "app"."transfer_form_review"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_form_review_insert_write_roles
  ON "app"."transfer_form_review"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_form_review_update_write_roles
  ON "app"."transfer_form_review"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_sent_packet" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_sent_packet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_sent_packet_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_sent_packet_transfer_id_idx"
  ON "app"."transfer_sent_packet"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_sent_packet" TO app_rw;
REVOKE DELETE ON "app"."transfer_sent_packet" FROM app_rw;

ALTER TABLE "app"."transfer_sent_packet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_sent_packet" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_sent_packet_read_all_roles
  ON "app"."transfer_sent_packet"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_sent_packet_insert_write_roles
  ON "app"."transfer_sent_packet"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_sent_packet_update_write_roles
  ON "app"."transfer_sent_packet"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_returned_signature" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_returned_signature_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_returned_signature_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_returned_signature_transfer_id_idx"
  ON "app"."transfer_returned_signature"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_returned_signature" TO app_rw;
REVOKE DELETE ON "app"."transfer_returned_signature" FROM app_rw;

ALTER TABLE "app"."transfer_returned_signature" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_returned_signature" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_returned_signature_read_all_roles
  ON "app"."transfer_returned_signature"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_returned_signature_insert_write_roles
  ON "app"."transfer_returned_signature"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_returned_signature_update_write_roles
  ON "app"."transfer_returned_signature"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_app_authorization" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_app_authorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_app_authorization_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_app_authorization_transfer_id_idx"
  ON "app"."transfer_app_authorization"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_app_authorization" TO app_rw;
REVOKE DELETE ON "app"."transfer_app_authorization" FROM app_rw;

ALTER TABLE "app"."transfer_app_authorization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_app_authorization" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_app_authorization_read_all_roles
  ON "app"."transfer_app_authorization"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_app_authorization_insert_write_roles
  ON "app"."transfer_app_authorization"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_app_authorization_update_write_roles
  ON "app"."transfer_app_authorization"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_drs_service_request" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_drs_service_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_drs_service_request_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_drs_service_request_transfer_id_idx"
  ON "app"."transfer_drs_service_request"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_drs_service_request" TO app_rw;
REVOKE DELETE ON "app"."transfer_drs_service_request" FROM app_rw;

ALTER TABLE "app"."transfer_drs_service_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_drs_service_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_drs_service_request_read_all_roles
  ON "app"."transfer_drs_service_request"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_drs_service_request_insert_write_roles
  ON "app"."transfer_drs_service_request"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_drs_service_request_update_write_roles
  ON "app"."transfer_drs_service_request"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE "app"."transfer_mailed_paperwork" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_mailed_paperwork_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_mailed_paperwork_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_mailed_paperwork_transfer_id_idx"
  ON "app"."transfer_mailed_paperwork"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_mailed_paperwork" TO app_rw;
REVOKE DELETE ON "app"."transfer_mailed_paperwork" FROM app_rw;

ALTER TABLE "app"."transfer_mailed_paperwork" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_mailed_paperwork" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_mailed_paperwork_read_all_roles
  ON "app"."transfer_mailed_paperwork"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_mailed_paperwork_insert_write_roles
  ON "app"."transfer_mailed_paperwork"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_mailed_paperwork_update_write_roles
  ON "app"."transfer_mailed_paperwork"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
