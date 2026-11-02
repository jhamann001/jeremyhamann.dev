-- CRM duplicate learning, phase 3: canonical household read groups.
--
-- A confirmed canonical choice may represent more than one CRM household
-- source record. This resolver exposes the bounded, reversible source set to
-- AOA reads without rewriting, deleting, merging, or re-parenting source data.

BEGIN;

CREATE OR REPLACE FUNCTION app.crm_canonical_household_source_keys(
  p_source_key text
)
RETURNS TABLE (source_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
DECLARE
  v_canonical text;
  v_canonical_identities text[];
BEGIN
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN
    RETURN;
  END IF;

  v_canonical := app.resolve_crm_canonical_household_source_key(p_source_key);

  SELECT array_agg(DISTINCT mapping.identity_id ORDER BY mapping.identity_id)
    INTO v_canonical_identities
    FROM app.crm_source_mapping mapping
    JOIN app.crm_identity identity_record
      ON identity_record.id = mapping.identity_id
     AND identity_record.identity_type = 'HOUSEHOLD'
     AND identity_record.lifecycle_state = 'ACTIVE'
    JOIN mirror.household household
      ON left(household.sf_id, 15) = left(mapping.source_key, 15)
   WHERE mapping.source_system = 'CRM'
     AND mapping.source_namespace = 'household'
     AND mapping.mapping_state = 'ACTIVE'
     AND left(mapping.source_key, 15) = left(v_canonical, 15);

  -- An ambiguous canonical mapping cannot safely widen a read. Preserve only
  -- the already-resolved source key and let the caller's normal RLS apply.
  IF v_canonical_identities IS NULL
     OR cardinality(v_canonical_identities) <> 1
  THEN
    RETURN QUERY SELECT v_canonical;
    RETURN;
  END IF;

  RETURN QUERY
  WITH RECURSIVE grouped_identity(identity_id, path, depth) AS (
    SELECT v_canonical_identities[1], ARRAY[v_canonical_identities[1]], 0
    UNION ALL
    SELECT loser.identity_id,
           grouped.path || loser.identity_id,
           grouped.depth + 1
      FROM grouped_identity grouped
      JOIN app.crm_duplicate_candidate candidate
        ON candidate.entity_type = 'HOUSEHOLD'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id = grouped.identity_id
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN candidate.left_identity_id = candidate.canonical_identity_id
            THEN candidate.right_identity_id
          ELSE candidate.left_identity_id
        END AS identity_id
      ) loser
     WHERE grouped.depth < 8
       AND NOT loser.identity_id = ANY(grouped.path)
  ), mapped_source AS (
    SELECT DISTINCT household.sf_id
      FROM grouped_identity grouped
      JOIN app.crm_source_mapping mapping
        ON mapping.identity_id = grouped.identity_id
       AND mapping.source_system = 'CRM'
       AND mapping.source_namespace = 'household'
       AND mapping.mapping_state = 'ACTIVE'
      JOIN mirror.household household
        ON left(household.sf_id, 15) = left(mapping.source_key, 15)
     -- Reuse the scalar resolver as the final ambiguity/cycle check. Every
     -- widened source must independently resolve to this exact survivor.
     WHERE left(app.resolve_crm_canonical_household_source_key(household.sf_id), 15)
         = left(v_canonical, 15)
  ), bounded_source(key_value, sort_order) AS (
    SELECT mapped.sf_id,
           CASE WHEN left(mapped.sf_id, 15) = left(v_canonical, 15)
             THEN 0 ELSE 1 END
      FROM mapped_source mapped
     WHERE (SELECT count(*) FROM mapped_source) <= 16
    UNION ALL
    -- An unexpectedly broad group is as unsafe as an ambiguous group. Do not
    -- return a partial set: fail closed to the survivor only.
    SELECT v_canonical, 0
     WHERE (SELECT count(*) FROM mapped_source) > 16
  )
  SELECT bounded.key_value
    FROM bounded_source bounded
   ORDER BY bounded.sort_order, bounded.key_value;
END;
$$;

REVOKE ALL ON FUNCTION app.crm_canonical_household_source_keys(text)
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.crm_canonical_household_source_keys(text)
  TO app_rw;

COMMIT;
