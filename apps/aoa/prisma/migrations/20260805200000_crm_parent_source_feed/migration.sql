-- CRM relationship layer — key-only CRM Account/Contact parent feed.
--
-- The existing clients report creates full mirror.household/mirror.client rows,
-- but it does not cover every historical AccountId/ContactId referenced by
-- emails, activities, deals, transfers, and appointments. This table records
-- only authoritative Salesforce keys. It deliberately stores no names, email
-- addresses, stages, notes, values, or other business content.

BEGIN;

CREATE TABLE mirror.crm_parent_source (
  parent_type text NOT NULL,
  source_key text NOT NULL,
  normalized_key text GENERATED ALWAYS AS (left(source_key, 15)) STORED,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_type, normalized_key),
  CONSTRAINT crm_parent_source_type_check
    CHECK (parent_type IN ('HOUSEHOLD', 'CONTACT')),
  CONSTRAINT crm_parent_source_key_check
    CHECK (
      (parent_type = 'HOUSEHOLD'
       AND source_key ~ '^001[[:alnum:]]{12}([[:alnum:]]{3})?$')
      OR
      (parent_type = 'CONTACT'
       AND source_key ~ '^003[[:alnum:]]{12}([[:alnum:]]{3})?$')
    )
);

-- Ingest can batch-upsert keys but cannot delete them. A source replay may
-- refresh the exact 15/18-character representation for the same canonical key.
-- Revoke schema-wide default grants inherited from the original mirror setup
-- before applying the narrower table contract below.
REVOKE ALL ON mirror.crm_parent_source
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT SELECT ON mirror.crm_parent_source TO ingest_rw;
GRANT INSERT (parent_type, source_key, synced_at)
  ON mirror.crm_parent_source TO ingest_rw;
GRANT UPDATE (source_key, synced_at)
  ON mirror.crm_parent_source TO ingest_rw;

-- The reconciler receives only key/type/freshness columns. app_rw receives no
-- direct table grant; UI visibility continues to flow through visible children.
GRANT SELECT (parent_type, source_key, normalized_key, synced_at)
  ON mirror.crm_parent_source TO identity_reconciler;

ALTER TABLE mirror.crm_parent_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.crm_parent_source FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_parent_source_ingest_read
  ON mirror.crm_parent_source FOR SELECT TO ingest_rw USING (true);
CREATE POLICY crm_parent_source_ingest_insert
  ON mirror.crm_parent_source FOR INSERT TO ingest_rw WITH CHECK (true);
CREATE POLICY crm_parent_source_ingest_update
  ON mirror.crm_parent_source FOR UPDATE TO ingest_rw
  USING (true) WITH CHECK (true);
CREATE POLICY crm_parent_source_reconciler_read
  ON mirror.crm_parent_source FOR SELECT TO identity_reconciler USING (true);

-- Parent-reference visibility uses exact equality so the existing child-key
-- indexes remain usable. Appointments did not previously need this lookup.
CREATE INDEX appointment_client_sf_id_idx
  ON mirror.appointment (client_sf_id)
  WHERE client_sf_id IS NOT NULL;

-- Mint or reuse parent identities in one bounded, serialized pass. This helper
-- is invoked in the same transaction immediately before the existing seven-
-- domain reconciliation function. Exact source keys and their 15-character
-- aliases point to one identity, preventing width changes from minting twins.
CREATE OR REPLACE FUNCTION app.reconcile_crm_parent_source(
  p_dry_run boolean DEFAULT false
)
RETURNS TABLE (
  sources_seen bigint,
  identities_created bigint,
  mappings_created bigint,
  mappings_refreshed bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app, mirror, pg_temp
AS $$
DECLARE
  v_sources_seen bigint := 0;
  v_identities_created bigint := 0;
  v_mappings_created bigint := 0;
  v_mappings_refreshed bigint := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('app.crm.identity.reconcile.v1', 0));

  CREATE TEMP TABLE crm_parent_source_snapshot (
    parent_type text NOT NULL,
    source_namespace text NOT NULL,
    source_key text NOT NULL,
    normalized_key text NOT NULL,
    mirror_present boolean NOT NULL,
    identity_id text,
    is_new boolean NOT NULL DEFAULT false,
    PRIMARY KEY (parent_type, normalized_key)
  ) ON COMMIT DROP;

  INSERT INTO crm_parent_source_snapshot
    (parent_type, source_namespace, source_key, normalized_key, mirror_present)
  SELECT p.parent_type,
         CASE p.parent_type WHEN 'HOUSEHOLD' THEN 'household' ELSE 'contact' END,
         p.source_key,
         p.normalized_key,
         CASE p.parent_type
           WHEN 'HOUSEHOLD' THEN EXISTS (
             SELECT 1 FROM mirror.household h
              WHERE left(h.sf_id, 15) = p.normalized_key
           )
           ELSE EXISTS (
             SELECT 1 FROM mirror.client c
              WHERE left(c.sf_id, 15) = p.normalized_key
                AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
           )
         END
    FROM mirror.crm_parent_source p;

  -- A canonical Salesforce key cannot change CRM type, even if its exact
  -- 15/18-character representation changed between source runs.
  IF EXISTS (
    SELECT 1
      FROM crm_parent_source_snapshot p
      JOIN app.crm_source_mapping m
        ON m.source_system = 'CRM'
       AND m.source_namespace = p.source_namespace
       AND left(m.source_key, 15) = p.normalized_key
      JOIN app.crm_identity i ON i.id = m.identity_id
     WHERE i.identity_type <> p.parent_type
  ) THEN
    RAISE EXCEPTION 'CRM parent feed found a source coordinate type conflict'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT p.parent_type, p.normalized_key
      FROM crm_parent_source_snapshot p
      JOIN app.crm_source_mapping m
        ON m.source_system = 'CRM'
       AND m.source_namespace = p.source_namespace
       AND left(m.source_key, 15) = p.normalized_key
     GROUP BY p.parent_type, p.normalized_key
    HAVING count(DISTINCT m.identity_id) > 1
  ) THEN
    RAISE EXCEPTION 'CRM parent feed found conflicting width aliases'
      USING ERRCODE = '23514';
  END IF;

  UPDATE crm_parent_source_snapshot p
     SET identity_id = existing.identity_id
    FROM (
      SELECT p2.parent_type, p2.normalized_key, min(m.identity_id) AS identity_id
        FROM crm_parent_source_snapshot p2
        JOIN app.crm_source_mapping m
          ON m.source_system = 'CRM'
         AND m.source_namespace = p2.source_namespace
         AND left(m.source_key, 15) = p2.normalized_key
       GROUP BY p2.parent_type, p2.normalized_key
    ) existing
   WHERE existing.parent_type = p.parent_type
     AND existing.normalized_key = p.normalized_key;

  -- The legacy reconciliation already counts keys backed by full mirror rows;
  -- report only incremental key-only source rows so composed counts do not
  -- double-count the same CRM coordinate.
  SELECT count(*)::bigint INTO v_sources_seen
    FROM crm_parent_source_snapshot WHERE NOT mirror_present;

  IF p_dry_run THEN
    SELECT count(*)::bigint INTO v_identities_created
      FROM crm_parent_source_snapshot
     WHERE NOT mirror_present AND identity_id IS NULL;

    WITH desired_alias AS (
      SELECT parent_type, source_namespace, source_key AS alias_key
        FROM crm_parent_source_snapshot WHERE NOT mirror_present
      UNION
      SELECT parent_type, source_namespace, normalized_key
        FROM crm_parent_source_snapshot WHERE NOT mirror_present
    )
    SELECT count(*)::bigint INTO v_mappings_created
      FROM desired_alias a
     WHERE NOT EXISTS (
       SELECT 1 FROM app.crm_source_mapping m
        WHERE m.source_system = 'CRM'
          AND m.source_namespace = a.source_namespace
          AND m.source_key = a.alias_key
     );
  ELSE
    UPDATE crm_parent_source_snapshot
       SET identity_id = app.new_crm_identity_id(parent_type), is_new = true
     WHERE identity_id IS NULL;

    INSERT INTO app.crm_identity
      (id, identity_type, lifecycle_state, contract_version, updated_at)
    SELECT identity_id, parent_type, 'ACTIVE', 1, now()
      FROM crm_parent_source_snapshot
     WHERE is_new;
    GET DIAGNOSTICS v_identities_created = ROW_COUNT;

    -- Include the feed's exact key, its canonical 15-character alias, and any
    -- full mirror-row key already known for the same canonical parent. The last
    -- set ensures the legacy source sweep reuses this identity rather than
    -- minting a width-variant twin later in the same transaction.
    WITH desired_alias AS MATERIALIZED (
      SELECT parent_type, source_namespace, normalized_key, identity_id,
             source_key AS alias_key
        FROM crm_parent_source_snapshot
      UNION
      SELECT parent_type, source_namespace, normalized_key, identity_id,
             normalized_key AS alias_key
        FROM crm_parent_source_snapshot
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             h.sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN mirror.household h ON left(h.sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             c.sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN mirror.client c ON left(c.sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             e.household_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN mirror.email e ON left(e.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             a.household_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN mirror.activity a ON left(a.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             d.household_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN app.deal d ON left(d.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
         AND d.household_sf_id IS NOT NULL
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             t.household_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN app.transfer t ON left(t.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
         AND t.household_sf_id IS NOT NULL
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             a.client_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN mirror.appointment a ON left(a.client_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND a.client_sf_id IS NOT NULL
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             d.client_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN app.deal d ON left(d.client_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND d.client_sf_id IS NOT NULL
      UNION
      SELECT p.parent_type, p.source_namespace, p.normalized_key, p.identity_id,
             t.client_sf_id AS alias_key
        FROM crm_parent_source_snapshot p
        JOIN app.transfer t ON left(t.client_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND t.client_sf_id IS NOT NULL
    )
    INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
    SELECT app.new_crm_internal_id(), a.identity_id,
           'CRM', a.source_namespace, a.alias_key, now()
      FROM desired_alias a
     WHERE NOT EXISTS (
       SELECT 1 FROM app.crm_source_mapping m
        WHERE m.source_system = 'CRM'
          AND m.source_namespace = a.source_namespace
          AND m.source_key = a.alias_key
     );
    GET DIAGNOSTICS v_mappings_created = ROW_COUNT;

    WITH desired_alias AS MATERIALIZED (
      SELECT source_namespace, source_key AS alias_key
        FROM crm_parent_source_snapshot
      UNION
      SELECT source_namespace, normalized_key
        FROM crm_parent_source_snapshot
      UNION
      SELECT p.source_namespace, h.sf_id
        FROM crm_parent_source_snapshot p
        JOIN mirror.household h ON left(h.sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
      UNION
      SELECT p.source_namespace, c.sf_id
        FROM crm_parent_source_snapshot p
        JOIN mirror.client c ON left(c.sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND (c.household_id IS NULL OR c.sf_id <> c.household_id)
      UNION
      SELECT p.source_namespace, e.household_sf_id
        FROM crm_parent_source_snapshot p
        JOIN mirror.email e ON left(e.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
      UNION
      SELECT p.source_namespace, a.household_sf_id
        FROM crm_parent_source_snapshot p
        JOIN mirror.activity a ON left(a.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
      UNION
      SELECT p.source_namespace, d.household_sf_id
        FROM crm_parent_source_snapshot p
        JOIN app.deal d ON left(d.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
         AND d.household_sf_id IS NOT NULL
      UNION
      SELECT p.source_namespace, t.household_sf_id
        FROM crm_parent_source_snapshot p
        JOIN app.transfer t ON left(t.household_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'HOUSEHOLD'
         AND t.household_sf_id IS NOT NULL
      UNION
      SELECT p.source_namespace, a.client_sf_id
        FROM crm_parent_source_snapshot p
        JOIN mirror.appointment a ON left(a.client_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND a.client_sf_id IS NOT NULL
      UNION
      SELECT p.source_namespace, d.client_sf_id
        FROM crm_parent_source_snapshot p
        JOIN app.deal d ON left(d.client_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND d.client_sf_id IS NOT NULL
      UNION
      SELECT p.source_namespace, t.client_sf_id
        FROM crm_parent_source_snapshot p
        JOIN app.transfer t ON left(t.client_sf_id, 15) = p.normalized_key
       WHERE p.parent_type = 'CONTACT'
         AND t.client_sf_id IS NOT NULL
    )
    UPDATE app.crm_source_mapping m
       SET last_seen_at = now(), updated_at = now()
      FROM desired_alias a
     WHERE m.source_system = 'CRM'
       AND m.source_namespace = a.source_namespace
       AND m.source_key = a.alias_key
       AND m.mapping_state = 'ACTIVE';
    GET DIAGNOSTICS v_mappings_refreshed = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_sources_seen, v_identities_created,
                      v_mappings_created, v_mappings_refreshed;
END;
$$;

REVOKE ALL ON FUNCTION app.reconcile_crm_parent_source(boolean)
  FROM PUBLIC, app_rw, ingest_rw;
GRANT EXECUTE ON FUNCTION app.reconcile_crm_parent_source(boolean)
  TO identity_reconciler;

-- Missing-parent mappings have no authoritative advisor assignment. Fail closed
-- for advisor/client-service sessions; only Operations/Admin may see one, and
-- only through an already-visible child reference. Exact comparisons use the
-- aliases minted above and preserve the existing child-key indexes.
CREATE POLICY crm_source_mapping_parent_reference_app_read
  ON app.crm_source_mapping FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND source_system = 'CRM'
    AND mapping_state = 'ACTIVE'
    AND (
      (
        source_namespace = 'household'
        AND (
          EXISTS (
            SELECT 1 FROM mirror.email e
             WHERE e.household_sf_id = source_key
          )
          OR EXISTS (
            SELECT 1 FROM mirror.activity a
             WHERE a.household_sf_id = source_key
          )
          OR EXISTS (
            SELECT 1 FROM app.deal d
             WHERE d.household_sf_id IS NOT NULL
               AND d.household_sf_id = source_key
          )
          OR EXISTS (
            SELECT 1 FROM app.transfer t
             WHERE t.household_sf_id IS NOT NULL
               AND t.household_sf_id = source_key
          )
        )
      )
      OR
      (
        source_namespace = 'contact'
        AND (
          EXISTS (
            SELECT 1 FROM mirror.appointment a
             WHERE a.client_sf_id IS NOT NULL
               AND a.client_sf_id = source_key
          )
          OR EXISTS (
            SELECT 1 FROM app.deal d
             WHERE d.client_sf_id IS NOT NULL
               AND d.client_sf_id = source_key
          )
          OR EXISTS (
            SELECT 1 FROM app.transfer t
             WHERE t.client_sf_id IS NOT NULL
               AND t.client_sf_id = source_key
          )
        )
      )
    )
  );

COMMIT;
