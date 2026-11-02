-- CRM duplicate learning: same-person contacts inside one canonical household.
--
-- CRM remains authoritative. AOA detects one exact-name pair at a time,
-- records a human-selected survivor, and applies only a reversible read overlay.
-- No source record is merged, deleted, archived, or re-parented.

BEGIN;

ALTER TABLE app.crm_duplicate_candidate
  DROP CONSTRAINT crm_duplicate_candidate_evidence_controlled,
  ADD CONSTRAINT crm_duplicate_candidate_evidence_controlled CHECK (
    evidence_codes <@ ARRAY[
      'SOURCE_MERGE_REPLACEMENT',
      'SHARED_CEDAR_RIDGE_USER_ID',
      'EXACT_CUSTODIAN_IDENTITY',
      'OFFICIAL_ACCOUNT_REPLACEMENT',
      'EXACT_NORMALIZED_HOUSEHOLD_NAME',
      'SAME_ADVISOR_AND_STAGE',
      'EMPTY_SHELL_WITH_POPULATED_MATCH',
      'EXACT_NORMALIZED_CONTACT_NAME',
      'SAME_CANONICAL_HOUSEHOLD',
      'SOURCE_CONTACT_DATA_CONCENTRATED',
      'OPERATOR_SUBMITTED'
    ]::text[]
  );

-- The duplicate SECURITY DEFINER owner already has reviewed policies on the
-- registry, client, household, and relationship sources. Contact evidence also
-- needs counts from the FORCE-RLS account mirror; expose rows only to that same
-- non-login function owner, never to the identity_reconciler runtime role.
DO $$
DECLARE
  definer_role text := quote_ident(current_user);
BEGIN
  EXECUTE format(
    'CREATE POLICY client_account_aum_duplicate_definer_read '
    'ON mirror.client_account_aum FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY deal_duplicate_definer_read '
    'ON app.deal FOR SELECT TO %s USING (true)',
    definer_role
  );
END $$;

ALTER TABLE app.crm_duplicate_candidate
  DROP CONSTRAINT crm_duplicate_candidate_conflicts_controlled,
  ADD CONSTRAINT crm_duplicate_candidate_conflicts_controlled CHECK (
    hard_conflict_codes <@ ARRAY[
      'CONFLICTING_MEMBER_IDENTITY',
      'DISTINCT_CUSTODIAN_IDENTITIES',
      'SOURCE_TYPE_MISMATCH',
      'CONFLICTING_CONTACT_IDENTITY'
    ]::text[]
  );

ALTER TABLE app.crm_duplicate_candidate
  DROP CONSTRAINT crm_duplicate_candidate_account_scope,
  ADD CONSTRAINT crm_duplicate_candidate_account_scope CHECK (
    (entity_type = 'ACCOUNT' AND account_fingerprint IS NOT NULL)
    OR (entity_type IN ('HOUSEHOLD', 'CONTACT') AND account_fingerprint IS NULL)
  );

-- The established household sweep does not know about contact signals. Keep
-- durable confirmed contact overlays and active Operations flags from being
-- incorrectly inactivated by that older, household/account-only sweep.
DROP TRIGGER IF EXISTS crm_duplicate_candidate_preserve_operator_flag
  ON app.crm_duplicate_candidate;

CREATE OR REPLACE FUNCTION app.preserve_active_duplicate_overlay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_namespace text := CASE OLD.entity_type::text
    WHEN 'HOUSEHOLD' THEN 'household'
    WHEN 'CONTACT' THEN 'contact'
    ELSE NULL
  END;
  v_identity_type text := OLD.entity_type::text;
BEGIN
  IF NOT OLD.source_active OR NEW.source_active OR v_namespace IS NULL THEN
    RETURN NEW;
  END IF;

  -- The household/account sweep runs immediately before the dedicated contact
  -- sweep and must leave contact state alone. The dedicated function sets this
  -- transaction-local marker when it intentionally inactivates a stale contact
  -- signal.
  IF OLD.entity_type::text = 'CONTACT'
     AND current_setting('app.contact_duplicate_reconcile', true) = '1'
  THEN
    RETURN NEW;
  END IF;

  IF OLD.entity_type::text = 'HOUSEHOLD' AND NOT OLD.operator_flagged THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM app.crm_identity identity_record
         JOIN app.crm_source_mapping mapping
           ON mapping.identity_id = identity_record.id
          AND mapping.source_system = 'CRM'
          AND mapping.source_namespace = v_namespace
          AND mapping.mapping_state = 'ACTIVE'
        WHERE identity_record.id = OLD.left_identity_id
          AND identity_record.identity_type::text = v_identity_type
          AND identity_record.lifecycle_state = 'ACTIVE'
     )
     AND EXISTS (
       SELECT 1
         FROM app.crm_identity identity_record
         JOIN app.crm_source_mapping mapping
           ON mapping.identity_id = identity_record.id
          AND mapping.source_system = 'CRM'
          AND mapping.source_namespace = v_namespace
          AND mapping.mapping_state = 'ACTIVE'
        WHERE identity_record.id = OLD.right_identity_id
          AND identity_record.identity_type::text = v_identity_type
          AND identity_record.lifecycle_state = 'ACTIVE'
     )
  THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.preserve_active_duplicate_overlay()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE TRIGGER crm_duplicate_candidate_preserve_operator_flag
  BEFORE UPDATE OF source_active ON app.crm_duplicate_candidate
  FOR EACH ROW
  WHEN (OLD.source_active AND NOT NEW.source_active)
  EXECUTE FUNCTION app.preserve_active_duplicate_overlay();

CREATE OR REPLACE FUNCTION app.preview_crm_contact_duplicate_candidates()
RETURNS TABLE (
  signals_seen bigint,
  candidates_opened bigint,
  candidates_refreshed bigint,
  candidates_inactivated bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
  WITH suppressed AS MATERIALIZED (
    SELECT CASE
             WHEN candidate.canonical_identity_id = candidate.left_identity_id
               THEN candidate.right_identity_id
             ELSE candidate.left_identity_id
           END AS identity_id
      FROM app.crm_duplicate_candidate candidate
     WHERE candidate.entity_type = 'CONTACT'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
  ), profile AS MATERIALIZED (
    SELECT DISTINCT ON (mapping.identity_id)
           mapping.identity_id,
           client.sf_id AS source_key,
           regexp_replace(
             lower(btrim(coalesce(client.first_name, '') || ' ' || coalesce(client.last_name, ''))),
             '[[:space:]]+', ' ', 'g'
           ) AS normalized_name,
           left(app.resolve_crm_canonical_household_source_key(client.household_id), 15)
             AS canonical_household_key,
           nullif(lower(btrim(client.cedar_ridge_user_id)), '') AS cedar_ridge_user_key,
           nullif(lower(btrim(client.email)), '') AS email_key,
           (SELECT count(*)::bigint
              FROM mirror.client_account_aum account
             WHERE left(account.client_sf_id, 15) = left(client.sf_id, 15)
               AND account.source_present) AS account_count,
           (SELECT count(*)::bigint
              FROM app.deal deal
             WHERE left(deal.client_sf_id, 15) = left(client.sf_id, 15)
               AND deal.archived_at IS NULL) AS deal_count
      FROM app.crm_source_mapping mapping
      JOIN app.crm_identity identity_record
        ON identity_record.id = mapping.identity_id
       AND identity_record.identity_type = 'CONTACT'
       AND identity_record.lifecycle_state = 'ACTIVE'
      JOIN mirror.client client
        ON left(client.sf_id, 15) = left(mapping.source_key, 15)
      LEFT JOIN suppressed ON suppressed.identity_id = mapping.identity_id
     WHERE mapping.source_system = 'CRM'
       AND mapping.source_namespace = 'contact'
       AND mapping.mapping_state = 'ACTIVE'
       AND suppressed.identity_id IS NULL
       AND client.household_id IS NOT NULL
       AND left(client.sf_id, 15) <> left(client.household_id, 15)
     ORDER BY mapping.identity_id, client.synced_at DESC, client.sf_id
  ), ranked AS MATERIALIZED (
    SELECT profile.*,
           row_number() OVER (
             PARTITION BY normalized_name, canonical_household_key
             ORDER BY
               (account_count > 0) DESC,
               account_count DESC,
               (cedar_ridge_user_key IS NOT NULL) DESC,
               (deal_count > 0) DESC,
               (email_key IS NOT NULL) DESC,
               source_key
           ) AS rank_in_cluster,
           count(*) OVER (
             PARTITION BY normalized_name, canonical_household_key
           ) AS cluster_size
      FROM profile
     WHERE normalized_name <> ''
       AND canonical_household_key <> ''
  ), pair AS MATERIALIZED (
    SELECT least(left_side.identity_id, right_side.identity_id) AS left_identity_id,
           greatest(left_side.identity_id, right_side.identity_id) AS right_identity_id,
           left_side.account_count AS first_account_count,
           right_side.account_count AS second_account_count,
           left_side.deal_count AS first_deal_count,
           right_side.deal_count AS second_deal_count,
           left_side.cedar_ridge_user_key AS first_user_key,
           right_side.cedar_ridge_user_key AS second_user_key
      FROM ranked left_side
      JOIN ranked right_side
        ON right_side.normalized_name = left_side.normalized_name
       AND right_side.canonical_household_key = left_side.canonical_household_key
       AND right_side.rank_in_cluster = 2
     WHERE left_side.rank_in_cluster = 1
       AND left_side.cluster_size >= 2
  ), signal AS MATERIALIZED (
    SELECT app.crm_duplicate_fingerprint(
             'CONTACT:' || pair.left_identity_id || ':' || pair.right_identity_id || ':'
           ) AS detector_key,
           pair.left_identity_id,
           pair.right_identity_id,
           ARRAY[
             'EXACT_NORMALIZED_CONTACT_NAME',
             'SAME_CANONICAL_HOUSEHOLD'
           ]::text[] || CASE
             WHEN (pair.first_account_count + pair.first_deal_count = 0)
                <> (pair.second_account_count + pair.second_deal_count = 0)
             THEN ARRAY['SOURCE_CONTACT_DATA_CONCENTRATED']::text[]
             ELSE ARRAY[]::text[]
           END AS evidence_codes,
           CASE
             WHEN pair.first_user_key IS NOT NULL
              AND pair.second_user_key IS NOT NULL
              AND pair.first_user_key <> pair.second_user_key
             THEN ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[]
             ELSE ARRAY[]::text[]
           END AS hard_conflict_codes
      FROM pair
  )
  SELECT
    (SELECT count(*)::bigint FROM signal),
    (SELECT count(*)::bigint FROM signal
      WHERE NOT EXISTS (
        SELECT 1 FROM app.crm_duplicate_candidate existing
         WHERE existing.detector_key = signal.detector_key
      )),
    (SELECT count(*)::bigint FROM signal
      WHERE EXISTS (
        SELECT 1 FROM app.crm_duplicate_candidate existing
         WHERE existing.detector_key = signal.detector_key
      )),
    (SELECT count(*)::bigint
       FROM app.crm_duplicate_candidate existing
      WHERE existing.entity_type = 'CONTACT'
        AND existing.source_active
        AND existing.status <> 'READY_FOR_FOLLOW_UP'
        AND NOT existing.operator_flagged
        AND NOT EXISTS (
          SELECT 1 FROM signal WHERE signal.detector_key = existing.detector_key
        ));
$$;

REVOKE ALL ON FUNCTION app.preview_crm_contact_duplicate_candidates()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.preview_crm_contact_duplicate_candidates()
  TO identity_reconciler;

CREATE OR REPLACE FUNCTION app.reconcile_crm_contact_duplicate_candidates()
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
  PERFORM set_config('app.contact_duplicate_reconcile', '1', true);

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.crm_contact_duplicate_signal (
    detector_key char(64) PRIMARY KEY,
    left_identity_id text NOT NULL,
    right_identity_id text NOT NULL,
    evidence_codes text[] NOT NULL,
    hard_conflict_codes text[] NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.crm_contact_duplicate_signal;
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.crm_contact_duplicate_invalidation (
    candidate_id text PRIMARY KEY,
    prior_conflict_count integer NOT NULL,
    next_conflict_count integer NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.crm_contact_duplicate_invalidation;

  INSERT INTO pg_temp.crm_contact_duplicate_signal (
    detector_key, left_identity_id, right_identity_id,
    evidence_codes, hard_conflict_codes
  )
  WITH suppressed AS MATERIALIZED (
    SELECT CASE
             WHEN candidate.canonical_identity_id = candidate.left_identity_id
               THEN candidate.right_identity_id
             ELSE candidate.left_identity_id
           END AS identity_id
      FROM app.crm_duplicate_candidate candidate
     WHERE candidate.entity_type = 'CONTACT'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
  ), profile AS MATERIALIZED (
    SELECT DISTINCT ON (mapping.identity_id)
           mapping.identity_id,
           client.sf_id AS source_key,
           regexp_replace(
             lower(btrim(coalesce(client.first_name, '') || ' ' || coalesce(client.last_name, ''))),
             '[[:space:]]+', ' ', 'g'
           ) AS normalized_name,
           left(app.resolve_crm_canonical_household_source_key(client.household_id), 15)
             AS canonical_household_key,
           nullif(lower(btrim(client.cedar_ridge_user_id)), '') AS cedar_ridge_user_key,
           nullif(lower(btrim(client.email)), '') AS email_key,
           (SELECT count(*)::bigint
              FROM mirror.client_account_aum account
             WHERE left(account.client_sf_id, 15) = left(client.sf_id, 15)
               AND account.source_present) AS account_count,
           (SELECT count(*)::bigint
              FROM app.deal deal
             WHERE left(deal.client_sf_id, 15) = left(client.sf_id, 15)
               AND deal.archived_at IS NULL) AS deal_count
      FROM app.crm_source_mapping mapping
      JOIN app.crm_identity identity_record
        ON identity_record.id = mapping.identity_id
       AND identity_record.identity_type = 'CONTACT'
       AND identity_record.lifecycle_state = 'ACTIVE'
      JOIN mirror.client client
        ON left(client.sf_id, 15) = left(mapping.source_key, 15)
      LEFT JOIN suppressed ON suppressed.identity_id = mapping.identity_id
     WHERE mapping.source_system = 'CRM'
       AND mapping.source_namespace = 'contact'
       AND mapping.mapping_state = 'ACTIVE'
       AND suppressed.identity_id IS NULL
       AND client.household_id IS NOT NULL
       AND left(client.sf_id, 15) <> left(client.household_id, 15)
     ORDER BY mapping.identity_id, client.synced_at DESC, client.sf_id
  ), ranked AS MATERIALIZED (
    SELECT profile.*,
           row_number() OVER (
             PARTITION BY normalized_name, canonical_household_key
             ORDER BY
               (account_count > 0) DESC,
               account_count DESC,
               (cedar_ridge_user_key IS NOT NULL) DESC,
               (deal_count > 0) DESC,
               (email_key IS NOT NULL) DESC,
               source_key
           ) AS rank_in_cluster,
           count(*) OVER (
             PARTITION BY normalized_name, canonical_household_key
           ) AS cluster_size
      FROM profile
     WHERE normalized_name <> ''
       AND canonical_household_key <> ''
  ), pair AS MATERIALIZED (
    SELECT least(left_side.identity_id, right_side.identity_id) AS left_identity_id,
           greatest(left_side.identity_id, right_side.identity_id) AS right_identity_id,
           left_side.account_count AS first_account_count,
           right_side.account_count AS second_account_count,
           left_side.deal_count AS first_deal_count,
           right_side.deal_count AS second_deal_count,
           left_side.cedar_ridge_user_key AS first_user_key,
           right_side.cedar_ridge_user_key AS second_user_key
      FROM ranked left_side
      JOIN ranked right_side
        ON right_side.normalized_name = left_side.normalized_name
       AND right_side.canonical_household_key = left_side.canonical_household_key
       AND right_side.rank_in_cluster = 2
     WHERE left_side.rank_in_cluster = 1
       AND left_side.cluster_size >= 2
  )
  SELECT app.crm_duplicate_fingerprint(
           'CONTACT:' || pair.left_identity_id || ':' || pair.right_identity_id || ':'
         ),
         pair.left_identity_id,
         pair.right_identity_id,
         ARRAY[
           'EXACT_NORMALIZED_CONTACT_NAME',
           'SAME_CANONICAL_HOUSEHOLD'
         ]::text[] || CASE
           WHEN (pair.first_account_count + pair.first_deal_count = 0)
              <> (pair.second_account_count + pair.second_deal_count = 0)
           THEN ARRAY['SOURCE_CONTACT_DATA_CONCENTRATED']::text[]
           ELSE ARRAY[]::text[]
         END,
         CASE
           WHEN pair.first_user_key IS NOT NULL
            AND pair.second_user_key IS NOT NULL
            AND pair.first_user_key <> pair.second_user_key
           THEN ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[]
           ELSE ARRAY[]::text[]
         END
    FROM pair;

  SELECT count(*) INTO opened_count
    FROM pg_temp.crm_contact_duplicate_signal signal
   WHERE NOT EXISTS (
     SELECT 1 FROM app.crm_duplicate_candidate existing
      WHERE existing.detector_key = signal.detector_key
   );
  SELECT count(*) INTO refreshed_count
    FROM pg_temp.crm_contact_duplicate_signal signal
    JOIN app.crm_duplicate_candidate existing
      ON existing.detector_key = signal.detector_key;

  -- Freeze any existing review rows before calculating invalidations so a
  -- concurrent Operations decision cannot be silently overwritten.
  PERFORM 1
    FROM app.crm_duplicate_candidate existing
    JOIN pg_temp.crm_contact_duplicate_signal signal
      ON signal.detector_key = existing.detector_key
   FOR UPDATE OF existing;

  INSERT INTO pg_temp.crm_contact_duplicate_invalidation (
    candidate_id, prior_conflict_count, next_conflict_count
  )
  SELECT existing.id,
         cardinality(existing.hard_conflict_codes),
         cardinality(signal.hard_conflict_codes)
    FROM app.crm_duplicate_candidate existing
    JOIN pg_temp.crm_contact_duplicate_signal signal
      ON signal.detector_key = existing.detector_key
   WHERE existing.status = 'READY_FOR_FOLLOW_UP'
     AND cardinality(signal.hard_conflict_codes) > 0;

  INSERT INTO app.crm_duplicate_candidate AS existing (
    id, detector_key, entity_type, left_identity_id, right_identity_id,
    account_fingerprint, evidence_codes, hard_conflict_codes,
    source_active, status, detected_at, last_seen_at, created_at, updated_at
  )
  SELECT 'dup_c' || left(signal.detector_key, 24), signal.detector_key,
         'CONTACT', signal.left_identity_id, signal.right_identity_id,
         NULL, signal.evidence_codes, signal.hard_conflict_codes,
         true, 'NEW', now(), now(), now(), now()
    FROM pg_temp.crm_contact_duplicate_signal signal
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
         jsonb_build_object(
           'entityType', 'CONTACT',
           'evidenceCount', cardinality(candidate.evidence_codes),
           'hardConflictCount', cardinality(candidate.hard_conflict_codes)
         )
    FROM app.crm_duplicate_candidate candidate
    JOIN pg_temp.crm_contact_duplicate_signal signal
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
    FROM pg_temp.crm_contact_duplicate_invalidation invalidation;

  WITH inactivated AS (
    UPDATE app.crm_duplicate_candidate candidate
       SET source_active = false,
           review_version = candidate.review_version + 1,
           updated_at = now()
     WHERE candidate.entity_type = 'CONTACT'
       AND candidate.source_active
       AND candidate.status <> 'READY_FOR_FOLLOW_UP'
       AND NOT candidate.operator_flagged
       AND NOT EXISTS (
         SELECT 1 FROM pg_temp.crm_contact_duplicate_signal signal
          WHERE signal.detector_key = candidate.detector_key
       )
    RETURNING candidate.id
  ) SELECT count(*) INTO inactivated_count FROM inactivated;

  RETURN QUERY SELECT
    (SELECT count(*)::bigint FROM pg_temp.crm_contact_duplicate_signal),
    opened_count, refreshed_count, inactivated_count;
END;
$$;

REVOKE ALL ON FUNCTION app.reconcile_crm_contact_duplicate_candidates()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.reconcile_crm_contact_duplicate_candidates()
  TO identity_reconciler;

-- Resolve one Contact source key through a bounded, unambiguous confirmation
-- chain. As with households, cycles and branching fail closed to the input.
CREATE OR REPLACE FUNCTION app.resolve_crm_canonical_contact_source_key(
  p_source_key text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
DECLARE
  v_original text := p_source_key;
  v_current text := p_source_key;
  v_targets text[];
  v_seen text[] := ARRAY[p_source_key];
  v_depth integer;
BEGIN
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN RETURN p_source_key; END IF;
  FOR v_depth IN 1..8 LOOP
    SELECT array_agg(DISTINCT target_client.sf_id ORDER BY target_client.sf_id)
      INTO v_targets
      FROM app.crm_duplicate_candidate candidate
      JOIN app.crm_source_mapping suppressed
        ON suppressed.identity_id = CASE
             WHEN candidate.canonical_identity_id = candidate.left_identity_id
               THEN candidate.right_identity_id
             ELSE candidate.left_identity_id
           END
       AND suppressed.source_system = 'CRM'
       AND suppressed.source_namespace = 'contact'
       AND suppressed.mapping_state = 'ACTIVE'
      JOIN app.crm_source_mapping target_mapping
        ON target_mapping.identity_id = candidate.canonical_identity_id
       AND target_mapping.source_system = 'CRM'
       AND target_mapping.source_namespace = 'contact'
       AND target_mapping.mapping_state = 'ACTIVE'
      JOIN mirror.client target_client
        ON left(target_client.sf_id, 15) = left(target_mapping.source_key, 15)
     WHERE candidate.entity_type = 'CONTACT'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
       AND left(suppressed.source_key, 15) = left(v_current, 15);

    IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN RETURN v_current; END IF;
    IF cardinality(v_targets) <> 1 OR v_targets[1] = ANY(v_seen) THEN RETURN v_original; END IF;
    v_current := v_targets[1];
    v_seen := array_append(v_seen, v_current);
  END LOOP;
  RETURN v_original;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_crm_canonical_contact_source_key(text)
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_contact_source_key(text)
  TO app_rw;

GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_household_source_key(text)
  TO identity_reconciler;

CREATE OR REPLACE FUNCTION app.resolve_crm_canonical_contact_overlays(
  p_source_keys text[]
)
RETURNS TABLE (source_key text, canonical_source_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
  WITH requested AS MATERIALIZED (
    SELECT DISTINCT item.source_key, left(item.source_key, 15) AS normalized_key
      FROM unnest(CASE
        WHEN cardinality(p_source_keys) BETWEEN 1 AND 10000 THEN p_source_keys
        ELSE ARRAY[]::text[]
      END) item(source_key)
     WHERE item.source_key IS NOT NULL AND btrim(item.source_key) <> ''
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
       AND suppressed.source_namespace = 'contact'
       AND suppressed.mapping_state = 'ACTIVE'
      JOIN requested
        ON requested.normalized_key = left(suppressed.source_key, 15)
     WHERE candidate.entity_type = 'CONTACT'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
  ), resolved AS MATERIALIZED (
    SELECT suppressed.source_key,
           app.resolve_crm_canonical_contact_source_key(suppressed.source_key)
             AS canonical_source_key
      FROM suppressed_requested suppressed
  )
  SELECT resolved.source_key, resolved.canonical_source_key
    FROM resolved
    JOIN requested visible_canonical
      ON visible_canonical.normalized_key = left(resolved.canonical_source_key, 15)
   WHERE left(resolved.source_key, 15) <> left(resolved.canonical_source_key, 15)
   ORDER BY resolved.source_key;
$$;

REVOKE ALL ON FUNCTION app.resolve_crm_canonical_contact_overlays(text[])
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_contact_overlays(text[])
  TO app_rw;

-- Version 4 keeps v3 available during rolling deploys and adds the contact-
-- specific confirmation reason. All existing conflict and optimistic-lock
-- safeguards remain unchanged.
CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate_v4(
  p_candidate_id text,
  p_expected_review_version integer,
  p_decision text,
  p_snoozed_until timestamptz DEFAULT NULL,
  p_decision_reason text DEFAULT NULL,
  p_canonical_identity_id text DEFAULT NULL
)
RETURNS TABLE (
  result_code text,
  previous_status text,
  entity_type text,
  evidence_count integer,
  hard_conflict_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_role text := current_setting('app.user_role', true);
  v_email text := nullif(btrim(current_setting('app.user_email', true)), '');
  v_candidate record;
  v_saved integer;
  v_canonical_side text;
BEGIN
  IF v_role NOT IN ('ADMIN', 'OPERATIONS') OR v_email IS NULL THEN
    RAISE EXCEPTION 'CRM duplicate review is restricted to Operations'
      USING ERRCODE = '42501';
  END IF;
  IF p_candidate_id IS NULL OR p_candidate_id !~ '^dup_c[0-9a-f]{24}$'
     OR p_expected_review_version IS NULL OR p_expected_review_version < 0
     OR p_decision IS NULL
     OR p_decision NOT IN ('NEW', 'NOT_DUPLICATE', 'SNOOZED', 'READY_FOR_FOLLOW_UP')
  THEN
    RETURN QUERY SELECT 'INVALID', NULL::text, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;
  IF (p_decision = 'SNOOZED' AND (
        p_snoozed_until IS NULL
        OR p_snoozed_until <= statement_timestamp()
        OR p_snoozed_until > statement_timestamp() + interval '366 days'
      )) OR (p_decision <> 'SNOOZED' AND p_snoozed_until IS NOT NULL)
  THEN
    RETURN QUERY SELECT 'INVALID', NULL::text, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  SELECT candidate.status::text AS status,
         candidate.entity_type::text AS entity_type,
         candidate.left_identity_id, candidate.right_identity_id,
         candidate.evidence_codes, candidate.hard_conflict_codes,
         candidate.source_active
    INTO v_candidate
    FROM app.crm_duplicate_candidate candidate
   WHERE candidate.id = p_candidate_id
     AND candidate.review_version = p_expected_review_version
     AND (candidate.source_active OR p_decision = 'NEW')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CONFLICT', NULL::text, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  IF (p_decision = 'READY_FOR_FOLLOW_UP' AND (
        p_decision_reason IS NULL
        OR p_decision_reason NOT IN (
          'SAME_RELATIONSHIP_SOURCE_DUPLICATE',
          'SAME_PERSON_SOURCE_DUPLICATE',
          'OFFICIAL_SOURCE_REPLACEMENT',
          'SHARED_IDENTIFIER_CONFIRMED'
        )
        OR p_canonical_identity_id IS NULL
        OR p_canonical_identity_id NOT IN (
          v_candidate.left_identity_id, v_candidate.right_identity_id
        )
        OR cardinality(v_candidate.hard_conflict_codes) > 0
        OR (v_candidate.entity_type = 'CONTACT'
          AND p_decision_reason <> 'SAME_PERSON_SOURCE_DUPLICATE')
        OR (v_candidate.entity_type <> 'CONTACT'
          AND p_decision_reason = 'SAME_PERSON_SOURCE_DUPLICATE')
      ))
     OR (p_decision = 'NOT_DUPLICATE' AND (
        p_decision_reason IS NULL
        OR p_decision_reason NOT IN (
          'DISTINCT_PEOPLE_OR_HOUSEHOLDS', 'DISTINCT_ACCOUNTS', 'SOURCE_DATA_ERROR'
        )
        OR p_canonical_identity_id IS NOT NULL
      ))
     OR (p_decision IN ('NEW', 'SNOOZED') AND (
        p_decision_reason IS NOT NULL OR p_canonical_identity_id IS NOT NULL
      ))
  THEN
    RETURN QUERY SELECT 'INVALID', v_candidate.status, v_candidate.entity_type,
      cardinality(v_candidate.evidence_codes), cardinality(v_candidate.hard_conflict_codes);
    RETURN;
  END IF;
  IF p_decision = 'NEW' AND v_candidate.status <> 'READY_FOR_FOLLOW_UP' THEN
    RETURN QUERY SELECT 'INVALID', v_candidate.status, v_candidate.entity_type,
      cardinality(v_candidate.evidence_codes), cardinality(v_candidate.hard_conflict_codes);
    RETURN;
  END IF;

  v_canonical_side := CASE
    WHEN p_canonical_identity_id = v_candidate.left_identity_id THEN 'LEFT'
    WHEN p_canonical_identity_id = v_candidate.right_identity_id THEN 'RIGHT'
    ELSE NULL
  END;

  UPDATE app.crm_duplicate_candidate candidate
     SET status = p_decision::app."CrmDuplicateReviewStatus",
         snoozed_until = CASE WHEN p_decision = 'SNOOZED' THEN p_snoozed_until ELSE NULL END,
         decision_reason = p_decision_reason,
         canonical_identity_id = p_canonical_identity_id,
         reviewed_at = statement_timestamp(),
         reviewed_by = v_email,
         updated_by = v_email,
         review_version = candidate.review_version + 1,
         updated_at = statement_timestamp()
   WHERE candidate.id = p_candidate_id
     AND candidate.review_version = p_expected_review_version
     AND (candidate.source_active OR p_decision = 'NEW')
     AND (p_decision <> 'READY_FOR_FOLLOW_UP'
       OR cardinality(candidate.hard_conflict_codes) = 0);
  GET DIAGNOSTICS v_saved = ROW_COUNT;
  IF v_saved <> 1 THEN
    RETURN QUERY SELECT 'CONFLICT', NULL::text, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO app.crm_duplicate_candidate_event (
    candidate_id, action, actor_email, actor_role, from_status, to_status, detail
  ) VALUES (
    p_candidate_id,
    CASE WHEN p_decision = 'NEW' THEN 'REOPENED' ELSE p_decision END,
    v_email, v_role,
    v_candidate.status::app."CrmDuplicateReviewStatus",
    p_decision::app."CrmDuplicateReviewStatus",
    CASE
      WHEN p_decision = 'SNOOZED' THEN jsonb_build_object('snoozedUntil', p_snoozed_until)
      WHEN p_decision = 'NEW' THEN jsonb_build_object('reopened', true)
      ELSE jsonb_build_object('reason', p_decision_reason, 'canonicalSide', v_canonical_side)
    END
  );

  RETURN QUERY SELECT 'UPDATED', v_candidate.status, v_candidate.entity_type,
    cardinality(v_candidate.evidence_codes), cardinality(v_candidate.hard_conflict_codes);
END;
$$;

REVOKE ALL ON FUNCTION app.review_crm_duplicate_candidate_v4(
  text, integer, text, timestamptz, text, text
) FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.review_crm_duplicate_candidate_v4(
  text, integer, text, timestamptz, text, text
) TO app_rw;

COMMIT;
