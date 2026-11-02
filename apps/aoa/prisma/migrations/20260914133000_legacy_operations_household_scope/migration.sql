-- Allow specifically reviewed Fee Store requests to retain their original client
-- label while spanning accounts owned by multiple contacts in one confirmed
-- canonical household. Live intake remains client-scoped.

BEGIN;

CREATE TYPE "app"."OperationsFeeRequestScope" AS ENUM ('CLIENT', 'HOUSEHOLD');

ALTER TABLE "app"."operations_fee_request"
  ADD COLUMN "scope" "app"."OperationsFeeRequestScope" NOT NULL DEFAULT 'CLIENT',
  ADD COLUMN "legacy_household_sf_id" VARCHAR(64),
  ADD COLUMN "legacy_client_name" VARCHAR(160),
  ADD CONSTRAINT "operations_fee_request_legacy_scope_check" CHECK (
    (
      "legacy_source" IS NULL
      AND "scope" = 'CLIENT'
      AND "legacy_household_sf_id" IS NULL
      AND "legacy_client_name" IS NULL
    ) OR (
      "legacy_source" IN ('fee_store_fee_credits', 'fee_store_billing_exceptions')
      AND "legacy_client_name" IS NOT NULL
      AND length(btrim("legacy_client_name")) BETWEEN 1 AND 160
      AND (
        ("scope" = 'CLIENT' AND "legacy_household_sf_id" IS NULL)
        OR (
          "scope" = 'HOUSEHOLD'
          AND "legacy_household_sf_id" IS NOT NULL
          AND "legacy_household_sf_id" ~ '^[[:alnum:]]{15,18}$'
          AND (
            ("legacy_source" = 'fee_store_fee_credits' AND "legacy_source_id" IN ('26', '27', '31', '40'))
            OR ("legacy_source" = 'fee_store_billing_exceptions' AND "legacy_source_id" IN ('8', '11', '15', '18', '20', '24'))
          )
        )
      )
    )
  );

CREATE INDEX "operations_fee_request_legacy_household_submitted_idx"
  ON "app"."operations_fee_request"("legacy_household_sf_id", "submitted_at" DESC);

-- A reviewed household mapping is still fail-closed at the database boundary.
-- The selected client must be a canonical contact in the selected canonical
-- household, and every opaque account key must currently belong to a contact
-- in that same canonical household. Historical/closed accounts remain valid;
-- source_present is intentionally not part of this one-time archive check.
CREATE OR REPLACE FUNCTION "app"."validate_operations_fee_request_legacy_household"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
DECLARE
  household_key text;
  invalid_account_count integer;
BEGIN
  IF NEW."scope" <> 'HOUSEHOLD' THEN
    RETURN NEW;
  END IF;

  household_key := upper(left(NEW."legacy_household_sf_id", 15));

  IF NOT EXISTS (
    SELECT 1
      FROM mirror.household household
     WHERE upper(left(household.sf_id, 15)) = household_key
       AND upper(left(app.resolve_crm_canonical_household_source_key(household.sf_id), 15)) = household_key
  ) THEN
    RAISE EXCEPTION 'legacy_household_not_canonical';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM mirror.client client
     WHERE upper(left(client.sf_id, 15)) = upper(left(NEW."client_sf_id", 15))
       AND upper(left(app.resolve_crm_canonical_contact_source_key(client.sf_id), 15))
           = upper(left(NEW."client_sf_id", 15))
       AND upper(left(app.resolve_crm_canonical_household_source_key(client.household_id), 15))
           = household_key
  ) THEN
    RAISE EXCEPTION 'legacy_client_not_in_household';
  END IF;

  SELECT count(*)
    INTO invalid_account_count
    FROM unnest(NEW."account_ids") requested(account_id)
    LEFT JOIN mirror.client_account_aum account
      ON account.custodian_account_id = requested.account_id
    LEFT JOIN mirror.client owner_client
      ON upper(left(owner_client.sf_id, 15)) = upper(left(account.client_sf_id, 15))
   WHERE account.custodian_account_id IS NULL
      OR owner_client.sf_id IS NULL
      OR upper(left(app.resolve_crm_canonical_household_source_key(owner_client.household_id), 15))
         IS DISTINCT FROM household_key;

  IF invalid_account_count <> 0 THEN
    RAISE EXCEPTION 'legacy_account_not_in_household';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "app"."validate_operations_fee_request_legacy_household"()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE TRIGGER "operations_fee_request_legacy_household_guard"
BEFORE INSERT ON "app"."operations_fee_request"
FOR EACH ROW EXECUTE FUNCTION "app"."validate_operations_fee_request_legacy_household"();

-- New legacy display/scope fields are immutable with the rest of the archived
-- source payload. This small companion trigger avoids rewriting the established
-- workflow transition function.
CREATE OR REPLACE FUNCTION "app"."protect_operations_fee_request_legacy_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."legacy_household_sf_id" IS DISTINCT FROM OLD."legacy_household_sf_id"
     OR NEW."legacy_client_name" IS DISTINCT FROM OLD."legacy_client_name"
     OR NEW."scope" IS DISTINCT FROM OLD."scope" THEN
    RAISE EXCEPTION 'operations_fee_request_payload_immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "app"."protect_operations_fee_request_legacy_scope"()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE TRIGGER "operations_fee_request_legacy_scope_immutable"
BEFORE UPDATE ON "app"."operations_fee_request"
FOR EACH ROW EXECUTE FUNCTION "app"."protect_operations_fee_request_legacy_scope"();

-- The runtime role may create only ordinary live requests. The migration-owner
-- import policy remains the sole path for rows carrying Fee Store lineage.
DROP POLICY "operations_fee_request_ops_insert" ON "app"."operations_fee_request";
CREATE POLICY "operations_fee_request_ops_insert" ON "app"."operations_fee_request"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "status" = 'PENDING'
    AND "scope" = 'CLIENT'
    AND "submitted_by_role" = current_setting('app.user_role', true)
    AND NULLIF(current_setting('app.user_email', true), '') IS NOT NULL
    AND "submitted_by_email" = current_setting('app.user_email', true)
    AND "legacy_source" IS NULL
    AND "legacy_source_id" IS NULL
    AND "legacy_source_digest" IS NULL
    AND "legacy_household_sf_id" IS NULL
    AND "legacy_client_name" IS NULL
  );

COMMIT;
