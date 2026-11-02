-- Complete the internal review lifecycle without executing any external fee
-- credit or billing change. Narrative notes stay in the RLS-protected event
-- table; generic audit rows remain metadata-only.

ALTER TYPE "app"."OperationsFeeRequestStatus" ADD VALUE IF NOT EXISTS 'CREDITED';

ALTER TABLE "app"."operations_fee_request"
  ADD COLUMN "credited_at" DATE,
  ADD COLUMN "apex_request_id" VARCHAR(80),
  ADD COLUMN "completed_by_email" VARCHAR(320),
  ADD COLUMN "completed_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "operations_fee_request_completion_check" CHECK (
    (
      "status"::text = 'CREDITED'
      AND "kind"::text = 'FEE_CREDIT'
      AND "credited_at" IS NOT NULL
      AND length(btrim("apex_request_id")) BETWEEN 1 AND 80
      AND "completed_by_email" IS NOT NULL
      AND "completed_at" IS NOT NULL
    ) OR (
      "status"::text <> 'CREDITED'
      AND "credited_at" IS NULL
      AND "apex_request_id" IS NULL
      AND "completed_by_email" IS NULL
      AND "completed_at" IS NULL
    )
  );

ALTER TABLE "app"."operations_fee_request_event"
  DROP CONSTRAINT "operations_fee_request_event_action_check",
  ADD CONSTRAINT "operations_fee_request_event_action_check"
    CHECK ("action" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CREDITED')),
  ADD CONSTRAINT "operations_fee_request_event_note_check"
    CHECK (length(COALESCE("detail"->>'note', '')) <= 1000);

CREATE OR REPLACE FUNCTION "app"."protect_operations_fee_request_workflow"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text := current_setting('app.user_role', true);
  v_email text := NULLIF(current_setting('app.user_email', true), '');
BEGIN
  IF v_role NOT IN ('ADMIN', 'OPERATIONS') OR v_email IS NULL THEN
    RAISE EXCEPTION 'operations_fee_request_update_denied';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."client_sf_id" IS DISTINCT FROM OLD."client_sf_id"
     OR NEW."account_ids" IS DISTINCT FROM OLD."account_ids"
     OR NEW."fee_types" IS DISTINCT FROM OLD."fee_types"
     OR NEW."fee_amount" IS DISTINCT FROM OLD."fee_amount"
     OR NEW."waiver_start" IS DISTINCT FROM OLD."waiver_start"
     OR NEW."waiver_duration_months" IS DISTINCT FROM OLD."waiver_duration_months"
     OR NEW."indefinite_duration" IS DISTINCT FROM OLD."indefinite_duration"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."relevant_ticket_refs" IS DISTINCT FROM OLD."relevant_ticket_refs"
     OR NEW."submitted_by_email" IS DISTINCT FROM OLD."submitted_by_email"
     OR NEW."submitted_by_role" IS DISTINCT FROM OLD."submitted_by_role"
     OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'operations_fee_request_payload_immutable';
  END IF;

  IF OLD."status"::text = 'PENDING' AND NEW."status"::text IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    IF NEW."reviewed_by_email" IS DISTINCT FROM v_email OR NEW."reviewed_at" IS NULL THEN
      RAISE EXCEPTION 'operations_fee_request_reviewer_invalid';
    END IF;
  ELSIF OLD."status"::text = 'APPROVED' AND NEW."status"::text = 'CREDITED' AND OLD."kind"::text = 'FEE_CREDIT' THEN
    IF NEW."reviewed_by_email" IS DISTINCT FROM OLD."reviewed_by_email"
       OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
       OR NEW."completed_by_email" IS DISTINCT FROM v_email
       OR NEW."completed_at" IS NULL
       OR NEW."credited_at" IS NULL
       OR length(btrim(NEW."apex_request_id")) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'operations_fee_request_completion_invalid';
    END IF;
  ELSIF OLD."status"::text = 'APPROVED' AND NEW."status"::text = 'CANCELLED' THEN
    IF NEW."reviewed_by_email" IS DISTINCT FROM OLD."reviewed_by_email"
       OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at" THEN
      RAISE EXCEPTION 'operations_fee_request_review_immutable';
    END IF;
  ELSE
    RAISE EXCEPTION 'operations_fee_request_transition_invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "operations_fee_request_workflow_guard"
BEFORE UPDATE ON "app"."operations_fee_request"
FOR EACH ROW EXECUTE FUNCTION "app"."protect_operations_fee_request_workflow"();

GRANT UPDATE (
  "status", "reviewed_by_email", "reviewed_at", "credited_at",
  "apex_request_id", "completed_by_email", "completed_at", "updated_at"
) ON "app"."operations_fee_request" TO app_rw;

CREATE POLICY operations_fee_request_ops_update ON "app"."operations_fee_request"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));

DROP POLICY operations_fee_request_event_ops_insert ON "app"."operations_fee_request_event";
CREATE POLICY operations_fee_request_event_ops_insert ON "app"."operations_fee_request_event"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "actor_role" = current_setting('app.user_role', true)
    AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
    AND "actor_email" = current_setting('app.user_email', true)
    AND (
      ("action" = 'SUBMITTED' AND "from_status" IS NULL AND "to_status"::text = 'PENDING')
      OR ("action" = 'APPROVED' AND "from_status"::text = 'PENDING' AND "to_status"::text = 'APPROVED')
      OR ("action" = 'REJECTED' AND "from_status"::text = 'PENDING' AND "to_status"::text = 'REJECTED')
      OR ("action" = 'CANCELLED' AND "from_status"::text IN ('PENDING', 'APPROVED') AND "to_status"::text = 'CANCELLED')
      OR ("action" = 'CREDITED' AND "from_status"::text = 'APPROVED' AND "to_status"::text = 'CREDITED')
    )
    AND EXISTS (
      SELECT 1 FROM "app"."operations_fee_request" request
       WHERE request.id = "request_id"
         AND request.status = "to_status"
    )
  );
