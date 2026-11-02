-- Preserve Fee Store lineage without pretending legacy names are authenticated
-- email identities or summary-level trade runs contain security-level rows.
-- Live request/review paths retain their existing RLS identity requirements.

BEGIN;

-- Temporarily remove the immutable-payload trigger inside this migration so
-- the controlled label rename below can run. It is recreated before COMMIT.
DROP TRIGGER IF EXISTS "operations_fee_request_workflow_guard"
  ON "app"."operations_fee_request";

ALTER TABLE "app"."operations_fee_request"
  ALTER COLUMN "submitted_by_email" DROP NOT NULL,
  ADD COLUMN "submitted_by_name" VARCHAR(160),
  ADD COLUMN "reviewed_by_name" VARCHAR(160),
  ADD COLUMN "completed_by_name" VARCHAR(160),
  ADD COLUMN "legacy_apex_request_text" VARCHAR(1000),
  ADD COLUMN "legacy_source" VARCHAR(48),
  ADD COLUMN "legacy_source_id" VARCHAR(80),
  ADD COLUMN "legacy_source_digest" CHAR(64),
  ADD CONSTRAINT "operations_fee_request_legacy_key"
    UNIQUE ("legacy_source", "legacy_source_id"),
  ADD CONSTRAINT "operations_fee_request_legacy_lineage_check" CHECK (
    (
      "legacy_source" IS NULL
      AND "legacy_source_id" IS NULL
      AND "legacy_source_digest" IS NULL
      AND "legacy_apex_request_text" IS NULL
      AND "submitted_by_email" IS NOT NULL
    ) OR (
      "legacy_source" IN ('fee_store_fee_credits', 'fee_store_billing_exceptions')
      AND "legacy_source_id" IS NOT NULL
      AND "legacy_source_digest" IS NOT NULL
      AND length(btrim("legacy_source_id")) BETWEEN 1 AND 80
      AND "legacy_source_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT "operations_fee_request_legacy_name_check" CHECK (
    length(COALESCE(btrim("submitted_by_name"), '')) <= 160
    AND length(COALESCE(btrim("reviewed_by_name"), '')) <= 160
    AND length(COALESCE(btrim("completed_by_name"), '')) <= 160
  );

ALTER TABLE "app"."operations_fee_request"
  DROP CONSTRAINT "operations_fee_request_shape_check";

UPDATE "app"."operations_fee_request"
   SET "fee_types" = array_replace(
     "fee_types", 'Relationship Waiver (Advisor Only)', 'Relationship Waiver'
   )
 WHERE "fee_types" @> ARRAY['Relationship Waiver (Advisor Only)']::TEXT[];

ALTER TABLE "app"."operations_fee_request"
  ADD CONSTRAINT "operations_fee_request_shape_check" CHECK (
    (
      "kind" = 'FEE_CREDIT'
      AND "fee_amount" IS NOT NULL
      AND (
        ("legacy_source" IS NOT NULL AND "fee_amount" >= 0)
        OR ("legacy_source" IS NULL AND "fee_amount" > 0)
      )
      AND cardinality("fee_types") BETWEEN 1 AND 7
      AND "fee_types" <@ ARRAY[
        'IRA Maintenance', 'IRA Termination', 'ACAT in', 'ACAT out',
        'Transaction', 'Wire', 'Relationship Waiver'
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
  );

ALTER TABLE "app"."operations_fee_request"
  DROP CONSTRAINT "operations_fee_request_completion_check",
  ADD CONSTRAINT "operations_fee_request_completion_check" CHECK (
    (
      "status"::text = 'CREDITED'
      AND "kind"::text = 'FEE_CREDIT'
      AND "credited_at" IS NOT NULL
      AND length(btrim("apex_request_id")) BETWEEN 1 AND 80
      AND "completed_at" IS NOT NULL
      AND (
        "legacy_source" IS NOT NULL
        OR "completed_by_email" IS NOT NULL
      )
    ) OR (
      "status"::text <> 'CREDITED'
      AND "credited_at" IS NULL
      AND ("legacy_source" IS NOT NULL OR "apex_request_id" IS NULL)
      AND "completed_by_email" IS NULL
      AND "completed_by_name" IS NULL
      AND "completed_at" IS NULL
    )
  );

ALTER TABLE "app"."operations_fee_request_event"
  ALTER COLUMN "actor_email" DROP NOT NULL,
  ADD COLUMN "actor_name" VARCHAR(160),
  ADD CONSTRAINT "operations_fee_request_event_actor_check" CHECK (
    "actor_email" IS NOT NULL OR "actor_name" IS NOT NULL
  );

ALTER TABLE "app"."operations_fee_request_event"
  DROP CONSTRAINT "operations_fee_request_event_action_check",
  ADD CONSTRAINT "operations_fee_request_event_action_check"
    CHECK ("action" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CREDITED', 'LEGACY_IMPORTED'));

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
     OR NEW."submitted_by_name" IS DISTINCT FROM OLD."submitted_by_name"
     OR NEW."submitted_by_role" IS DISTINCT FROM OLD."submitted_by_role"
     OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
     OR NEW."reviewed_by_name" IS DISTINCT FROM OLD."reviewed_by_name"
     OR NEW."completed_by_name" IS DISTINCT FROM OLD."completed_by_name"
     OR NEW."legacy_apex_request_text" IS DISTINCT FROM OLD."legacy_apex_request_text"
     OR NEW."legacy_source" IS DISTINCT FROM OLD."legacy_source"
     OR NEW."legacy_source_id" IS DISTINCT FROM OLD."legacy_source_id"
     OR NEW."legacy_source_digest" IS DISTINCT FROM OLD."legacy_source_digest"
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

ALTER TABLE "app"."trade_reconciliation_run"
  ADD COLUMN "legacy_source" VARCHAR(48),
  ADD COLUMN "legacy_source_id" VARCHAR(80),
  ADD COLUMN "legacy_unmatched_apex" INTEGER,
  ADD COLUMN "legacy_unmatched_alpha" INTEGER,
  ADD COLUMN "legacy_match_rate" DECIMAL(20,15),
  ADD CONSTRAINT "trade_reconciliation_run_legacy_key"
    UNIQUE ("legacy_source", "legacy_source_id"),
  ADD CONSTRAINT "trade_reconciliation_run_legacy_check" CHECK (
    (
      "legacy_source" IS NULL
      AND "legacy_source_id" IS NULL
      AND "legacy_unmatched_apex" IS NULL
      AND "legacy_unmatched_alpha" IS NULL
      AND "legacy_match_rate" IS NULL
    ) OR (
      "legacy_source" = 'fee_store_daily_reconciliation'
      AND "legacy_source_id" IS NOT NULL
      AND "legacy_unmatched_apex" IS NOT NULL
      AND "legacy_unmatched_alpha" IS NOT NULL
      AND length(btrim("legacy_source_id")) BETWEEN 1 AND 80
      AND "legacy_unmatched_apex" BETWEEN 0 AND "apex_record_count"
      AND "legacy_unmatched_alpha" BETWEEN 0 AND "meridian_record_count"
      AND ("legacy_match_rate" IS NULL OR "legacy_match_rate" BETWEEN 0 AND 100)
    )
  );

ALTER TABLE "app"."trade_reconciliation_run"
  DROP CONSTRAINT "trade_reconciliation_run_counts_check",
  ADD CONSTRAINT "trade_reconciliation_run_counts_check" CHECK (
    "apex_record_count" >= 0 AND "meridian_record_count" >= 0
    AND "raw_match_count" >= 0 AND "exception_count" >= 0
    AND (
      "legacy_source" IS NOT NULL
      OR "raw_match_count" + "exception_count" >= "apex_record_count"
    )
  );

-- FORCE RLS also binds the non-superuser migration owner. Grant only the
-- owner that applied this migration the narrow legacy read/insert path used by
-- the one-time importer. Runtime app_rw policies remain unchanged, and no
-- owner UPDATE or DELETE path is introduced.
DO $$
DECLARE
  owner_role text := quote_ident(current_user);
BEGIN
  EXECUTE format(
    'CREATE POLICY operations_fee_request_legacy_owner_read '
    'ON app.operations_fee_request FOR SELECT TO %s '
    'USING (legacy_source IN (''fee_store_fee_credits'', ''fee_store_billing_exceptions''))',
    owner_role
  );
  EXECUTE format(
    'CREATE POLICY operations_fee_request_legacy_owner_insert '
    'ON app.operations_fee_request FOR INSERT TO %s '
    'WITH CHECK (legacy_source IN (''fee_store_fee_credits'', ''fee_store_billing_exceptions''))',
    owner_role
  );
  EXECUTE format(
    'CREATE POLICY operations_fee_request_event_legacy_owner_insert '
    'ON app.operations_fee_request_event FOR INSERT TO %s '
    'WITH CHECK (action = ''LEGACY_IMPORTED'' AND EXISTS ('
      'SELECT 1 FROM app.operations_fee_request request '
      'WHERE request.id = request_id AND request.legacy_source IS NOT NULL))',
    owner_role
  );
  EXECUTE format(
    'CREATE POLICY trade_reconciliation_run_legacy_owner_read '
    'ON app.trade_reconciliation_run FOR SELECT TO %s '
    'USING (legacy_source = ''fee_store_daily_reconciliation'')',
    owner_role
  );
  EXECUTE format(
    'CREATE POLICY trade_reconciliation_run_legacy_owner_insert '
    'ON app.trade_reconciliation_run FOR INSERT TO %s '
    'WITH CHECK (legacy_source = ''fee_store_daily_reconciliation'')',
    owner_role
  );
  EXECUTE format(
    'CREATE POLICY trade_reconciliation_note_legacy_owner_insert '
    'ON app.trade_reconciliation_note_event FOR INSERT TO %s '
    'WITH CHECK (author_email IS NULL AND EXISTS ('
      'SELECT 1 FROM app.trade_reconciliation_run run '
      'WHERE run.id = run_id AND run.legacy_source = ''fee_store_daily_reconciliation''))',
    owner_role
  );
END $$;

COMMIT;
