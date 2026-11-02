-- CRM duplicate review: production-calibrated weak-signal guardrails.
--
-- Production preview evidence showed exact household name + advisor + stage
-- alone creates combinatorial false positives. Keep durable identifiers and
-- source-replacement evidence unchanged. A name-based household candidate is
-- now reviewable only when exactly two identities share the cluster and one is
-- an empty shell while the other contains at least one member.
--
-- This remains candidate generation only. It never merges, archives,
-- re-parents, selects a survivor, or rewrites a CRM/source record.

BEGIN;

CREATE OR REPLACE FUNCTION app.reconcile_crm_duplicate_candidates()
RETURNS TABLE (
  signals_seen bigint,
  candidates_opened bigint,
  candidates_refreshed bigint,
  candidates_inactivated bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror, audit
AS $$
DECLARE
  opened_count bigint := 0;
  refreshed_count bigint := 0;
  inactivated_count bigint := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('app.crm.duplicate.reconcile.v1', 0));

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.crm_duplicate_signal (
    detector_key char(64) PRIMARY KEY,
    entity_type app."CrmDuplicateEntityType" NOT NULL,
    left_identity_id text NOT NULL,
    right_identity_id text NOT NULL,
    account_fingerprint char(64),
    evidence_codes text[] NOT NULL,
    hard_conflict_codes text[] NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.crm_duplicate_signal;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.crm_duplicate_invalidation (
    candidate_id text PRIMARY KEY,
    prior_conflict_count integer NOT NULL,
    next_conflict_count integer NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.crm_duplicate_invalidation;

  WITH active_households AS MATERIALIZED (
    SELECT DISTINCT m.identity_id, left(m.source_key, 15) AS source_key_15
      FROM app.crm_source_mapping m
      JOIN app.crm_identity i ON i.id = m.identity_id
     WHERE i.identity_type = 'HOUSEHOLD'
       AND i.lifecycle_state = 'ACTIVE'
       AND m.mapping_state = 'ACTIVE'
       AND m.source_system = 'CRM'
       AND m.source_namespace = 'household'
  ), household_profiles AS MATERIALIZED (
    SELECT DISTINCT ON (household.identity_id)
           household.identity_id,
           household.source_key_15,
           regexp_replace(lower(btrim(source.name)), '[[:space:]]+', ' ', 'g') AS normalized_name,
           lower(btrim(coalesce(source.lead_advisor_email, ''))) AS advisor_key,
           lower(btrim(coalesce(nullif(source.stage, ''), nullif(source.status, ''), ''))) AS stage_key,
           (SELECT count(*)::bigint
              FROM mirror.client member
             WHERE left(member.household_id, 15) = household.source_key_15) AS member_count
      FROM active_households household
      JOIN mirror.household source
        ON left(source.sf_id, 15) = household.source_key_15
     ORDER BY household.identity_id, source.synced_at DESC, household.source_key_15
  ), household_name_clusters AS MATERIALIZED (
    SELECT normalized_name, advisor_key, stage_key,
           count(*)::bigint AS identity_count
      FROM household_profiles
     WHERE normalized_name <> ''
       AND advisor_key <> ''
       AND stage_key <> ''
     GROUP BY normalized_name, advisor_key, stage_key
    HAVING count(*) = 2
  ), weak_household_pairs AS MATERIALIZED (
    SELECT least(l.identity_id, r.identity_id) AS left_identity_id,
           greatest(l.identity_id, r.identity_id) AS right_identity_id,
           l.member_count AS left_member_count,
           r.member_count AS right_member_count
      FROM household_profiles l
      JOIN household_profiles r
        ON r.normalized_name = l.normalized_name
       AND r.identity_id > l.identity_id
       AND r.advisor_key = l.advisor_key
       AND r.stage_key = l.stage_key
      JOIN household_name_clusters cluster
        ON cluster.normalized_name = l.normalized_name
       AND cluster.advisor_key = l.advisor_key
       AND cluster.stage_key = l.stage_key
       AND cluster.identity_count = 2
     WHERE l.normalized_name <> ''
       AND l.advisor_key <> ''
       AND l.stage_key <> ''
       AND (
         (l.member_count = 0 AND r.member_count > 0)
         OR (r.member_count = 0 AND l.member_count > 0)
       )
  ), household_evidence AS (
    SELECT least(l.identity_id, r.identity_id) AS left_identity_id,
           greatest(l.identity_id, r.identity_id) AS right_identity_id,
           'SHARED_CEDAR_RIDGE_USER_ID'::text AS evidence_code
      FROM mirror.client lc
      JOIN mirror.client rc
        ON nullif(lower(btrim(lc.cedar_ridge_user_id)), '')
         = nullif(lower(btrim(rc.cedar_ridge_user_id)), '')
       AND lc.sf_id < rc.sf_id
      JOIN active_households l ON l.source_key_15 = left(lc.household_id, 15)
      JOIN active_households r ON r.source_key_15 = left(rc.household_id, 15)
     WHERE lc.cedar_ridge_user_id IS NOT NULL
       AND l.identity_id <> r.identity_id
    UNION ALL
    SELECT least(old_map.identity_id, new_map.identity_id),
           greatest(old_map.identity_id, new_map.identity_id),
           'SOURCE_MERGE_REPLACEMENT'::text
      FROM mirror.crm_parent_orphan_evidence evidence
      JOIN active_households old_map
        ON old_map.source_key_15 = evidence.normalized_key
      JOIN active_households new_map
        ON new_map.source_key_15 = evidence.replacement_normalized_key
     WHERE evidence.parent_type = 'HOUSEHOLD'
       AND evidence.evidence_type = 'MERGED'
       AND old_map.identity_id <> new_map.identity_id
    UNION ALL
    SELECT pair.left_identity_id, pair.right_identity_id,
           'EXACT_NORMALIZED_HOUSEHOLD_NAME'::text
      FROM weak_household_pairs pair
    UNION ALL
    SELECT pair.left_identity_id, pair.right_identity_id,
           'SAME_ADVISOR_AND_STAGE'::text
      FROM weak_household_pairs pair
    UNION ALL
    SELECT pair.left_identity_id, pair.right_identity_id,
           'EMPTY_SHELL_WITH_POPULATED_MATCH'::text
      FROM weak_household_pairs pair
     WHERE (pair.left_member_count = 0 AND pair.right_member_count > 0)
        OR (pair.right_member_count = 0 AND pair.left_member_count > 0)
  ), household_pairs AS (
    SELECT left_identity_id, right_identity_id,
           array_agg(DISTINCT evidence_code ORDER BY evidence_code) AS evidence_codes
      FROM household_evidence
     GROUP BY left_identity_id, right_identity_id
  ), account_households AS MATERIALIZED (
    SELECT DISTINCT holder.custodian_account_id, household.identity_id
      FROM mirror.account_holder holder
      JOIN mirror.client client
        ON nullif(lower(btrim(client.cedar_ridge_user_id)), '')
         = nullif(lower(btrim(holder.cedar_ridge_user_id)), '')
      JOIN active_households household
        ON household.source_key_15 = left(client.household_id, 15)
     WHERE holder.custodian_account_id IS NOT NULL
       AND holder.custodian_account_id <> ''
  ), account_pairs AS (
    SELECT least(l.identity_id, r.identity_id) AS left_identity_id,
           greatest(l.identity_id, r.identity_id) AS right_identity_id,
           l.custodian_account_id
      FROM account_households l
      JOIN account_households r
        ON r.custodian_account_id = l.custodian_account_id
       AND l.identity_id < r.identity_id
  ), combined AS (
    SELECT 'HOUSEHOLD'::app."CrmDuplicateEntityType" AS entity_type,
           pair.left_identity_id, pair.right_identity_id,
           NULL::char(64) AS account_fingerprint,
           pair.evidence_codes,
           CASE WHEN EXISTS (
             SELECT 1
               FROM active_households lh
               JOIN mirror.client lc ON left(lc.household_id, 15) = lh.source_key_15
               JOIN active_households rh ON rh.identity_id = pair.right_identity_id
               JOIN mirror.client rc ON left(rc.household_id, 15) = rh.source_key_15
              WHERE lh.identity_id = pair.left_identity_id
                AND nullif(lower(btrim(lc.email)), '') = nullif(lower(btrim(rc.email)), '')
                AND nullif(lower(btrim(lc.cedar_ridge_user_id)), '') IS NOT NULL
                AND nullif(lower(btrim(rc.cedar_ridge_user_id)), '') IS NOT NULL
                AND lower(btrim(lc.cedar_ridge_user_id)) <> lower(btrim(rc.cedar_ridge_user_id))
           ) THEN ARRAY['CONFLICTING_MEMBER_IDENTITY']::text[]
             ELSE ARRAY[]::text[] END AS hard_conflict_codes
      FROM household_pairs pair
    UNION ALL
    SELECT 'ACCOUNT'::app."CrmDuplicateEntityType",
           pair.left_identity_id, pair.right_identity_id,
           app.crm_duplicate_fingerprint('ACCOUNT:' || pair.custodian_account_id),
           ARRAY['EXACT_CUSTODIAN_IDENTITY']::text[], ARRAY[]::text[]
      FROM account_pairs pair
  )
  INSERT INTO pg_temp.crm_duplicate_signal (
    detector_key, entity_type, left_identity_id, right_identity_id,
    account_fingerprint, evidence_codes, hard_conflict_codes
  )
  SELECT app.crm_duplicate_fingerprint(
           entity_type::text || ':' || left_identity_id || ':' || right_identity_id || ':' ||
           coalesce(account_fingerprint::text, '')
         ), entity_type, left_identity_id, right_identity_id,
         account_fingerprint, evidence_codes, hard_conflict_codes
    FROM combined;

  SELECT count(*) INTO opened_count
    FROM pg_temp.crm_duplicate_signal signal
   WHERE NOT EXISTS (
     SELECT 1 FROM app.crm_duplicate_candidate existing
      WHERE existing.detector_key = signal.detector_key
   );
  SELECT count(*) INTO refreshed_count
    FROM pg_temp.crm_duplicate_signal signal
    JOIN app.crm_duplicate_candidate existing
      ON existing.detector_key = signal.detector_key;

  PERFORM 1
    FROM app.crm_duplicate_candidate existing
    JOIN pg_temp.crm_duplicate_signal signal
      ON signal.detector_key = existing.detector_key
   FOR UPDATE OF existing;

  INSERT INTO pg_temp.crm_duplicate_invalidation (
    candidate_id, prior_conflict_count, next_conflict_count
  )
  SELECT existing.id,
         cardinality(existing.hard_conflict_codes),
         cardinality(signal.hard_conflict_codes)
    FROM app.crm_duplicate_candidate existing
    JOIN pg_temp.crm_duplicate_signal signal
      ON signal.detector_key = existing.detector_key
   WHERE existing.status = 'READY_FOR_FOLLOW_UP'
     AND cardinality(signal.hard_conflict_codes) > 0;

  INSERT INTO app.crm_duplicate_candidate AS existing (
    id, detector_key, entity_type, left_identity_id, right_identity_id,
    account_fingerprint, evidence_codes, hard_conflict_codes,
    source_active, status, detected_at, last_seen_at, created_at, updated_at
  )
  SELECT 'dup_c' || left(signal.detector_key, 24), signal.detector_key,
         signal.entity_type, signal.left_identity_id, signal.right_identity_id,
         signal.account_fingerprint, signal.evidence_codes, signal.hard_conflict_codes,
         true, 'NEW', now(), now(), now(), now()
    FROM pg_temp.crm_duplicate_signal signal
  ON CONFLICT (detector_key) DO UPDATE SET
    evidence_codes = EXCLUDED.evidence_codes,
    hard_conflict_codes = EXCLUDED.hard_conflict_codes,
    source_active = true,
    status = CASE
      WHEN existing.status = 'READY_FOR_FOLLOW_UP'
        AND cardinality(EXCLUDED.hard_conflict_codes) > 0
      THEN 'NEW'::app."CrmDuplicateReviewStatus"
      ELSE existing.status END,
    last_seen_at = now(),
    review_version = existing.review_version + CASE
      WHEN existing.evidence_codes IS DISTINCT FROM EXCLUDED.evidence_codes
        OR existing.hard_conflict_codes IS DISTINCT FROM EXCLUDED.hard_conflict_codes
        OR existing.source_active IS DISTINCT FROM true
      THEN 1 ELSE 0 END,
    updated_at = CASE
      WHEN existing.evidence_codes IS DISTINCT FROM EXCLUDED.evidence_codes
        OR existing.hard_conflict_codes IS DISTINCT FROM EXCLUDED.hard_conflict_codes
        OR existing.source_active IS DISTINCT FROM true
      THEN now() ELSE existing.updated_at END;

  INSERT INTO app.crm_duplicate_candidate_event (
    candidate_id, action, from_status, to_status, detail
  )
  SELECT candidate.id, 'DETECTED', NULL, 'NEW',
         jsonb_build_object('entityType', candidate.entity_type::text,
                            'evidenceCount', cardinality(candidate.evidence_codes),
                            'hardConflictCount', cardinality(candidate.hard_conflict_codes))
    FROM app.crm_duplicate_candidate candidate
    JOIN pg_temp.crm_duplicate_signal signal
      ON signal.detector_key = candidate.detector_key
   WHERE NOT EXISTS (
     SELECT 1 FROM app.crm_duplicate_candidate_event event
      WHERE event.candidate_id = candidate.id AND event.action = 'DETECTED'
   );

  INSERT INTO app.crm_duplicate_candidate_event (
    candidate_id, action, from_status, to_status, detail
  )
  SELECT invalidation.candidate_id, 'INVALIDATED_BY_CONFLICT',
         'READY_FOR_FOLLOW_UP', 'NEW',
         jsonb_build_object(
           'reason', 'HARD_CONFLICT_ADDED',
           'priorHardConflictCount', invalidation.prior_conflict_count,
           'nextHardConflictCount', invalidation.next_conflict_count
         )
    FROM pg_temp.crm_duplicate_invalidation invalidation;

  WITH inactivated AS (
    UPDATE app.crm_duplicate_candidate candidate
       SET source_active = false,
           review_version = candidate.review_version + 1,
           updated_at = now()
     WHERE candidate.source_active
       AND NOT EXISTS (
         SELECT 1 FROM pg_temp.crm_duplicate_signal signal
          WHERE signal.detector_key = candidate.detector_key
       )
    RETURNING candidate.id
  ) SELECT count(*) INTO inactivated_count FROM inactivated;

  RETURN QUERY SELECT
    (SELECT count(*)::bigint FROM pg_temp.crm_duplicate_signal),
    opened_count, refreshed_count, inactivated_count;
END;
$$;

REVOKE ALL ON FUNCTION app.reconcile_crm_duplicate_candidates()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.reconcile_crm_duplicate_candidates() TO identity_reconciler;

COMMIT;

