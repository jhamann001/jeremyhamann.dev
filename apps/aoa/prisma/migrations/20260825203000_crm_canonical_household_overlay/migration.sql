-- CRM duplicate learning, phase 2: reversible AOA household canonicalization.
--
-- A confirmed household pair changes only AOA read behavior. CRM source
-- records, CRM identities, source mappings, and relationship rows remain
-- untouched. The selected household becomes the route/list survivor until an
-- Operations user reopens the review or a later detector conflict invalidates
-- the decision.

BEGIN;

ALTER TABLE app.crm_duplicate_candidate_event
  DROP CONSTRAINT crm_duplicate_candidate_event_action_controlled,
  ADD CONSTRAINT crm_duplicate_candidate_event_action_controlled CHECK (
    action IN (
      'DETECTED', 'NOT_DUPLICATE', 'SNOOZED', 'READY_FOR_FOLLOW_UP',
      'REOPENED', 'INVALIDATED_BY_CONFLICT'
    )
  );

-- Resolve one visible CRM household key through any confirmed AOA
-- canonicalization chain. The function accepts and returns one opaque key, so
-- it cannot enumerate the duplicate table. Ambiguous targets, cycles, or an
-- excessive chain fail closed to the original key.
CREATE OR REPLACE FUNCTION app.resolve_crm_canonical_household_source_key(
  p_source_key text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_original text := p_source_key;
  v_current text := p_source_key;
  v_targets text[];
  v_seen text[] := ARRAY[p_source_key];
  v_depth integer;
BEGIN
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN
    RETURN p_source_key;
  END IF;

  FOR v_depth IN 1..8 LOOP
    SELECT array_agg(DISTINCT target_household.sf_id ORDER BY target_household.sf_id)
      INTO v_targets
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
      JOIN app.crm_source_mapping target_mapping
        ON target_mapping.identity_id = candidate.canonical_identity_id
       AND target_mapping.source_system = 'CRM'
       AND target_mapping.source_namespace = 'household'
       AND target_mapping.mapping_state = 'ACTIVE'
      JOIN mirror.household target_household
        ON left(target_household.sf_id, 15) = left(target_mapping.source_key, 15)
     WHERE candidate.entity_type = 'HOUSEHOLD'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
       AND left(suppressed.source_key, 15) = left(v_current, 15);

    IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
      RETURN v_current;
    END IF;
    IF cardinality(v_targets) <> 1 OR v_targets[1] = ANY(v_seen) THEN
      RETURN v_original;
    END IF;

    v_current := v_targets[1];
    v_seen := array_append(v_seen, v_current);
  END LOOP;

  RETURN v_original;
END;
$$;

REVOKE ALL ON FUNCTION app.resolve_crm_canonical_household_source_key(text)
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_household_source_key(text)
  TO app_rw;

-- Version 3 adds a bounded NEW transition for reopening a confirmed outcome.
-- Older app revisions retain v2 during rolling deployment.
CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate_v3(
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
     OR p_decision NOT IN (
       'NEW', 'NOT_DUPLICATE', 'SNOOZED', 'READY_FOR_FOLLOW_UP'
     )
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
  IF (p_decision = 'READY_FOR_FOLLOW_UP' AND (
        p_decision_reason IS NULL OR p_decision_reason NOT IN (
          'SAME_RELATIONSHIP_SOURCE_DUPLICATE',
          'OFFICIAL_SOURCE_REPLACEMENT',
          'SHARED_IDENTIFIER_CONFIRMED'
        ) OR p_canonical_identity_id IS NULL
      )) OR (p_decision = 'NOT_DUPLICATE' AND (
        p_decision_reason IS NULL OR p_decision_reason NOT IN (
          'DISTINCT_PEOPLE_OR_HOUSEHOLDS',
          'DISTINCT_ACCOUNTS',
          'SOURCE_DATA_ERROR'
        ) OR p_canonical_identity_id IS NOT NULL
      )) OR (p_decision IN ('NEW', 'SNOOZED') AND (
        p_decision_reason IS NOT NULL OR p_canonical_identity_id IS NOT NULL
      ))
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
  IF p_decision = 'NEW' AND v_candidate.status <> 'READY_FOR_FOLLOW_UP' THEN
    RETURN QUERY SELECT 'INVALID', v_candidate.status, v_candidate.entity_type,
      cardinality(v_candidate.evidence_codes),
      cardinality(v_candidate.hard_conflict_codes);
    RETURN;
  END IF;
  IF p_decision = 'READY_FOR_FOLLOW_UP' AND (
       cardinality(v_candidate.hard_conflict_codes) > 0
       OR p_canonical_identity_id NOT IN (
         v_candidate.left_identity_id, v_candidate.right_identity_id
       )
     )
  THEN
    RETURN QUERY SELECT 'INVALID', v_candidate.status, v_candidate.entity_type,
      cardinality(v_candidate.evidence_codes),
      cardinality(v_candidate.hard_conflict_codes);
    RETURN;
  END IF;

  v_canonical_side := CASE
    WHEN p_canonical_identity_id = v_candidate.left_identity_id THEN 'LEFT'
    WHEN p_canonical_identity_id = v_candidate.right_identity_id THEN 'RIGHT'
    ELSE NULL
  END;

  UPDATE app.crm_duplicate_candidate candidate
     SET status = p_decision::app."CrmDuplicateReviewStatus",
         snoozed_until = CASE WHEN p_decision = 'SNOOZED'
           THEN p_snoozed_until ELSE NULL END,
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
    candidate_id, action, actor_email, actor_role,
    from_status, to_status, detail
  ) VALUES (
    p_candidate_id,
    CASE WHEN p_decision = 'NEW' THEN 'REOPENED' ELSE p_decision END,
    v_email, v_role,
    v_candidate.status::app."CrmDuplicateReviewStatus",
    p_decision::app."CrmDuplicateReviewStatus",
    CASE
      WHEN p_decision = 'SNOOZED'
        THEN jsonb_build_object('snoozedUntil', p_snoozed_until)
      WHEN p_decision = 'NEW'
        THEN jsonb_build_object('reopened', true)
      ELSE jsonb_build_object(
        'reason', p_decision_reason,
        'canonicalSide', v_canonical_side
      )
    END
  );

  RETURN QUERY SELECT 'UPDATED', v_candidate.status, v_candidate.entity_type,
    cardinality(v_candidate.evidence_codes),
    cardinality(v_candidate.hard_conflict_codes);
END;
$$;

REVOKE ALL ON FUNCTION app.review_crm_duplicate_candidate_v3(
  text, integer, text, timestamptz, text, text
) FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.review_crm_duplicate_candidate_v3(
  text, integer, text, timestamptz, text, text
) TO app_rw;

COMMIT;
