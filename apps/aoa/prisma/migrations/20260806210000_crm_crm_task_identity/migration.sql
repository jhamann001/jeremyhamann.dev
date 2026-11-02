-- Register mirrored CRM tasks as the eighth approved CRM source domain.
-- Only the Salesforce task ID, household parent key, and freshness timestamp
-- cross the identity_reconciler boundary. Task text remains unavailable to it.

BEGIN;

REVOKE ALL ON mirror.task FROM identity_reconciler;
GRANT SELECT (sf_id, household_sf_id, synced_at)
  ON mirror.task TO identity_reconciler;

CREATE POLICY task_identity_reconciler_read
  ON mirror.task FOR SELECT TO identity_reconciler USING (true);

-- A task mapping is visible only when the same app session can already read
-- the underlying mirror.task row through its existing role/book RLS policy.
CREATE POLICY crm_source_mapping_crm_task_app_read
  ON app.crm_source_mapping FOR SELECT TO app_rw
  USING (
    source_system = 'CRM'
    AND source_namespace = 'task'
    AND EXISTS (
      SELECT 1 FROM mirror.task t WHERE t.sf_id = source_key
    )
  );

-- Operations/Admin may resolve a household mapping through an already-visible
-- task reference. This policy exposes no task content and grants no new role.
CREATE POLICY crm_source_mapping_task_parent_reference_app_read
  ON app.crm_source_mapping FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND source_system = 'CRM'
    AND source_namespace = 'household'
    AND mapping_state = 'ACTIVE'
    AND EXISTS (
      SELECT 1 FROM mirror.task t
       WHERE t.household_sf_id = source_key
    )
  );

-- TASK already exists in the generic Phase 1 type/prefix constraint. Register
-- it in the runtime generator now that the CRM task namespace is approved.
CREATE OR REPLACE FUNCTION app.new_crm_identity_id(p_identity_type text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, app
AS $$
DECLARE
  id_prefix text;
BEGIN
  id_prefix := CASE p_identity_type
    WHEN 'HOUSEHOLD' THEN 'hld'
    WHEN 'CONTACT' THEN 'con'
    WHEN 'DEAL' THEN 'dea'
    WHEN 'TRANSFER' THEN 'xfr'
    WHEN 'TASK' THEN 'tsk'
    WHEN 'EMAIL' THEN 'eml'
    WHEN 'ACTIVITY' THEN 'act'
    WHEN 'APPOINTMENT' THEN 'apt'
    ELSE NULL
  END;

  IF id_prefix IS NULL THEN
    RAISE EXCEPTION 'CRM identity type is not registered for an approved source: %',
      p_identity_type USING ERRCODE = '22023';
  END IF;

  RETURN id_prefix || '_c' || substr(
    md5(
      clock_timestamp()::text || ':' || random()::text || ':' ||
      pg_backend_pid()::text || ':' || txid_current()::text
    ),
    1,
    24
  );
END;
$$;

REVOKE ALL ON FUNCTION app.new_crm_identity_id(text)
  FROM PUBLIC, app_rw, ingest_rw;
GRANT EXECUTE ON FUNCTION app.new_crm_identity_id(text)
  TO identity_reconciler;

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
     household_parent_key, household_parent_normalized)
  SELECT 'TASK', 'CRM', 'task', t.sf_id, t.household_sf_id, true
    FROM mirror.task t
   WHERE nullif(btrim(t.sf_id), '') IS NOT NULL;

  INSERT INTO crm_reconcile_source
    (identity_type, source_system, source_namespace, source_key,
     contact_parent_key)
  SELECT 'APPOINTMENT', 'CALENDAR', 'appointment', a.external_key, a.client_sf_id
    FROM mirror.appointment a
   WHERE nullif(btrim(a.external_key), '') IS NOT NULL;

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

COMMIT;
