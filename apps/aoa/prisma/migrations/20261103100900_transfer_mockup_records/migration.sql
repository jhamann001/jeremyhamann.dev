-- ticket mockup records: the funding request date, the source and receiving
-- accounts captured at intake, per-leg mailing tracking, and the dates and
-- reasons the ACAT rejection and outcome dialogs record. Additive only.

ALTER TABLE "app"."transfer"
  ADD COLUMN "client_requested_on" date,
  ADD COLUMN "client_request_source" text,
  ADD COLUMN "source_account_type" text,
  ADD COLUMN "source_account_last4" text,
  ADD COLUMN "source_account_title" text,
  ADD COLUMN "receiving_account_type" text,
  ADD COLUMN "receiving_account_title" text;

ALTER TABLE "app"."transfer"
  ADD CONSTRAINT "transfer_client_request_source_check"
    CHECK (client_request_source IS NULL OR client_request_source IN ('Client app', 'Client Service', 'Signed paperwork')),
  ADD CONSTRAINT "transfer_client_request_check"
    CHECK (client_request_source IS NULL OR client_requested_on IS NOT NULL),
  ADD CONSTRAINT "transfer_source_account_last4_check"
    CHECK (source_account_last4 IS NULL OR source_account_last4 ~ '^[A-Za-z0-9]{4}$'),
  ADD CONSTRAINT "transfer_account_title_length_check"
    CHECK (
      (source_account_title IS NULL OR length(source_account_title) <= 250)
      AND (receiving_account_title IS NULL OR length(receiving_account_title) <= 250)
    );

ALTER TABLE "app"."transfer_acat_rejection"
  ADD COLUMN "reason" text,
  ADD COLUMN "code" text,
  ADD COLUMN "rejected_on" date,
  ADD CONSTRAINT "transfer_acat_rejection_reason_length_check"
    CHECK ((reason IS NULL OR length(reason) <= 1000) AND (code IS NULL OR length(code) <= 120));

ALTER TABLE "app"."transfer_outcome"
  ADD COLUMN "outcome_on" date;

CREATE TABLE "app"."transfer_mailing_leg" (
  "id" text NOT NULL,
  "mailing_id" text NOT NULL,
  "leg_number" integer NOT NULL,
  "from_stop" text NOT NULL,
  "to_stop" text NOT NULL,
  "carrier" text,
  "tracking_number" text,
  "mailed_on" date,
  "received_on" date,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "transfer_mailing_leg_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_mailing_leg_number_check" CHECK (leg_number >= 1),
  CONSTRAINT "transfer_mailing_leg_carrier_check"
    CHECK (carrier IS NULL OR carrier IN ('FedEx', 'USPS', 'UPS', 'DHL', 'Other')),
  CONSTRAINT "transfer_mailing_leg_tracking_check"
    CHECK (tracking_number IS NULL OR length(tracking_number) <= 250),
  CONSTRAINT "transfer_mailing_leg_dates_check"
    CHECK (received_on IS NULL OR (mailed_on IS NOT NULL AND received_on >= mailed_on)),
  CONSTRAINT "transfer_mailing_leg_mailing_id_fkey"
    FOREIGN KEY ("mailing_id") REFERENCES "app"."transfer_mailing"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "transfer_mailing_leg_mailing_id_leg_number_key"
  ON "app"."transfer_mailing_leg"("mailing_id", "leg_number");

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_mailing_leg" TO app_rw;
REVOKE DELETE ON "app"."transfer_mailing_leg" FROM app_rw;

ALTER TABLE "app"."transfer_mailing_leg" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_mailing_leg" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_mailing_leg_read_all_roles
  ON "app"."transfer_mailing_leg"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_mailing_leg_insert_write_roles
  ON "app"."transfer_mailing_leg"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_mailing_leg_update_write_roles
  ON "app"."transfer_mailing_leg"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
