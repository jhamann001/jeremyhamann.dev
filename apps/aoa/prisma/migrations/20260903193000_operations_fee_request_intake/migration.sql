-- Development-first Fee Credit & Service Guarantee intake. Requests are
-- Operations-only, start PENDING, and do not execute a credit or waiver.
-- Account references are opaque AOA account ids rather than account numbers.

BEGIN;

CREATE TYPE "app"."OperationsFeeRequestKind" AS ENUM (
  'FEE_CREDIT',
  'SERVICE_GUARANTEE',
  'BILLING_EXCEPTION',
  'LARGE_HOUSEHOLD_EXCEPTION'
);

CREATE TYPE "app"."OperationsFeeRequestStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

CREATE TABLE "app"."operations_fee_request" (
  "id" TEXT NOT NULL,
  "kind" "app"."OperationsFeeRequestKind" NOT NULL,
  "status" "app"."OperationsFeeRequestStatus" NOT NULL DEFAULT 'PENDING',
  "client_sf_id" VARCHAR(64) NOT NULL,
  "account_ids" TEXT[] NOT NULL,
  "fee_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fee_amount" DECIMAL(14,2),
  "waiver_start" DATE,
  "waiver_duration_months" INTEGER,
  "indefinite_duration" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(2000) NOT NULL DEFAULT '',
  "relevant_ticket_refs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "submitted_by_email" VARCHAR(320) NOT NULL,
  "submitted_by_role" VARCHAR(32) NOT NULL,
  "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "reviewed_by_email" VARCHAR(320),
  "reviewed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "operations_fee_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operations_fee_request_accounts_check"
    CHECK (
      cardinality("account_ids") BETWEEN 1 AND 50
      AND array_position("account_ids", '') IS NULL
      AND length(array_to_string("account_ids", '')) <= 6400
    ),
  CONSTRAINT "operations_fee_request_tickets_check"
    CHECK (
      cardinality("relevant_ticket_refs") <= 50
      AND array_position("relevant_ticket_refs", '') IS NULL
      AND length(array_to_string("relevant_ticket_refs", '')) <= 4000
    ),
  CONSTRAINT "operations_fee_request_client_check"
    CHECK ("client_sf_id" ~ '^[[:alnum:]]{15,18}$'),
  CONSTRAINT "operations_fee_request_shape_check" CHECK (
    (
      "kind" = 'FEE_CREDIT'
      AND "fee_amount" IS NOT NULL AND "fee_amount" > 0
      AND cardinality("fee_types") BETWEEN 1 AND 7
      AND "fee_types" <@ ARRAY[
        'IRA Maintenance', 'IRA Termination', 'ACAT in', 'ACAT out',
        'Transaction', 'Wire', 'Relationship Waiver (Advisor Only)'
      ]::TEXT[]
      AND "waiver_start" IS NULL
      AND "waiver_duration_months" IS NULL
      AND "indefinite_duration" = false
    ) OR (
      "kind" <> 'FEE_CREDIT'
      AND "fee_amount" IS NULL
      AND cardinality("fee_types") = 0
      AND "waiver_start" IS NOT NULL
      AND length(btrim("reason")) BETWEEN 1 AND 2000
      AND (
        ("indefinite_duration" = true AND "waiver_duration_months" IS NULL)
        OR
        ("indefinite_duration" = false AND "waiver_duration_months" BETWEEN 1 AND 120)
      )
    )
  )
);

CREATE INDEX "operations_fee_request_status_submitted_idx"
  ON "app"."operations_fee_request"("status", "submitted_at" DESC);
CREATE INDEX "operations_fee_request_client_submitted_idx"
  ON "app"."operations_fee_request"("client_sf_id", "submitted_at" DESC);

CREATE TABLE "app"."operations_fee_request_event" (
  "id" BIGSERIAL NOT NULL,
  "request_id" TEXT NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "actor_email" VARCHAR(320) NOT NULL,
  "actor_role" VARCHAR(32) NOT NULL,
  "from_status" "app"."OperationsFeeRequestStatus",
  "to_status" "app"."OperationsFeeRequestStatus",
  "detail" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "operations_fee_request_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operations_fee_request_event_request_fkey" FOREIGN KEY ("request_id")
    REFERENCES "app"."operations_fee_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "operations_fee_request_event_action_check"
    CHECK ("action" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "operations_fee_request_event_detail_check"
    CHECK (jsonb_typeof("detail") = 'object')
);

CREATE INDEX "operations_fee_request_event_request_idx"
  ON "app"."operations_fee_request_event"("request_id", "at" DESC);
CREATE INDEX "operations_fee_request_event_at_idx"
  ON "app"."operations_fee_request_event"("at" DESC);

REVOKE ALL ON "app"."operations_fee_request" FROM PUBLIC, app_rw;
REVOKE ALL ON "app"."operations_fee_request_event" FROM PUBLIC, app_rw;
GRANT SELECT, INSERT ON "app"."operations_fee_request" TO app_rw;
GRANT SELECT, INSERT ON "app"."operations_fee_request_event" TO app_rw;
GRANT USAGE, SELECT ON SEQUENCE "app"."operations_fee_request_event_id_seq" TO app_rw;

ALTER TABLE "app"."operations_fee_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."operations_fee_request" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."operations_fee_request_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."operations_fee_request_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY operations_fee_request_ops_read ON "app"."operations_fee_request"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY operations_fee_request_ops_insert ON "app"."operations_fee_request"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "status" = 'PENDING'
    AND "submitted_by_role" = current_setting('app.user_role', true)
    AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
    AND "submitted_by_email" = current_setting('app.user_email', true)
  );

CREATE POLICY operations_fee_request_event_ops_read ON "app"."operations_fee_request_event"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY operations_fee_request_event_ops_insert ON "app"."operations_fee_request_event"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "actor_role" = current_setting('app.user_role', true)
    AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
    AND "actor_email" = current_setting('app.user_email', true)
    AND "action" = 'SUBMITTED'
    AND "from_status" IS NULL
    AND "to_status" = 'PENDING'
    AND EXISTS (
      SELECT 1 FROM "app"."operations_fee_request" request
       WHERE request.id = "request_id"
    )
  );

COMMIT;
