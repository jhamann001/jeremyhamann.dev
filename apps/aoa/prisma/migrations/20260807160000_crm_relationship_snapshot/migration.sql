-- CRM relationship layer — Phase 4C deterministic preview/live snapshot.
--
-- This migration adds the constrained machine write API only. It does not run
-- a snapshot, create relationship data, grant direct table access, expose a
-- human read path, add a caller, or activate a feature flag.

BEGIN;

-- Resolve an identity or merge chain to exactly one active survivor of the
-- reviewed type. Merge validation already prevents cycles and cross-type
-- targets; the defensive path check keeps this helper fail-closed if historical
-- corruption is ever present.
CREATE OR REPLACE FUNCTION app.crm_active_identity_survivor(
  p_identity_id text,
  p_expected_type text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  WITH RECURSIVE identity_chain AS (
    SELECT i.id, i.identity_type, i.lifecycle_state, i.merged_into_id,
           ARRAY[i.id]::text[] AS path,
           false AS cycle
      FROM app.crm_identity i
     WHERE i.id = p_identity_id
    UNION ALL
    SELECT i.id, i.identity_type, i.lifecycle_state, i.merged_into_id,
           c.path || i.id,
           i.id = ANY(c.path) AS cycle
      FROM app.crm_identity i
      JOIN identity_chain c ON i.id = c.merged_into_id
     WHERE c.merged_into_id IS NOT NULL
       AND NOT c.cycle
  )
  SELECT c.id
    FROM identity_chain c
   WHERE NOT c.cycle
     AND c.identity_type = p_expected_type
     AND c.lifecycle_state = 'ACTIVE'
     AND c.merged_into_id IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM identity_chain invalid
        WHERE invalid.cycle
           OR invalid.identity_type <> p_expected_type
     )
   ORDER BY cardinality(c.path) DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.new_crm_relationship_id()
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $$
  SELECT 'rel_c' || substr(
    md5(
      clock_timestamp()::text || ':' || random()::text || ':' ||
      pg_backend_pid()::text || ':' || txid_current()::text
    ),
    1,
    24
  )
$$;

REVOKE ALL ON FUNCTION app.crm_active_identity_survivor(text, text)
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
REVOKE ALL ON FUNCTION app.new_crm_relationship_id()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

-- Phase 4B required the evidence mapping to point directly at the endpoint.
-- Phase 4A also requires merged endpoints to resolve to their active survivor,
-- so retain every prior check while accepting only that same-type survivor.
CREATE OR REPLACE FUNCTION app.validate_crm_relationship()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  from_type text;
  from_state text;
  to_type text;
  to_state text;
  evidence_identity_id text;
  evidence_state text;
  expected_evidence_identity_id text;
  expected_evidence_type text;
  evidence_survivor_id text;
BEGIN
  IF NEW.relationship_state <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT i.identity_type, i.lifecycle_state
    INTO from_type, from_state
    FROM app.crm_identity i
   WHERE i.id = NEW.from_identity_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM relationship source identity is missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT i.identity_type, i.lifecycle_state
    INTO to_type, to_state
    FROM app.crm_identity i
   WHERE i.id = NEW.to_identity_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM relationship target identity is missing'
      USING ERRCODE = '23503';
  END IF;

  IF from_state <> 'ACTIVE' OR to_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Active CRM relationships require active endpoint identities'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (
      NEW.relationship_type = 'HOUSEHOLD_HAS_MEMBER'
      AND from_type = 'HOUSEHOLD'
      AND to_type = 'CONTACT'
    ) OR (
      NEW.relationship_type = 'DEAL_FOR_HOUSEHOLD'
      AND from_type = 'DEAL'
      AND to_type = 'HOUSEHOLD'
    ) OR (
      NEW.relationship_type = 'TRANSFER_FOR_HOUSEHOLD'
      AND from_type = 'TRANSFER'
      AND to_type = 'HOUSEHOLD'
    )
  ) THEN
    RAISE EXCEPTION 'CRM relationship endpoint types do not match the reviewed catalog'
      USING ERRCODE = '23514';
  END IF;

  SELECT m.identity_id, m.mapping_state
    INTO evidence_identity_id, evidence_state
    FROM app.crm_source_mapping m
   WHERE m.id = NEW.evidence_mapping_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM relationship evidence mapping is missing'
      USING ERRCODE = '23503';
  END IF;

  IF evidence_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Active CRM relationships require active evidence mappings'
      USING ERRCODE = '23514';
  END IF;

  expected_evidence_identity_id := CASE NEW.relationship_type
    WHEN 'HOUSEHOLD_HAS_MEMBER' THEN NEW.to_identity_id
    WHEN 'DEAL_FOR_HOUSEHOLD' THEN NEW.from_identity_id
    WHEN 'TRANSFER_FOR_HOUSEHOLD' THEN NEW.from_identity_id
    ELSE NULL
  END;
  expected_evidence_type := CASE NEW.relationship_type
    WHEN 'HOUSEHOLD_HAS_MEMBER' THEN 'CONTACT'
    WHEN 'DEAL_FOR_HOUSEHOLD' THEN 'DEAL'
    WHEN 'TRANSFER_FOR_HOUSEHOLD' THEN 'TRANSFER'
    ELSE NULL
  END;
  evidence_survivor_id := app.crm_active_identity_survivor(
    evidence_identity_id,
    expected_evidence_type
  );

  IF evidence_survivor_id IS DISTINCT FROM expected_evidence_identity_id THEN
    RAISE EXCEPTION 'CRM relationship evidence does not match the reviewed endpoint'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.validate_crm_relationship()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE OR REPLACE FUNCTION app.reconcile_crm_relationship_snapshot(
  p_run_id text,
  p_contact_snapshot_complete boolean DEFAULT false,
  p_deal_snapshot_complete boolean DEFAULT false,
  p_transfer_snapshot_complete boolean DEFAULT false
)
RETURNS TABLE (
  derivation_code text,
  snapshot_complete boolean,
  candidates bigint,
  created bigint,
  refreshed bigint,
  reactivated bigint,
  inactivated bigint,
  missing_endpoint bigint,
  ambiguous_endpoint bigint,
  rejected_type bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror, audit
AS $$
BEGIN
  IF p_run_id IS NULL OR p_run_id !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'Invalid CRM relationship reconciliation run id'
      USING ERRCODE = '22023';
  END IF;
  IF p_contact_snapshot_complete IS NULL
     OR p_deal_snapshot_complete IS NULL
     OR p_transfer_snapshot_complete IS NULL
  THEN
    RAISE EXCEPTION 'CRM relationship snapshot completeness must be explicit'
      USING ERRCODE = '22023';
  END IF;

  -- The transaction-scoped lock serializes scheduled, post-commit, and manual
  -- runs. The unique evidence coordinate remains the final duplicate guard.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.crm.relationship.reconcile.v1', 0)
  );

  DROP TABLE IF EXISTS pg_temp.crm_relationship_action;
  DROP TABLE IF EXISTS pg_temp.crm_relationship_resolution;
  DROP TABLE IF EXISTS pg_temp.crm_relationship_source;
  DROP TABLE IF EXISTS pg_temp.crm_relationship_metric;

  CREATE TEMP TABLE crm_relationship_metric (
    derivation_code text PRIMARY KEY,
    relationship_type text NOT NULL UNIQUE,
    snapshot_complete boolean NOT NULL,
    candidates bigint NOT NULL DEFAULT 0,
    created bigint NOT NULL DEFAULT 0,
    refreshed bigint NOT NULL DEFAULT 0,
    reactivated bigint NOT NULL DEFAULT 0,
    inactivated bigint NOT NULL DEFAULT 0,
    missing_endpoint bigint NOT NULL DEFAULT 0,
    ambiguous_endpoint bigint NOT NULL DEFAULT 0,
    rejected_type bigint NOT NULL DEFAULT 0
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.crm_relationship_metric
    (derivation_code, relationship_type, snapshot_complete)
  VALUES
    ('CRM_CONTACT_HOUSEHOLD', 'HOUSEHOLD_HAS_MEMBER',
     p_contact_snapshot_complete),
    ('AOA_DEAL_HOUSEHOLD', 'DEAL_FOR_HOUSEHOLD',
     p_deal_snapshot_complete),
    ('AOA_TRANSFER_HOUSEHOLD', 'TRANSFER_FOR_HOUSEHOLD',
     p_transfer_snapshot_complete);

  CREATE TEMP TABLE crm_relationship_source (
    derivation_code text NOT NULL,
    relationship_type text NOT NULL,
    evidence_source_system text NOT NULL,
    evidence_source_namespace text NOT NULL,
    evidence_source_key text NOT NULL,
    evidence_identity_type text NOT NULL,
    evidence_endpoint text NOT NULL,
    parent_key text,
    snapshot_complete boolean NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.crm_relationship_source
    (derivation_code, relationship_type,
     evidence_source_system, evidence_source_namespace, evidence_source_key,
     evidence_identity_type, evidence_endpoint, parent_key, snapshot_complete)
  SELECT 'CRM_CONTACT_HOUSEHOLD', 'HOUSEHOLD_HAS_MEMBER',
         'CRM', 'contact', c.sf_id,
         'CONTACT', 'TO', c.household_id, p_contact_snapshot_complete
    FROM mirror.client c
   WHERE nullif(btrim(c.sf_id), '') IS NOT NULL
     AND (c.household_id IS NULL OR c.sf_id <> c.household_id);

  INSERT INTO pg_temp.crm_relationship_source
    (derivation_code, relationship_type,
     evidence_source_system, evidence_source_namespace, evidence_source_key,
     evidence_identity_type, evidence_endpoint, parent_key, snapshot_complete)
  SELECT 'AOA_DEAL_HOUSEHOLD', 'DEAL_FOR_HOUSEHOLD',
         'AOA', 'deal', d.id,
         'DEAL', 'FROM', d.household_sf_id, p_deal_snapshot_complete
    FROM app.deal d
   WHERE nullif(btrim(d.id), '') IS NOT NULL;

  INSERT INTO pg_temp.crm_relationship_source
    (derivation_code, relationship_type,
     evidence_source_system, evidence_source_namespace, evidence_source_key,
     evidence_identity_type, evidence_endpoint, parent_key, snapshot_complete)
  SELECT 'AOA_TRANSFER_HOUSEHOLD', 'TRANSFER_FOR_HOUSEHOLD',
         'AOA', 'transfer', t.id,
         'TRANSFER', 'FROM', t.household_sf_id, p_transfer_snapshot_complete
    FROM app.transfer t
   WHERE nullif(btrim(t.id), '') IS NOT NULL;

  CREATE TEMP TABLE crm_relationship_resolution ON COMMIT DROP AS
  SELECT
    s.derivation_code,
    s.relationship_type,
    s.snapshot_complete,
    evidence_map.id AS evidence_mapping_id,
    CASE
      WHEN s.evidence_endpoint = 'FROM' THEN evidence_survivor.identity_id
      ELSE parent_match.identity_id
    END AS from_identity_id,
    CASE
      WHEN s.evidence_endpoint = 'TO' THEN evidence_survivor.identity_id
      ELSE parent_match.identity_id
    END AS to_identity_id,
    CASE
      WHEN evidence_identity.identity_type IS NOT NULL
       AND evidence_identity.identity_type <> s.evidence_identity_type
        THEN 'REJECTED_TYPE'
      WHEN coalesce(parent_match.rejected_type, false)
        THEN 'REJECTED_TYPE'
      WHEN evidence_map.id IS NULL
        OR evidence_survivor.identity_id IS NULL
        OR coalesce(parent_match.identity_count, 0) = 0
        THEN 'MISSING_ENDPOINT'
      WHEN parent_match.identity_count > 1
        THEN 'AMBIGUOUS_ENDPOINT'
      ELSE 'RESOLVED'
    END AS resolution_state
  FROM pg_temp.crm_relationship_source s
  LEFT JOIN app.crm_source_mapping evidence_map
    ON evidence_map.source_system = s.evidence_source_system
   AND evidence_map.source_namespace = s.evidence_source_namespace
   AND evidence_map.source_key = s.evidence_source_key
   AND evidence_map.mapping_state = 'ACTIVE'
  LEFT JOIN app.crm_identity evidence_identity
    ON evidence_identity.id = evidence_map.identity_id
  LEFT JOIN LATERAL (
    SELECT app.crm_active_identity_survivor(
      evidence_map.identity_id,
      s.evidence_identity_type
    ) AS identity_id
  ) evidence_survivor ON true
  LEFT JOIN LATERAL (
    SELECT
      count(DISTINCT candidate.identity_id)
        FILTER (WHERE candidate.identity_id IS NOT NULL) AS identity_count,
      min(candidate.identity_id)
        FILTER (WHERE candidate.identity_id IS NOT NULL) AS identity_id,
      bool_or(candidate.identity_type <> 'HOUSEHOLD') AS rejected_type
    FROM (
      SELECT parent_identity.identity_type,
             app.crm_active_identity_survivor(
               parent_map.identity_id,
               'HOUSEHOLD'
             ) AS identity_id
        FROM app.crm_source_mapping parent_map
        JOIN app.crm_identity parent_identity
          ON parent_identity.id = parent_map.identity_id
       WHERE parent_map.source_system = 'CRM'
         AND parent_map.source_namespace = 'household'
         AND parent_map.mapping_state = 'ACTIVE'
         AND s.parent_key ~ '^001[[:alnum:]]{12}([[:alnum:]]{3})?$'
         AND parent_map.source_key ~ '^001[[:alnum:]]{12}([[:alnum:]]{3})?$'
         AND left(parent_map.source_key, 15) = left(s.parent_key, 15)
    ) candidate
  ) parent_match ON true;

  UPDATE pg_temp.crm_relationship_metric metric
     SET candidates = grouped.candidates,
         missing_endpoint = grouped.missing_endpoint,
         ambiguous_endpoint = grouped.ambiguous_endpoint,
         rejected_type = grouped.rejected_type
    FROM (
      SELECT resolution.derivation_code,
             count(*)::bigint AS candidates,
             count(*) FILTER (
               WHERE resolution.resolution_state = 'MISSING_ENDPOINT'
             )::bigint AS missing_endpoint,
             count(*) FILTER (
               WHERE resolution.resolution_state = 'AMBIGUOUS_ENDPOINT'
             )::bigint AS ambiguous_endpoint,
             count(*) FILTER (
               WHERE resolution.resolution_state = 'REJECTED_TYPE'
             )::bigint AS rejected_type
        FROM pg_temp.crm_relationship_resolution resolution
       GROUP BY resolution.derivation_code
    ) grouped
   WHERE metric.derivation_code = grouped.derivation_code;

  CREATE TEMP TABLE crm_relationship_action ON COMMIT DROP AS
  SELECT resolution.*,
         existing.id AS existing_id,
         existing.relationship_state AS existing_state
    FROM pg_temp.crm_relationship_resolution resolution
    LEFT JOIN app.crm_relationship existing
      ON existing.relationship_type = resolution.relationship_type
     AND existing.from_identity_id = resolution.from_identity_id
     AND existing.to_identity_id = resolution.to_identity_id
     AND existing.evidence_mapping_id = resolution.evidence_mapping_id
   WHERE resolution.resolution_state = 'RESOLVED';

  WITH changed AS (
    UPDATE app.crm_relationship relationship
       SET last_seen_at = now(), updated_at = now()
      FROM pg_temp.crm_relationship_action action
     WHERE action.existing_state = 'ACTIVE'
       AND relationship.id = action.existing_id
    RETURNING relationship.relationship_type
  ), grouped AS (
    SELECT relationship_type, count(*)::bigint AS n
      FROM changed GROUP BY relationship_type
  )
  UPDATE pg_temp.crm_relationship_metric metric
     SET refreshed = grouped.n
    FROM grouped
   WHERE metric.relationship_type = grouped.relationship_type;

  WITH changed AS (
    UPDATE app.crm_relationship relationship
       SET relationship_state = 'ACTIVE',
           inactivated_at = NULL,
           last_seen_at = now(),
           updated_at = now()
      FROM pg_temp.crm_relationship_action action
     WHERE action.existing_state = 'INACTIVE'
       AND relationship.id = action.existing_id
    RETURNING relationship.relationship_type
  ), grouped AS (
    SELECT relationship_type, count(*)::bigint AS n
      FROM changed GROUP BY relationship_type
  )
  UPDATE pg_temp.crm_relationship_metric metric
     SET reactivated = grouped.n
    FROM grouped
   WHERE metric.relationship_type = grouped.relationship_type;

  WITH changed AS (
    INSERT INTO app.crm_relationship
      (id, relationship_type, from_identity_id, to_identity_id,
       evidence_mapping_id, relationship_state, contract_version,
       first_seen_at, last_seen_at, updated_at)
    SELECT app.new_crm_relationship_id(), action.relationship_type,
           action.from_identity_id, action.to_identity_id,
           action.evidence_mapping_id, 'ACTIVE', 1,
           now(), now(), now()
      FROM pg_temp.crm_relationship_action action
     WHERE action.existing_id IS NULL
    ON CONFLICT
      (relationship_type, from_identity_id, to_identity_id, evidence_mapping_id)
      DO NOTHING
    RETURNING relationship_type
  ), grouped AS (
    SELECT relationship_type, count(*)::bigint AS n
      FROM changed GROUP BY relationship_type
  )
  UPDATE pg_temp.crm_relationship_metric metric
     SET created = grouped.n
    FROM grouped
   WHERE metric.relationship_type = grouped.relationship_type;

  -- A missing source/evidence coordinate can inactivate prior evidence only
  -- when that derivation's caller explicitly attests the snapshot is complete.
  WITH changed AS (
    UPDATE app.crm_relationship relationship
       SET relationship_state = 'INACTIVE',
           inactivated_at = now(),
           updated_at = now()
     WHERE relationship.relationship_state = 'ACTIVE'
       AND (
         (relationship.relationship_type = 'HOUSEHOLD_HAS_MEMBER'
          AND p_contact_snapshot_complete)
         OR
         (relationship.relationship_type = 'DEAL_FOR_HOUSEHOLD'
          AND p_deal_snapshot_complete)
         OR
         (relationship.relationship_type = 'TRANSFER_FOR_HOUSEHOLD'
          AND p_transfer_snapshot_complete)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM pg_temp.crm_relationship_resolution resolution
          WHERE resolution.resolution_state = 'RESOLVED'
            AND resolution.relationship_type = relationship.relationship_type
            AND resolution.from_identity_id = relationship.from_identity_id
            AND resolution.to_identity_id = relationship.to_identity_id
            AND resolution.evidence_mapping_id = relationship.evidence_mapping_id
       )
    RETURNING relationship.relationship_type
  ), grouped AS (
    SELECT relationship_type, count(*)::bigint AS n
      FROM changed GROUP BY relationship_type
  )
  UPDATE pg_temp.crm_relationship_metric metric
     SET inactivated = grouped.n
    FROM grouped
   WHERE metric.relationship_type = grouped.relationship_type;

  INSERT INTO audit."AuditLog"
    ("actorRole", "action", "entityType", "entityId", "detail")
  SELECT
    'IDENTITY_RECONCILER',
    'crm.relationship.reconcile',
    'crm_relationship_run',
    p_run_id,
    jsonb_build_object(
      'contract_version', 1,
      'derivations', jsonb_agg(
        jsonb_build_object(
          'derivation_code', metric.derivation_code,
          'snapshot_complete', metric.snapshot_complete,
          'candidates', metric.candidates,
          'created', metric.created,
          'refreshed', metric.refreshed,
          'reactivated', metric.reactivated,
          'inactivated', metric.inactivated,
          'missing_endpoint', metric.missing_endpoint,
          'ambiguous_endpoint', metric.ambiguous_endpoint,
          'rejected_type', metric.rejected_type
        ) ORDER BY metric.derivation_code
      )
    )::text
    FROM pg_temp.crm_relationship_metric metric;

  RETURN QUERY
  SELECT metric.derivation_code,
         metric.snapshot_complete,
         metric.candidates,
         metric.created,
         metric.refreshed,
         metric.reactivated,
         metric.inactivated,
         metric.missing_endpoint,
         metric.ambiguous_endpoint,
         metric.rejected_type
    FROM pg_temp.crm_relationship_metric metric
   ORDER BY metric.derivation_code;
END;
$$;

-- Preview executes the exact live function inside a rollback subtransaction.
-- Only typed counts escape through a PL/pgSQL variable; relationship rows and
-- both audit layers are rolled back before the function returns.
CREATE OR REPLACE FUNCTION app.preview_crm_relationship_snapshot(
  p_run_id text,
  p_contact_snapshot_complete boolean DEFAULT false,
  p_deal_snapshot_complete boolean DEFAULT false,
  p_transfer_snapshot_complete boolean DEFAULT false
)
RETURNS TABLE (
  derivation_code text,
  snapshot_complete boolean,
  candidates bigint,
  created bigint,
  refreshed bigint,
  reactivated bigint,
  inactivated bigint,
  missing_endpoint bigint,
  ambiguous_endpoint bigint,
  rejected_type bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_counts jsonb;
BEGIN
  BEGIN
    SELECT jsonb_agg(to_jsonb(result) ORDER BY result.derivation_code)
      INTO STRICT v_counts
      FROM app.reconcile_crm_relationship_snapshot(
        p_run_id,
        p_contact_snapshot_complete,
        p_deal_snapshot_complete,
        p_transfer_snapshot_complete
      ) result;

    RAISE EXCEPTION 'CRM relationship preview rollback'
      USING ERRCODE = 'P4C01';
  EXCEPTION
    WHEN SQLSTATE 'P4C01' THEN
      NULL;
  END;

  RETURN QUERY
  SELECT result.derivation_code,
         result.snapshot_complete,
         result.candidates,
         result.created,
         result.refreshed,
         result.reactivated,
         result.inactivated,
         result.missing_endpoint,
         result.ambiguous_endpoint,
         result.rejected_type
    FROM jsonb_to_recordset(v_counts) AS result(
      derivation_code text,
      snapshot_complete boolean,
      candidates bigint,
      created bigint,
      refreshed bigint,
      reactivated bigint,
      inactivated bigint,
      missing_endpoint bigint,
      ambiguous_endpoint bigint,
      rejected_type bigint
    )
   ORDER BY result.derivation_code;
END;
$$;

REVOKE ALL ON FUNCTION app.reconcile_crm_relationship_snapshot(
  text, boolean, boolean, boolean
) FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
REVOKE ALL ON FUNCTION app.preview_crm_relationship_snapshot(
  text, boolean, boolean, boolean
) FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

GRANT EXECUTE ON FUNCTION app.reconcile_crm_relationship_snapshot(
  text, boolean, boolean, boolean
) TO identity_reconciler;
GRANT EXECUTE ON FUNCTION app.preview_crm_relationship_snapshot(
  text, boolean, boolean, boolean
) TO identity_reconciler;

-- The reconciler receives function execution only. The table remains behind
-- forced RLS with no machine policy and no direct read/write privilege.
REVOKE ALL ON app.crm_relationship
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

COMMIT;
