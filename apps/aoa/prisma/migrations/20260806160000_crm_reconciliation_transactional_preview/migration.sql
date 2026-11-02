BEGIN;

-- Parent reconciliation normalizes authoritative Salesforce keys to their
-- first 15 characters. These indexes keep the same exact-key rule while
-- avoiding repeated full scans of every parent-bearing source during a full
-- sweep. No names, email addresses, or other business fields are indexed.
CREATE INDEX crm_parent_household_canonical_idx
  ON mirror.household (left(sf_id, 15));

CREATE INDEX crm_parent_client_canonical_idx
  ON mirror.client (left(sf_id, 15));

CREATE INDEX crm_parent_email_household_canonical_idx
  ON mirror.email (left(household_sf_id, 15))
  WHERE household_sf_id IS NOT NULL;

CREATE INDEX crm_parent_activity_household_canonical_idx
  ON mirror.activity (left(household_sf_id, 15))
  WHERE household_sf_id IS NOT NULL;

CREATE INDEX crm_parent_deal_household_canonical_idx
  ON app.deal (left(household_sf_id, 15))
  WHERE household_sf_id IS NOT NULL;

CREATE INDEX crm_parent_deal_contact_canonical_idx
  ON app.deal (left(client_sf_id, 15))
  WHERE client_sf_id IS NOT NULL;

CREATE INDEX crm_parent_transfer_household_canonical_idx
  ON app.transfer (left(household_sf_id, 15))
  WHERE household_sf_id IS NOT NULL;

CREATE INDEX crm_parent_transfer_contact_canonical_idx
  ON app.transfer (left(client_sf_id, 15))
  WHERE client_sf_id IS NOT NULL;

CREATE INDEX crm_parent_appointment_contact_canonical_idx
  ON mirror.appointment (left(client_sf_id, 15))
  WHERE client_sf_id IS NOT NULL;

-- The original preview called each phase with p_dry_run=true. That could not
-- model mappings minted by the parent phase before the child phase, and its
-- alias counter intentionally covered less work than the live insert. Run the
-- exact live functions inside a PL/pgSQL exception subtransaction instead.
-- PostgreSQL rolls back every persistent change made inside the protected
-- block while retaining the local count records for the return value.
CREATE OR REPLACE FUNCTION app.preview_crm_identity_reconciliation(
  p_run_id text
)
RETURNS TABLE (
  sources_seen bigint,
  identities_created bigint,
  mappings_created bigint,
  mappings_refreshed bigint,
  exceptions_opened bigint,
  exceptions_reopened bigint,
  exceptions_resolved bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, mirror, audit, pg_temp
AS $$
DECLARE
  v_parent record;
  v_snapshot record;
BEGIN
  BEGIN
    SELECT * INTO STRICT v_parent
      FROM app.reconcile_crm_parent_source(false);
    SELECT * INTO STRICT v_snapshot
      FROM app.reconcile_crm_identity_snapshot(p_run_id, false);

    -- This private SQLSTATE is caught immediately below. It is never returned
    -- to the application and exists only to roll back the preview savepoint.
    RAISE EXCEPTION 'CRM reconciliation preview rollback'
      USING ERRCODE = 'P3A01';
  EXCEPTION
    WHEN SQLSTATE 'P3A01' THEN
      NULL;
  END;

  RETURN QUERY SELECT
    v_parent.sources_seen + v_snapshot.sources_seen,
    v_parent.identities_created + v_snapshot.identities_created,
    v_parent.mappings_created + v_snapshot.mappings_created,
    v_parent.mappings_refreshed + v_snapshot.mappings_refreshed,
    v_snapshot.exceptions_opened,
    v_snapshot.exceptions_reopened,
    v_snapshot.exceptions_resolved;
END;
$$;

REVOKE ALL ON FUNCTION app.preview_crm_identity_reconciliation(text)
  FROM PUBLIC, app_rw, ingest_rw;
GRANT EXECUTE ON FUNCTION app.preview_crm_identity_reconciliation(text)
  TO identity_reconciler;

COMMIT;
