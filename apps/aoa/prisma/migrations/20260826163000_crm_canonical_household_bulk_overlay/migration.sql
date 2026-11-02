-- Resolve confirmed household overlays in bulk for directory-sized reads.
--
-- The scalar resolver is intentionally safe for one opaque route key, but
-- invoking it once for every household/client turns a directory query into
-- thousands of repeated CRM joins. This bounded helper accepts only the source
-- keys the caller already read under RLS, finds the small confirmed-suppressed
-- subset, and invokes the scalar resolver only for those matches.

BEGIN;

CREATE OR REPLACE FUNCTION app.resolve_crm_canonical_household_overlays(
  p_source_keys text[]
)
RETURNS TABLE (
  source_key text,
  canonical_source_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
  WITH requested AS MATERIALIZED (
    SELECT DISTINCT requested_key.source_key,
           left(requested_key.source_key, 15) AS normalized_key
      FROM unnest(
        CASE
          WHEN cardinality(p_source_keys) BETWEEN 1 AND 10000
            THEN p_source_keys
          ELSE ARRAY[]::text[]
        END
      ) requested_key(source_key)
     WHERE requested_key.source_key IS NOT NULL
       AND btrim(requested_key.source_key) <> ''
  ), suppressed_requested AS MATERIALIZED (
    SELECT DISTINCT requested.source_key
      FROM app.crm_duplicate_candidate candidate
      JOIN app.crm_source_mapping suppressed
        ON suppressed.identity_id = CASE
             WHEN candidate.canonical_identity_id = candidate.left_identity_id
               THEN candidate.right_identity_id
             ELSE candidate.left_identity_id
           END
       AND suppressed.source_system = 'CRM'
       AND suppressed.source_namespace = 'household'
       AND suppressed.mapping_state = 'ACTIVE'
      JOIN requested
        ON requested.normalized_key = left(suppressed.source_key, 15)
     WHERE candidate.entity_type = 'HOUSEHOLD'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
  ), resolved AS MATERIALIZED (
    SELECT suppressed.source_key,
           app.resolve_crm_canonical_household_source_key(
             suppressed.source_key
           ) AS canonical_source_key
      FROM suppressed_requested suppressed
  )
  SELECT DISTINCT resolved.source_key,
                  resolved.canonical_source_key
    FROM resolved
    JOIN requested canonical_visible
      ON canonical_visible.normalized_key = left(resolved.canonical_source_key, 15)
   WHERE left(resolved.source_key, 15)
       <> left(resolved.canonical_source_key, 15)
   ORDER BY resolved.source_key;
$$;

REVOKE ALL ON FUNCTION app.resolve_crm_canonical_household_overlays(text[])
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_household_overlays(text[])
  TO app_rw;

COMMIT;
