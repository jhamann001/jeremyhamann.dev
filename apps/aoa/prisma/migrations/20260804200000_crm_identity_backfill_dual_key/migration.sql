-- CRM relationship layer — Phase 2A existing-data backfill and dual-key reads.
--
-- This migration is additive:
--   * existing app and mirror primary keys remain unchanged;
--   * existing routes continue to accept their original keys;
--   * CRM identities are registered only from reviewed, stable namespaces;
--   * missing exact parent links become coded exceptions, never fuzzy matches;
--   * app_rw receives SELECT only, constrained by the source record's existing
--     RLS visibility; ingest_rw remains fully denied.

BEGIN;

-- Generate a typed, CUID-shaped opaque handle. The source coordinate is never
-- embedded in the public ID. Collision safety is enforced again by the PK.
CREATE OR REPLACE FUNCTION "app"."new_crm_identity_id"(p_identity_type text)
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
    WHEN 'EMAIL' THEN 'eml'
    WHEN 'ACTIVITY' THEN 'act'
    WHEN 'APPOINTMENT' THEN 'apt'
    ELSE NULL
  END;

  IF id_prefix IS NULL THEN
    RAISE EXCEPTION 'CRM identity type is not registered for Phase 2A: %', p_identity_type
      USING ERRCODE = '22023';
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

CREATE OR REPLACE FUNCTION "app"."new_crm_internal_id"()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $$
  SELECT 'c' || substr(
    md5(
      clock_timestamp()::text || ':' || random()::text || ':' ||
      pg_backend_pid()::text || ':' || txid_current()::text
    ),
    1,
    24
  )
$$;

REVOKE ALL ON FUNCTION "app"."new_crm_identity_id"(text)
  FROM PUBLIC, app_rw, ingest_rw;
REVOKE ALL ON FUNCTION "app"."new_crm_internal_id"()
  FROM PUBLIC, app_rw, ingest_rw;

-- Owner-only, rerunnable snapshot sweep. The mirror tables intentionally have
-- FORCE RLS and no owner policy. This SECURITY DEFINER function briefly lifts
-- FORCE inside its transaction, takes AccessExclusive locks, performs only
-- reads from mirror, and restores FORCE before returning. Any error rolls the
-- DDL and all CRM inserts back together, so FORCE cannot be left disabled.
CREATE OR REPLACE FUNCTION "app"."backfill_crm_identity_snapshot"()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror, pg_temp
AS $$
BEGIN
  -- Serialize manual reruns and the migration invocation.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.crm.identity.backfill.v1', 0));

  EXECUTE 'ALTER TABLE mirror.household NO FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.client NO FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.email NO FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.activity NO FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.appointment NO FORCE ROW LEVEL SECURITY';

  -- Existing coordinates in the approved namespaces must never be silently
  -- reused for a different identity type.
  IF EXISTS (
    SELECT 1
      FROM app.crm_source_mapping m
      JOIN app.crm_identity i ON i.id = m.identity_id
     WHERE i.identity_type <> CASE
       WHEN m.source_system = 'CRM' AND m.source_namespace = 'household'
         THEN 'HOUSEHOLD'
       WHEN m.source_system = 'CRM' AND m.source_namespace = 'contact'
         THEN 'CONTACT'
       WHEN m.source_system = 'CRM' AND m.source_namespace = 'opportunity'
         THEN 'DEAL'
       WHEN m.source_system = 'CRM' AND m.source_namespace = 'email'
         THEN 'EMAIL'
       WHEN m.source_system = 'CRM' AND m.source_namespace = 'activity'
         THEN 'ACTIVITY'
       WHEN m.source_system = 'CALENDAR' AND m.source_namespace = 'appointment'
         THEN 'APPOINTMENT'
       WHEN m.source_system = 'AOA' AND m.source_namespace = 'deal'
         THEN 'DEAL'
       WHEN m.source_system = 'AOA' AND m.source_namespace = 'transfer'
         THEN 'TRANSFER'
       ELSE i.identity_type
     END
  ) THEN
    RAISE EXCEPTION 'Phase 2A found an approved source coordinate mapped to the wrong CRM identity type'
      USING ERRCODE = '23514';
  END IF;

  -- CRM households.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('HOUSEHOLD') AS identity_id,
           h.sf_id AS source_key
      FROM mirror.household h
     WHERE nullif(btrim(h.sf_id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'CRM'
            AND m.source_namespace = 'household'
            AND m.source_key = h.sf_id
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'HOUSEHOLD', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'CRM', 'household', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- CRM contacts. Retired household-as-client placeholders are excluded;
  -- a real contact with a missing household remains registered and receives a
  -- coded exception below.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('CONTACT') AS identity_id,
           c.sf_id AS source_key
      FROM mirror.client c
     WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
       AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'CRM'
            AND m.source_namespace = 'contact'
            AND m.source_key = c.sf_id
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'CONTACT', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'CRM', 'contact', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- AOA deals, including archived rows so historical deep links and audits keep
  -- a stable CRM identity. CRM opportunity IDs become secondary aliases.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('DEAL') AS identity_id,
           d.id AS source_key
      FROM app.deal d
     WHERE nullif(btrim(d.id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'AOA'
            AND m.source_namespace = 'deal'
            AND m.source_key = d.id
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'DEAL', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'AOA', 'deal', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

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
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- AOA transfers, including archived rows.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('TRANSFER') AS identity_id,
           t.id AS source_key
      FROM app.transfer t
     WHERE nullif(btrim(t.id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'AOA'
            AND m.source_namespace = 'transfer'
            AND m.source_key = t.id
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'TRANSFER', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'AOA', 'transfer', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- CRM email records.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('EMAIL') AS identity_id,
           e.sf_id AS source_key
      FROM mirror.email e
     WHERE nullif(btrim(e.sf_id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'CRM'
            AND m.source_namespace = 'email'
            AND m.source_key = e.sf_id
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'EMAIL', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'CRM', 'email', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- CRM activity records.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('ACTIVITY') AS identity_id,
           a.sf_id AS source_key
      FROM mirror.activity a
     WHERE nullif(btrim(a.sf_id), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'CRM'
            AND m.source_namespace = 'activity'
            AND m.source_key = a.sf_id
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'ACTIVITY', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'CRM', 'activity', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- Calendar/appointment-feed records. external_key already includes its
  -- concrete source scope, so CALENDAR/appointment remains replay-safe.
  WITH missing AS MATERIALIZED (
    SELECT app.new_crm_identity_id('APPOINTMENT') AS identity_id,
           a.external_key AS source_key
      FROM mirror.appointment a
     WHERE nullif(btrim(a.external_key), '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app.crm_source_mapping m
          WHERE m.source_system = 'CALENDAR'
            AND m.source_namespace = 'appointment'
            AND m.source_key = a.external_key
       )
  ), created AS (
    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, 'APPOINTMENT', 'ACTIVE', 1, now()
      FROM missing
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  INSERT INTO app.crm_source_mapping
    (id, identity_id, source_system, source_namespace, source_key, updated_at)
  SELECT app.new_crm_internal_id(), m.identity_id,
         'CALENDAR', 'appointment', m.source_key, now()
    FROM missing m
    JOIN created c ON c.id = m.identity_id
  ON CONFLICT (source_system, source_namespace, source_key) DO NOTHING;

  -- A CRM alias may not silently point at a different identity than the
  -- corresponding AOA deal alias.
  IF EXISTS (
    SELECT 1
      FROM app.deal d
      JOIN app.crm_source_mapping aoa_map
        ON aoa_map.source_system = 'AOA'
       AND aoa_map.source_namespace = 'deal'
       AND aoa_map.source_key = d.id
      JOIN app.crm_source_mapping crm_map
        ON crm_map.source_system = 'CRM'
       AND crm_map.source_namespace = 'opportunity'
       AND crm_map.source_key = d.sf_deal_id
     WHERE d.sf_deal_id IS NOT NULL
       AND aoa_map.identity_id <> crm_map.identity_id
  ) THEN
    RAISE EXCEPTION 'A CRM opportunity alias conflicts with its AOA deal identity'
      USING ERRCODE = '23514';
  END IF;

  -- Exact-key parent coverage. These rows carry no free text; the future Ops
  -- explorer can show which source records need review without copying PII into
  -- the exception table or audit log.
  INSERT INTO app.crm_identity_exception
    (id, source_mapping_id, reason_code, exception_state, updated_at)
  SELECT app.new_crm_internal_id(), child_map.id,
         'MISSING_PARENT_MAPPING', 'OPEN', now()
    FROM mirror.client c
    JOIN app.crm_source_mapping child_map
      ON child_map.source_system = 'CRM'
     AND child_map.source_namespace = 'contact'
     AND child_map.source_key = c.sf_id
   WHERE c.household_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM app.crm_source_mapping parent_map
         WHERE parent_map.source_system = 'CRM'
           AND parent_map.source_namespace = 'household'
           AND parent_map.source_key = c.household_id
           AND parent_map.mapping_state = 'ACTIVE'
      )
  ON CONFLICT (source_mapping_id, reason_code) DO NOTHING;

  INSERT INTO app.crm_identity_exception
    (id, source_mapping_id, reason_code, exception_state, updated_at)
  SELECT app.new_crm_internal_id(), record_map.id,
         'MISSING_PARENT_MAPPING', 'OPEN', now()
    FROM mirror.email e
    JOIN app.crm_source_mapping record_map
      ON record_map.source_system = 'CRM'
     AND record_map.source_namespace = 'email'
     AND record_map.source_key = e.sf_id
   WHERE NOT EXISTS (
     SELECT 1 FROM app.crm_source_mapping parent_map
      WHERE parent_map.source_system = 'CRM'
        AND parent_map.source_namespace = 'household'
        AND left(parent_map.source_key, 15) = left(e.household_sf_id, 15)
        AND parent_map.mapping_state = 'ACTIVE'
   )
  ON CONFLICT (source_mapping_id, reason_code) DO NOTHING;

  INSERT INTO app.crm_identity_exception
    (id, source_mapping_id, reason_code, exception_state, updated_at)
  SELECT app.new_crm_internal_id(), record_map.id,
         'MISSING_PARENT_MAPPING', 'OPEN', now()
    FROM mirror.activity a
    JOIN app.crm_source_mapping record_map
      ON record_map.source_system = 'CRM'
     AND record_map.source_namespace = 'activity'
     AND record_map.source_key = a.sf_id
   WHERE NOT EXISTS (
     SELECT 1 FROM app.crm_source_mapping parent_map
      WHERE parent_map.source_system = 'CRM'
        AND parent_map.source_namespace = 'household'
        AND left(parent_map.source_key, 15) = left(a.household_sf_id, 15)
        AND parent_map.mapping_state = 'ACTIVE'
   )
  ON CONFLICT (source_mapping_id, reason_code) DO NOTHING;

  INSERT INTO app.crm_identity_exception
    (id, source_mapping_id, reason_code, exception_state, updated_at)
  SELECT app.new_crm_internal_id(), record_map.id,
         'MISSING_PARENT_MAPPING', 'OPEN', now()
    FROM mirror.appointment a
    JOIN app.crm_source_mapping record_map
      ON record_map.source_system = 'CALENDAR'
     AND record_map.source_namespace = 'appointment'
     AND record_map.source_key = a.external_key
   WHERE a.client_sf_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM app.crm_source_mapping parent_map
         WHERE parent_map.source_system = 'CRM'
           AND parent_map.source_namespace = 'contact'
           AND parent_map.source_key = a.client_sf_id
           AND parent_map.mapping_state = 'ACTIVE'
      )
  ON CONFLICT (source_mapping_id, reason_code) DO NOTHING;

  INSERT INTO app.crm_identity_exception
    (id, source_mapping_id, reason_code, exception_state, updated_at)
  SELECT app.new_crm_internal_id(), record_map.id,
         'MISSING_PARENT_MAPPING', 'OPEN', now()
    FROM app.deal d
    JOIN app.crm_source_mapping record_map
      ON record_map.source_system = 'AOA'
     AND record_map.source_namespace = 'deal'
     AND record_map.source_key = d.id
   WHERE NOT EXISTS (
           SELECT 1 FROM app.crm_source_mapping household_map
            WHERE household_map.source_system = 'CRM'
              AND household_map.source_namespace = 'household'
              AND d.household_sf_id IS NOT NULL
              AND left(household_map.source_key, 15) = left(d.household_sf_id, 15)
              AND household_map.mapping_state = 'ACTIVE'
         )
     AND NOT EXISTS (
           SELECT 1 FROM app.crm_source_mapping contact_map
            WHERE contact_map.source_system = 'CRM'
              AND contact_map.source_namespace = 'contact'
              AND d.client_sf_id IS NOT NULL
              AND contact_map.source_key = d.client_sf_id
              AND contact_map.mapping_state = 'ACTIVE'
         )
  ON CONFLICT (source_mapping_id, reason_code) DO NOTHING;

  INSERT INTO app.crm_identity_exception
    (id, source_mapping_id, reason_code, exception_state, updated_at)
  SELECT app.new_crm_internal_id(), record_map.id,
         'MISSING_PARENT_MAPPING', 'OPEN', now()
    FROM app.transfer t
    JOIN app.crm_source_mapping record_map
      ON record_map.source_system = 'AOA'
     AND record_map.source_namespace = 'transfer'
     AND record_map.source_key = t.id
   WHERE NOT EXISTS (
           SELECT 1 FROM app.crm_source_mapping household_map
            WHERE household_map.source_system = 'CRM'
              AND household_map.source_namespace = 'household'
              AND t.household_sf_id IS NOT NULL
              AND left(household_map.source_key, 15) = left(t.household_sf_id, 15)
              AND household_map.mapping_state = 'ACTIVE'
         )
     AND NOT EXISTS (
           SELECT 1 FROM app.crm_source_mapping contact_map
            WHERE contact_map.source_system = 'CRM'
              AND contact_map.source_namespace = 'contact'
              AND t.client_sf_id IS NOT NULL
              AND contact_map.source_key = t.client_sf_id
              AND contact_map.mapping_state = 'ACTIVE'
         )
  ON CONFLICT (source_mapping_id, reason_code) DO NOTHING;

  EXECUTE 'ALTER TABLE mirror.appointment FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.activity FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.email FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.client FORCE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE mirror.household FORCE ROW LEVEL SECURITY';
END;
$$;

REVOKE ALL ON FUNCTION "app"."backfill_crm_identity_snapshot"()
  FROM PUBLIC, app_rw, ingest_rw;

-- Run the first snapshot as part of the migration. A failed backfill fails the
-- migration atomically; a later owner-only rerun adds only missing coordinates.
SELECT "app"."backfill_crm_identity_snapshot"();

-- Runtime remains read-only and fail-closed. A mapping is visible only when the
-- same app_rw session can see its underlying source row under existing RLS.
GRANT SELECT ON "app"."crm_identity" TO app_rw;
GRANT SELECT ON "app"."crm_source_mapping" TO app_rw;
GRANT SELECT ON "app"."crm_identity_exception" TO app_rw;
REVOKE INSERT, UPDATE, DELETE ON "app"."crm_identity" FROM app_rw, ingest_rw;
REVOKE INSERT, UPDATE, DELETE ON "app"."crm_source_mapping" FROM app_rw, ingest_rw;
REVOKE INSERT, UPDATE, DELETE ON "app"."crm_identity_exception" FROM app_rw, ingest_rw;

CREATE POLICY crm_source_mapping_app_read
  ON "app"."crm_source_mapping"
  FOR SELECT TO app_rw
  USING (
    (
      source_system = 'CRM' AND source_namespace = 'household'
      AND EXISTS (SELECT 1 FROM mirror.household h WHERE h.sf_id = source_key)
    ) OR (
      source_system = 'CRM' AND source_namespace = 'contact'
      AND EXISTS (SELECT 1 FROM mirror.client c WHERE c.sf_id = source_key)
    ) OR (
      source_system = 'CRM' AND source_namespace = 'email'
      AND EXISTS (SELECT 1 FROM mirror.email e WHERE e.sf_id = source_key)
    ) OR (
      source_system = 'CRM' AND source_namespace = 'activity'
      AND EXISTS (SELECT 1 FROM mirror.activity a WHERE a.sf_id = source_key)
    ) OR (
      source_system = 'CALENDAR' AND source_namespace = 'appointment'
      AND EXISTS (
        SELECT 1 FROM mirror.appointment a WHERE a.external_key = source_key
      )
    ) OR (
      source_system = 'AOA' AND source_namespace = 'deal'
      AND EXISTS (SELECT 1 FROM app.deal d WHERE d.id = source_key)
    ) OR (
      source_system = 'CRM' AND source_namespace = 'opportunity'
      AND EXISTS (SELECT 1 FROM app.deal d WHERE d.sf_deal_id = source_key)
    ) OR (
      source_system = 'AOA' AND source_namespace = 'transfer'
      AND EXISTS (SELECT 1 FROM app.transfer t WHERE t.id = source_key)
    )
  );

CREATE POLICY crm_identity_app_read
  ON "app"."crm_identity"
  FOR SELECT TO app_rw
  USING (
    EXISTS (
      SELECT 1
        FROM app.crm_source_mapping m
       WHERE m.identity_id = crm_identity.id
    )
  );

-- The exception queue is operational metadata. Advisors, Client Service, and
-- Viewer users can resolve visible records but cannot inspect exception state.
CREATE POLICY crm_identity_exception_ops_read
  ON "app"."crm_identity_exception"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND EXISTS (
      SELECT 1
        FROM app.crm_source_mapping m
       WHERE m.id = source_mapping_id
    )
  );

COMMIT;
