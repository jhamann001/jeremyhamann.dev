-- CRM relationship layer — Phase 3A continuous identity reconciliation.
--
-- The reconciler is deliberately separate from both human app_rw sessions and
-- mirror-owning ingest_rw writes. It sees only reviewed source-key/link columns,
-- mints identities for newly-arriving records, and re-evaluates exact-key parent
-- exceptions. It never guesses from names, email addresses, or similarity.

BEGIN;

-- Cloud SQL login users are infrastructure, not migration, resources. Local
-- Postgres creates the role for repeatable integration tests; Cloud SQL fails
-- closed when Terraform has not provisioned the login before this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_reconciler') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
      RAISE EXCEPTION 'identity_reconciler must be provisioned before CRM Phase 3A';
    END IF;
    CREATE ROLE identity_reconciler LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app, mirror, audit TO identity_reconciler;

-- Approved source coordinates only. No display names, email addresses, message
-- bodies, notes, values, or account numbers are granted to this machine role.
GRANT SELECT (sf_id, synced_at)
  ON mirror.household TO identity_reconciler;
GRANT SELECT (sf_id, household_id, synced_at)
  ON mirror.client TO identity_reconciler;
GRANT SELECT (sf_id, household_sf_id, synced_at)
  ON mirror.email TO identity_reconciler;
GRANT SELECT (sf_id, household_sf_id, synced_at)
  ON mirror.activity TO identity_reconciler;
GRANT SELECT (external_key, client_sf_id, synced_at)
  ON mirror.appointment TO identity_reconciler;
GRANT SELECT (id, sf_deal_id, household_sf_id, client_sf_id, updated_at)
  ON app.deal TO identity_reconciler;
GRANT SELECT (id, household_sf_id, client_sf_id, updated_at)
  ON app.transfer TO identity_reconciler;

-- Registry writes are column-scoped. DELETE, merge/lifecycle mutation, source
-- re-keying, and identity reassignment remain structurally unavailable.
GRANT SELECT ON app.crm_identity TO identity_reconciler;
GRANT INSERT (id, identity_type, lifecycle_state, contract_version, updated_at)
  ON app.crm_identity TO identity_reconciler;

GRANT SELECT ON app.crm_source_mapping TO identity_reconciler;
GRANT INSERT
  (id, identity_id, source_system, source_namespace, source_key, updated_at)
  ON app.crm_source_mapping TO identity_reconciler;
GRANT UPDATE (last_seen_at, updated_at)
  ON app.crm_source_mapping TO identity_reconciler;

GRANT SELECT ON app.crm_identity_exception TO identity_reconciler;
GRANT INSERT
  (id, source_mapping_id, reason_code, exception_state, updated_at)
  ON app.crm_identity_exception TO identity_reconciler;
GRANT UPDATE
  (exception_state, resolution_code, detected_at, resolved_at, updated_at)
  ON app.crm_identity_exception TO identity_reconciler;

-- Counts-only business-run audit. The role never receives SELECT, UPDATE, or
-- DELETE on the append-only log.
GRANT INSERT ON audit."AuditLog" TO identity_reconciler;
GRANT USAGE, SELECT ON SEQUENCE audit."AuditLog_id_seq" TO identity_reconciler;

-- The generator functions expose no source data and are the only executable
-- CRM functions available to the role besides the bounded reconciler below.
GRANT EXECUTE ON FUNCTION app.new_crm_identity_id(text) TO identity_reconciler;
GRANT EXECUTE ON FUNCTION app.new_crm_internal_id() TO identity_reconciler;

-- Machine RLS policies. These do not use or fabricate human user GUCs and do
-- not broaden any app_rw policy.
CREATE POLICY household_identity_reconciler_read
  ON mirror.household FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY client_identity_reconciler_read
  ON mirror.client FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY email_identity_reconciler_read
  ON mirror.email FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY activity_identity_reconciler_read
  ON mirror.activity FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY appointment_identity_reconciler_read
  ON mirror.appointment FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY deal_identity_reconciler_read
  ON app.deal FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY transfer_identity_reconciler_read
  ON app.transfer FOR SELECT TO identity_reconciler USING (true);

CREATE POLICY crm_identity_reconciler_read
  ON app.crm_identity FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY crm_identity_reconciler_insert
  ON app.crm_identity FOR INSERT TO identity_reconciler WITH CHECK (
    lifecycle_state = 'ACTIVE' AND merged_into_id IS NULL AND contract_version = 1
  );

CREATE POLICY crm_source_mapping_reconciler_read
  ON app.crm_source_mapping FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY crm_source_mapping_reconciler_insert
  ON app.crm_source_mapping FOR INSERT TO identity_reconciler WITH CHECK (
    mapping_state = 'ACTIVE' AND superseded_at IS NULL
  );
CREATE POLICY crm_source_mapping_reconciler_refresh
  ON app.crm_source_mapping FOR UPDATE TO identity_reconciler
  USING (mapping_state = 'ACTIVE')
  WITH CHECK (mapping_state = 'ACTIVE' AND superseded_at IS NULL);

CREATE POLICY crm_identity_exception_reconciler_read
  ON app.crm_identity_exception FOR SELECT TO identity_reconciler USING (true);
CREATE POLICY crm_identity_exception_reconciler_insert
  ON app.crm_identity_exception FOR INSERT TO identity_reconciler WITH CHECK (
    reason_code = 'MISSING_PARENT_MAPPING'
    AND exception_state = 'OPEN'
    AND resolution_code IS NULL
    AND resolved_at IS NULL
  );
CREATE POLICY crm_identity_exception_reconciler_update
  ON app.crm_identity_exception FOR UPDATE TO identity_reconciler
  USING (reason_code = 'MISSING_PARENT_MAPPING')
  WITH CHECK (
    reason_code = 'MISSING_PARENT_MAPPING'
    AND (
      (exception_state = 'OPEN' AND resolution_code IS NULL AND resolved_at IS NULL)
      OR
      (exception_state = 'RESOLVED' AND resolution_code = 'PARENT_MAPPED'
       AND resolved_at IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION app.reconcile_crm_identity_snapshot(
  p_run_id text,
  p_dry_run boolean DEFAULT false
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
  v_identities_created bigint := 0;
  v_primary_mappings_created bigint := 0;
  v_alias_mappings_created bigint := 0;
  v_mappings_refreshed bigint := 0;
  v_exceptions_opened bigint := 0;
  v_exceptions_reopened bigint := 0;
  v_exceptions_resolved bigint := 0;
BEGIN
  IF p_run_id IS NULL OR p_run_id !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'Invalid CRM reconciliation run id' USING ERRCODE = '22023';
  END IF;

  -- One full sweep at a time. The lock is transaction-scoped and releases on
  -- success, rollback, or a killed worker.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.crm.identity.reconcile.v1', 0));

  CREATE TEMP TABLE crm_reconcile_source (
    identity_type text NOT NULL,
    source_system text NOT NULL,
    source_namespace text NOT NULL,
    source_key text NOT NULL,
    household_parent_key text,
    household_parent_normalized boolean NOT NULL DEFAULT false,
    contact_parent_key text,
    identity_id text,
    PRIMARY KEY (source_system, source_namespace, source_key)
  ) ON COMMIT DROP;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key)
  SELECT 'HOUSEHOLD', 'CRM', 'household', h.sf_id
    FROM mirror.household h
   WHERE nullif(btrim(h.sf_id), '') IS NOT NULL;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     household_parent_key)
  SELECT 'CONTACT', 'CRM', 'contact', c.sf_id, c.household_id
    FROM mirror.client c
   WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
     AND (c.household_id IS NULL OR c.sf_id <> c.household_id);

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     household_parent_key, household_parent_normalized, contact_parent_key)
  SELECT 'DEAL', 'AOA', 'deal', d.id,
         d.household_sf_id, true, d.client_sf_id
    FROM app.deal d
   WHERE nullif(btrim(d.id), '') IS NOT NULL;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     household_parent_key, household_parent_normalized, contact_parent_key)
  SELECT 'TRANSFER', 'AOA', 'transfer', t.id,
         t.household_sf_id, true, t.client_sf_id
    FROM app.transfer t
   WHERE nullif(btrim(t.id), '') IS NOT NULL;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     household_parent_key, household_parent_normalized)
  SELECT 'EMAIL', 'CRM', 'email', e.sf_id, e.household_sf_id, true
    FROM mirror.email e
   WHERE nullif(btrim(e.sf_id), '') IS NOT NULL;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     household_parent_key, household_parent_normalized)
  SELECT 'ACTIVITY', 'CRM', 'activity', a.sf_id, a.household_sf_id, true
    FROM mirror.activity a
   WHERE nullif(btrim(a.sf_id), '') IS NOT NULL;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     contact_parent_key)
  SELECT 'APPOINTMENT', 'CALENDAR', 'appointment', a.external_key, a.client_sf_id
    FROM mirror.appointment a
   WHERE nullif(btrim(a.external_key), '') IS NOT NULL;

  -- An approved coordinate can never silently change entity type.
  IF EXISTS (
    SELECT 1
      FROM crm_reconcile_source s
      JOIN app.crm_source_mapping m
        ON m.source_system = s.source_system
       AND m.source_namespace = s.source_namespace
       AND m.source_key = s.source_key
      JOIN app.crm_identity i ON i.id = m.identity_id
     WHERE i.identity_type <> s.identity_type
  ) THEN
    RAISE EXCEPTION 'CRM reconciliation found a source coordinate type conflict'
      USING ERRCODE = '23514';
  END IF;

  UPDATE crm_reconcile_source s
     SET identity_id = m.identity_id
    FROM app.crm_source_mapping m
   WHERE m.source_system = s.source_system
     AND m.source_namespace = s.source_namespace
     AND m.source_key = s.source_key;

  IF p_dry_run THEN
    SELECT count(*)::bigint
      INTO v_identities_created
      FROM crm_reconcile_source WHERE identity_id IS NULL;

    SELECT count(*)::bigint
      INTO v_primary_mappings_created
      FROM crm_reconcile_source WHERE identity_id IS NULL;

    SELECT count(*)::bigint
      INTO v_alias_mappings_created
      FROM app.deal d
     WHERE nullif(btrim(d.sf_deal_id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'CRM'
            AND m.source_namespace = 'opportunity'
            AND m.source_key = d.sf_deal_id
       );
  ELSE
    UPDATE crm_reconcile_source
       SET identity_id = app.new_crm_identity_id(identity_type)
     WHERE identity_id IS NULL;

    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT s.identity_id, s.identity_type, 'ACTIVE', 1, now()
      FROM crm_reconcile_source s
     WHERE NOT EXISTS (
       SELECT 1 FROM app.crm_source_mapping m
        WHERE m.source_system = s.source_system
          AND m.source_namespace = s.source_namespace
          AND m.source_key = s.source_key
     );
    GET DIAGNOSTICS v_identities_created = ROW_COUNT;

    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    SELECT app.new_crm_internal_id(), s.identity_id,
           s.source_system, s.source_namespace, s.source_key, now()
      FROM crm_reconcile_source s
     WHERE NOT EXISTS (
       SELECT 1 FROM app.crm_source_mapping m
        WHERE m.source_system = s.source_system
          AND m.source_namespace = s.source_namespace
          AND m.source_key = s.source_key
     );
    GET DIAGNOSTICS v_primary_mappings_created = ROW_COUNT;

    -- A CRM opportunity is an alias of its AOA deal, never a second deal.
    IF EXISTS (
      SELECT 1
        FROM app.deal d
        JOIN app.crm_source_mapping primary_map
          ON primary_map.source_system = 'AOA'
         AND primary_map.source_namespace = 'deal'
         AND primary_map.source_key = d.id
        JOIN app.crm_source_mapping alias_map
          ON alias_map.source_system = 'CRM'
         AND alias_map.source_namespace = 'opportunity'
         AND alias_map.source_key = d.sf_deal_id
       WHERE d.sf_deal_id IS NOT NULL
         AND primary_map.identity_id <> alias_map.identity_id
    ) THEN
      RAISE EXCEPTION 'CRM reconciliation found a deal alias conflict'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    SELECT app.new_crm_internal_id(), primary_map.identity_id,
           'CRM', 'opportunity', d.sf_deal_id, now()
      FROM app.deal d
      JOIN app.crm_source_mapping primary_map
        ON primary_map.source_system = 'AOA'
       AND primary_map.source_namespace = 'deal'
       AND primary_map.source_key = d.id
     WHERE nullif(btrim(d.sf_deal_id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping alias_map
          WHERE alias_map.source_system = 'CRM'
            AND alias_map.source_namespace = 'opportunity'
            AND alias_map.source_key = d.sf_deal_id
       );
    GET DIAGNOSTICS v_alias_mappings_created = ROW_COUNT;

    UPDATE app.crm_source_mapping m
       SET last_seen_at = now(), updated_at = now()
      FROM crm_reconcile_source s
     WHERE m.source_system = s.source_system
       AND m.source_namespace = s.source_namespace
       AND m.source_key = s.source_key
       AND m.mapping_state = 'ACTIVE';
    GET DIAGNOSTICS v_mappings_refreshed = ROW_COUNT;

    UPDATE app.crm_source_mapping m
       SET last_seen_at = now(), updated_at = now()
      FROM app.deal d
     WHERE m.source_system = 'CRM'
       AND m.source_namespace = 'opportunity'
       AND m.source_key = d.sf_deal_id
       AND nullif(btrim(d.sf_deal_id), '') IS NOT NULL
       AND m.mapping_state = 'ACTIVE';
  END IF;

  CREATE TEMP TABLE crm_reconcile_parent_state ON COMMIT DROP AS
  SELECT s.source_system, s.source_namespace, s.source_key,
         (
           (
             nullif(btrim(s.household_parent_key), '') IS NOT NULL
             AND (
               EXISTS (
                 SELECT 1 FROM app.crm_source_mapping hm
                  WHERE hm.source_system = 'CRM'
                    AND hm.source_namespace = 'household'
                    AND hm.mapping_state = 'ACTIVE'
                    AND (
                      (s.household_parent_normalized
                       AND left(hm.source_key, 15) = left(s.household_parent_key, 15))
                      OR
                      (NOT s.household_parent_normalized
                       AND hm.source_key = s.household_parent_key)
                    )
               )
               OR EXISTS (
                 SELECT 1 FROM mirror.household h
                  WHERE (
                    (s.household_parent_normalized
                     AND left(h.sf_id, 15) = left(s.household_parent_key, 15))
                    OR
                    (NOT s.household_parent_normalized
                     AND h.sf_id = s.household_parent_key)
                  )
               )
             )
           )
           OR
           (
             nullif(btrim(s.contact_parent_key), '') IS NOT NULL
             AND (
               EXISTS (
                 SELECT 1 FROM app.crm_source_mapping cm
                  WHERE cm.source_system = 'CRM'
                    AND cm.source_namespace = 'contact'
                    AND cm.source_key = s.contact_parent_key
                    AND cm.mapping_state = 'ACTIVE'
               )
               OR EXISTS (
                 SELECT 1 FROM mirror.client c
                  WHERE c.sf_id = s.contact_parent_key
                    AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
               )
             )
           )
         ) AS parent_resolved
    FROM crm_reconcile_source s
   WHERE s.identity_type <> 'HOUSEHOLD';

  IF p_dry_run THEN
    SELECT count(*)::bigint INTO v_exceptions_opened
      FROM crm_reconcile_parent_state p
      LEFT JOIN app.crm_source_mapping m
        ON m.source_system = p.source_system
       AND m.source_namespace = p.source_namespace
       AND m.source_key = p.source_key
      LEFT JOIN app.crm_identity_exception e
        ON e.source_mapping_id = m.id
       AND e.reason_code = 'MISSING_PARENT_MAPPING'
     WHERE NOT p.parent_resolved AND e.id IS NULL;

    SELECT count(*)::bigint INTO v_exceptions_reopened
      FROM crm_reconcile_parent_state p
      JOIN app.crm_source_mapping m
        ON m.source_system = p.source_system
       AND m.source_namespace = p.source_namespace
       AND m.source_key = p.source_key
      JOIN app.crm_identity_exception e
        ON e.source_mapping_id = m.id
       AND e.reason_code = 'MISSING_PARENT_MAPPING'
     WHERE NOT p.parent_resolved AND e.exception_state = 'RESOLVED';

    SELECT count(*)::bigint INTO v_exceptions_resolved
      FROM crm_reconcile_parent_state p
      JOIN app.crm_source_mapping m
        ON m.source_system = p.source_system
       AND m.source_namespace = p.source_namespace
       AND m.source_key = p.source_key
      JOIN app.crm_identity_exception e
        ON e.source_mapping_id = m.id
       AND e.reason_code = 'MISSING_PARENT_MAPPING'
     WHERE p.parent_resolved AND e.exception_state = 'OPEN';
  ELSE
    INSERT INTO app.crm_identity_exception
      (id, source_mapping_id, reason_code, exception_state, updated_at)
    SELECT app.new_crm_internal_id(), m.id,
           'MISSING_PARENT_MAPPING', 'OPEN', now()
      FROM crm_reconcile_parent_state p
      JOIN app.crm_source_mapping m
        ON m.source_system = p.source_system
       AND m.source_namespace = p.source_namespace
       AND m.source_key = p.source_key
     WHERE NOT p.parent_resolved
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_identity_exception e
          WHERE e.source_mapping_id = m.id
            AND e.reason_code = 'MISSING_PARENT_MAPPING'
       );
    GET DIAGNOSTICS v_exceptions_opened = ROW_COUNT;

    UPDATE app.crm_identity_exception e
       SET exception_state = 'OPEN', resolution_code = NULL,
           detected_at = now(), resolved_at = NULL, updated_at = now()
      FROM app.crm_source_mapping m
      JOIN crm_reconcile_parent_state p
        ON p.source_system = m.source_system
       AND p.source_namespace = m.source_namespace
       AND p.source_key = m.source_key
     WHERE e.source_mapping_id = m.id
       AND e.reason_code = 'MISSING_PARENT_MAPPING'
       AND e.exception_state = 'RESOLVED'
       AND NOT p.parent_resolved;
    GET DIAGNOSTICS v_exceptions_reopened = ROW_COUNT;

    UPDATE app.crm_identity_exception e
       SET exception_state = 'RESOLVED', resolution_code = 'PARENT_MAPPED',
           resolved_at = now(), updated_at = now()
      FROM app.crm_source_mapping m
      JOIN crm_reconcile_parent_state p
        ON p.source_system = m.source_system
       AND p.source_namespace = m.source_namespace
       AND p.source_key = m.source_key
     WHERE e.source_mapping_id = m.id
       AND e.reason_code = 'MISSING_PARENT_MAPPING'
       AND e.exception_state = 'OPEN'
       AND p.parent_resolved;
    GET DIAGNOSTICS v_exceptions_resolved = ROW_COUNT;

    INSERT INTO audit."AuditLog"
      ("actorRole", "action", "entityType", "entityId", "detail")
    VALUES (
      'IDENTITY_RECONCILER',
      'crm.identity.reconcile',
      'crm_reconciliation_run',
      p_run_id,
      jsonb_build_object(
        'sources_seen', (SELECT count(*) FROM crm_reconcile_source),
        'identities_created', v_identities_created,
        'mappings_created', v_primary_mappings_created + v_alias_mappings_created,
        'mappings_refreshed', v_mappings_refreshed,
        'exceptions_opened', v_exceptions_opened,
        'exceptions_reopened', v_exceptions_reopened,
        'exceptions_resolved', v_exceptions_resolved
      )::text
    );
  END IF;

  RETURN QUERY SELECT
    (SELECT count(*)::bigint FROM crm_reconcile_source),
    v_identities_created,
    v_primary_mappings_created + v_alias_mappings_created,
    CASE WHEN p_dry_run THEN 0::bigint ELSE v_mappings_refreshed END,
    v_exceptions_opened,
    v_exceptions_reopened,
    v_exceptions_resolved;
END;
$$;

REVOKE ALL ON FUNCTION app.reconcile_crm_identity_snapshot(text, boolean)
  FROM PUBLIC, app_rw, ingest_rw;
GRANT EXECUTE ON FUNCTION app.reconcile_crm_identity_snapshot(text, boolean)
  TO identity_reconciler;

-- Belt-and-suspenders: the machine role never hard-deletes anything and cannot
-- invoke the owner-only Phase 2A backfill.
REVOKE DELETE ON app.crm_identity, app.crm_source_mapping,
  app.crm_identity_exception FROM identity_reconciler;
REVOKE ALL ON FUNCTION app.backfill_crm_identity_snapshot()
  FROM identity_reconciler;

COMMIT;
