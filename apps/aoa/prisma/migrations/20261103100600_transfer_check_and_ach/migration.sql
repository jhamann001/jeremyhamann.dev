-- ATW-07 (ticket): Apex check tickets and ACH initiations as transfer
-- children. Neither is a receipt or an ACAT submission. A null location means
-- the check is not with the client. Same RLS shape as app.transfer (VIEWER
-- reads, the five write roles insert/update, no DELETE).

CREATE TABLE app.transfer_check_ticket (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "location" text,
  "mailer_sent" boolean NOT NULL DEFAULT false,
  "check_mailed" boolean NOT NULL DEFAULT false,
  "optional_call" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_check_ticket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_check_ticket_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_check_ticket_transfer_id_idx"
  ON "app"."transfer_check_ticket"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_check_ticket" TO app_rw;
REVOKE DELETE ON "app"."transfer_check_ticket" FROM app_rw;

ALTER TABLE "app"."transfer_check_ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_check_ticket" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_check_ticket_read_all_roles
  ON "app"."transfer_check_ticket"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_check_ticket_insert_write_roles
  ON "app"."transfer_check_ticket"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_check_ticket_update_write_roles
  ON "app"."transfer_check_ticket"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE TABLE app.transfer_ach_initiation (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "instructions_sent" boolean NOT NULL,
  "client_initiation_on" date NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_ach_initiation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_ach_initiation_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "transfer_ach_initiation_transfer_id_idx"
  ON "app"."transfer_ach_initiation"("transfer_id");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_ach_initiation" TO app_rw;
REVOKE DELETE ON "app"."transfer_ach_initiation" FROM app_rw;

ALTER TABLE "app"."transfer_ach_initiation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_ach_initiation" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_ach_initiation_read_all_roles
  ON "app"."transfer_ach_initiation"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_ach_initiation_insert_write_roles
  ON "app"."transfer_ach_initiation"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_ach_initiation_update_write_roles
  ON "app"."transfer_ach_initiation"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
