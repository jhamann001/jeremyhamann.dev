-- CRM duplicate review: Operations-submitted household pairs.
--
-- This adds a review candidate only. It does not merge, archive, re-parent,
-- select a survivor, or write to CRM. A separate human confirmation is
-- still required before AOA's reversible canonical overlay can become active.

BEGIN;

ALTER TABLE app.crm_duplicate_candidate
  ADD COLUMN operator_flagged boolean NOT NULL DEFAULT false;

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
      'OPERATOR_SUBMITTED'
    ]::text[]
  );

ALTER TABLE app.crm_duplicate_candidate_event
  DROP CONSTRAINT crm_duplicate_candidate_event_action_controlled,
  ADD CONSTRAINT crm_duplicate_candidate_event_action_controlled CHECK (
    action IN (
      'DETECTED', 'OPERATOR_FLAGGED', 'NOT_DUPLICATE', 'SNOOZED',
      'READY_FOR_FOLLOW_UP', 'REOPENED', 'INVALIDATED_BY_CONFLICT'
    )
  );

-- A scheduled detector sweep must not discard a pair explicitly submitted for
-- review merely because it does not match today's automatic detector rules.
-- The protection ends if either source identity no longer has an active
-- CRM household mapping, so genuinely retired source records still fail
-- closed on the next sweep.
CREATE OR REPLACE FUNCTION app.preserve_active_operator_duplicate_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF OLD.operator_flagged
     AND OLD.source_active
     AND NOT NEW.source_active
     AND EXISTS (
       SELECT 1
         FROM app.crm_identity identity_record
         JOIN app.crm_source_mapping mapping
           ON mapping.identity_id = identity_record.id
          AND mapping.source_system = 'CRM'
          AND mapping.source_namespace = 'household'
          AND mapping.mapping_state = 'ACTIVE'
        WHERE identity_record.id = OLD.left_identity_id
          AND identity_record.identity_type = 'HOUSEHOLD'
          AND identity_record.lifecycle_state = 'ACTIVE'
     )
     AND EXISTS (
       SELECT 1
         FROM app.crm_identity identity_record
         JOIN app.crm_source_mapping mapping
           ON mapping.identity_id = identity_record.id
          AND mapping.source_system = 'CRM'
          AND mapping.source_namespace = 'household'
          AND mapping.mapping_state = 'ACTIVE'
        WHERE identity_record.id = OLD.right_identity_id
          AND identity_record.identity_type = 'HOUSEHOLD'
          AND identity_record.lifecycle_state = 'ACTIVE'
     )
  THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.preserve_active_operator_duplicate_flag()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE TRIGGER crm_duplicate_candidate_preserve_operator_flag
  BEFORE UPDATE OF source_active ON app.crm_duplicate_candidate
  FOR EACH ROW
  WHEN (OLD.source_active AND NOT NEW.source_active AND OLD.operator_flagged)
  EXECUTE FUNCTION app.preserve_active_operator_duplicate_flag();

CREATE OR REPLACE FUNCTION app.flag_crm_duplicate_households(
  p_left_crm_id text,
  p_right_crm_id text
)
RETURNS TABLE (result_code text, candidate_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
DECLARE
  v_role text := current_setting('app.user_role', true);
  v_email text := nullif(btrim(current_setting('app.user_email', true)), '');
  v_left_ids text[];
  v_right_ids text[];
  v_left_identity_id text;
  v_right_identity_id text;
  v_ordered_left text;
  v_ordered_right text;
  v_detector_key char(64);
  v_candidate_id text;
  v_was_flagged boolean;
  v_conflicts text[] := ARRAY[]::text[];
BEGIN
  IF v_role NOT IN ('ADMIN', 'OPERATIONS') OR v_email IS NULL THEN
    RAISE EXCEPTION 'CRM duplicate flagging is restricted to Operations'
      USING ERRCODE = '42501';
  END IF;
  IF p_left_crm_id IS NULL OR p_right_crm_id IS NULL
     OR btrim(p_left_crm_id) = '' OR btrim(p_right_crm_id) = ''
     OR length(btrim(p_left_crm_id)) > 64
     OR length(btrim(p_right_crm_id)) > 64
     OR left(btrim(p_left_crm_id), 15) = left(btrim(p_right_crm_id), 15)
  THEN
    RETURN QUERY SELECT 'INVALID', NULL::text;
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT mapping.identity_id ORDER BY mapping.identity_id)
    INTO v_left_ids
    FROM app.crm_source_mapping mapping
    JOIN app.crm_identity identity_record
      ON identity_record.id = mapping.identity_id
     AND identity_record.identity_type = 'HOUSEHOLD'
     AND identity_record.lifecycle_state = 'ACTIVE'
    JOIN mirror.household source_record
      ON left(source_record.sf_id, 15) = left(mapping.source_key, 15)
   WHERE mapping.source_system = 'CRM'
     AND mapping.source_namespace = 'household'
     AND mapping.mapping_state = 'ACTIVE'
     AND left(mapping.source_key, 15) = left(btrim(p_left_crm_id), 15);

  SELECT array_agg(DISTINCT mapping.identity_id ORDER BY mapping.identity_id)
    INTO v_right_ids
    FROM app.crm_source_mapping mapping
    JOIN app.crm_identity identity_record
      ON identity_record.id = mapping.identity_id
     AND identity_record.identity_type = 'HOUSEHOLD'
     AND identity_record.lifecycle_state = 'ACTIVE'
    JOIN mirror.household source_record
      ON left(source_record.sf_id, 15) = left(mapping.source_key, 15)
   WHERE mapping.source_system = 'CRM'
     AND mapping.source_namespace = 'household'
     AND mapping.mapping_state = 'ACTIVE'
     AND left(mapping.source_key, 15) = left(btrim(p_right_crm_id), 15);

  IF cardinality(v_left_ids) <> 1 OR cardinality(v_right_ids) <> 1 THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::text;
    RETURN;
  END IF;
  v_left_identity_id := v_left_ids[1];
  v_right_identity_id := v_right_ids[1];
  IF v_left_identity_id = v_right_identity_id THEN
    RETURN QUERY SELECT 'INVALID', NULL::text;
    RETURN;
  END IF;

  -- A suppressed source must be submitted using its already-selected survivor
  -- instead. This prevents an ambiguous or cyclic canonical chain.
  IF EXISTS (
    SELECT 1
      FROM app.crm_duplicate_candidate candidate
     WHERE candidate.entity_type = 'HOUSEHOLD'
       AND candidate.status = 'READY_FOR_FOLLOW_UP'
       AND candidate.canonical_identity_id IS NOT NULL
       AND (
         (v_left_identity_id IN (candidate.left_identity_id, candidate.right_identity_id)
           AND candidate.canonical_identity_id <> v_left_identity_id)
         OR
         (v_right_identity_id IN (candidate.left_identity_id, candidate.right_identity_id)
           AND candidate.canonical_identity_id <> v_right_identity_id)
       )
  ) THEN
    RETURN QUERY SELECT 'CANONICALIZED_SOURCE', NULL::text;
    RETURN;
  END IF;

  v_ordered_left := least(v_left_identity_id, v_right_identity_id);
  v_ordered_right := greatest(v_left_identity_id, v_right_identity_id);
  v_detector_key := app.crm_duplicate_fingerprint(
    'HOUSEHOLD:' || v_ordered_left || ':' || v_ordered_right || ':'
  );

  SELECT candidate.id, candidate.operator_flagged
    INTO v_candidate_id, v_was_flagged
    FROM app.crm_duplicate_candidate candidate
   WHERE candidate.detector_key = v_detector_key
   FOR UPDATE;

  IF FOUND THEN
    UPDATE app.crm_duplicate_candidate candidate
       SET operator_flagged = true,
           source_active = true,
           review_version = candidate.review_version + CASE
             WHEN candidate.operator_flagged AND candidate.source_active THEN 0 ELSE 1 END,
           updated_by = CASE WHEN candidate.operator_flagged THEN candidate.updated_by ELSE v_email END,
           updated_at = CASE
             WHEN candidate.operator_flagged AND candidate.source_active
               THEN candidate.updated_at ELSE statement_timestamp() END
     WHERE candidate.id = v_candidate_id;
    IF NOT v_was_flagged THEN
      INSERT INTO app.crm_duplicate_candidate_event (
        candidate_id, action, actor_email, actor_role, from_status, to_status, detail
      )
      SELECT candidate.id, 'OPERATOR_FLAGGED', v_email, v_role,
             candidate.status, candidate.status,
             jsonb_build_object('entityType', 'HOUSEHOLD', 'origin', 'CRM_EXPLORER')
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = v_candidate_id;
      RETURN QUERY SELECT 'FLAGGED', v_candidate_id;
    ELSE
      RETURN QUERY SELECT 'EXISTING', v_candidate_id;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM app.crm_source_mapping left_mapping
      JOIN mirror.client left_member
        ON left(left_member.household_id, 15) = left(left_mapping.source_key, 15)
      JOIN app.crm_source_mapping right_mapping
        ON right_mapping.identity_id = v_ordered_right
       AND right_mapping.source_system = 'CRM'
       AND right_mapping.source_namespace = 'household'
       AND right_mapping.mapping_state = 'ACTIVE'
      JOIN mirror.client right_member
        ON left(right_member.household_id, 15) = left(right_mapping.source_key, 15)
       AND nullif(lower(btrim(right_member.email)), '')
         = nullif(lower(btrim(left_member.email)), '')
     WHERE left_mapping.identity_id = v_ordered_left
       AND left_mapping.source_system = 'CRM'
       AND left_mapping.source_namespace = 'household'
       AND left_mapping.mapping_state = 'ACTIVE'
       AND nullif(lower(btrim(left_member.cedar_ridge_user_id)), '') IS NOT NULL
       AND nullif(lower(btrim(right_member.cedar_ridge_user_id)), '') IS NOT NULL
       AND lower(btrim(left_member.cedar_ridge_user_id))
         <> lower(btrim(right_member.cedar_ridge_user_id))
  ) THEN
    v_conflicts := ARRAY['CONFLICTING_MEMBER_IDENTITY']::text[];
  END IF;

  v_candidate_id := 'dup_c' || left(v_detector_key, 24);
  INSERT INTO app.crm_duplicate_candidate (
    id, detector_key, entity_type, left_identity_id, right_identity_id,
    account_fingerprint, evidence_codes, hard_conflict_codes,
    operator_flagged, source_active, status, updated_by,
    detected_at, last_seen_at, created_at, updated_at
  ) VALUES (
    v_candidate_id, v_detector_key, 'HOUSEHOLD', v_ordered_left, v_ordered_right,
    NULL, ARRAY['OPERATOR_SUBMITTED']::text[], v_conflicts,
    true, true, 'NEW', v_email,
    statement_timestamp(), statement_timestamp(), statement_timestamp(), statement_timestamp()
  );

  INSERT INTO app.crm_duplicate_candidate_event (
    candidate_id, action, actor_email, actor_role, from_status, to_status, detail
  ) VALUES (
    v_candidate_id, 'OPERATOR_FLAGGED', v_email, v_role, NULL, 'NEW',
    jsonb_build_object('entityType', 'HOUSEHOLD', 'origin', 'CRM_EXPLORER')
  );

  RETURN QUERY SELECT 'CREATED', v_candidate_id;
END;
$$;

REVOKE ALL ON FUNCTION app.flag_crm_duplicate_households(text, text)
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.flag_crm_duplicate_households(text, text)
  TO app_rw;

COMMIT;
