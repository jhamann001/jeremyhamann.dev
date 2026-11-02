-- Operations escape hatch for verified same-person contacts whose names do not
-- match exactly (for example a nickname and legal first name).
--
-- The function only opens the existing AOA review workflow. It requires two
-- active CRM contacts in the same canonical AOA household and never
-- selects a survivor or writes to CRM.

BEGIN;

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

  -- The dedicated contact sweep may inactivate detector-owned contact rows,
  -- but Operations-submitted contact comparisons remain active while both
  -- source contacts do. This mirrors the existing household escape hatch.
  IF OLD.entity_type::text = 'CONTACT'
     AND current_setting('app.contact_duplicate_reconcile', true) = '1'
     AND NOT OLD.operator_flagged
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

CREATE OR REPLACE FUNCTION app.flag_crm_duplicate_contacts(
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
  v_left_household_key text;
  v_right_household_key text;
  v_left_user_key text;
  v_right_user_key text;
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
     OR btrim(p_left_crm_id) !~ '^003[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'
     OR btrim(p_right_crm_id) !~ '^003[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'
     OR left(btrim(p_left_crm_id), 15) = left(btrim(p_right_crm_id), 15)
  THEN
    RETURN QUERY SELECT 'INVALID', NULL::text;
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT mapping.identity_id ORDER BY mapping.identity_id),
         min(left(app.resolve_crm_canonical_household_source_key(client.household_id), 15)),
         min(nullif(lower(btrim(client.cedar_ridge_user_id)), ''))
    INTO v_left_ids, v_left_household_key, v_left_user_key
    FROM app.crm_source_mapping mapping
    JOIN app.crm_identity identity_record
      ON identity_record.id = mapping.identity_id
     AND identity_record.identity_type = 'CONTACT'
     AND identity_record.lifecycle_state = 'ACTIVE'
    JOIN mirror.client client
      ON left(client.sf_id, 15) = left(mapping.source_key, 15)
   WHERE mapping.source_system = 'CRM'
     AND mapping.source_namespace = 'contact'
     AND mapping.mapping_state = 'ACTIVE'
     AND left(mapping.source_key, 15) = left(btrim(p_left_crm_id), 15);

  SELECT array_agg(DISTINCT mapping.identity_id ORDER BY mapping.identity_id),
         min(left(app.resolve_crm_canonical_household_source_key(client.household_id), 15)),
         min(nullif(lower(btrim(client.cedar_ridge_user_id)), ''))
    INTO v_right_ids, v_right_household_key, v_right_user_key
    FROM app.crm_source_mapping mapping
    JOIN app.crm_identity identity_record
      ON identity_record.id = mapping.identity_id
     AND identity_record.identity_type = 'CONTACT'
     AND identity_record.lifecycle_state = 'ACTIVE'
    JOIN mirror.client client
      ON left(client.sf_id, 15) = left(mapping.source_key, 15)
   WHERE mapping.source_system = 'CRM'
     AND mapping.source_namespace = 'contact'
     AND mapping.mapping_state = 'ACTIVE'
     AND left(mapping.source_key, 15) = left(btrim(p_right_crm_id), 15);

  IF cardinality(v_left_ids) <> 1 OR cardinality(v_right_ids) <> 1 THEN
    RETURN QUERY SELECT 'NOT_FOUND', NULL::text;
    RETURN;
  END IF;
  IF v_left_household_key IS NULL OR v_right_household_key IS NULL
     OR v_left_household_key <> v_right_household_key
  THEN
    RETURN QUERY SELECT 'DIFFERENT_HOUSEHOLD', NULL::text;
    RETURN;
  END IF;

  v_left_identity_id := v_left_ids[1];
  v_right_identity_id := v_right_ids[1];
  IF v_left_identity_id = v_right_identity_id THEN
    RETURN QUERY SELECT 'INVALID', NULL::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM app.crm_duplicate_candidate candidate
     WHERE candidate.entity_type = 'CONTACT'
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
    'CONTACT:' || v_ordered_left || ':' || v_ordered_right || ':'
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
             jsonb_build_object('entityType', 'CONTACT', 'origin', 'CRM_EXPLORER')
        FROM app.crm_duplicate_candidate candidate
       WHERE candidate.id = v_candidate_id;
      RETURN QUERY SELECT 'FLAGGED', v_candidate_id;
    ELSE
      RETURN QUERY SELECT 'EXISTING', v_candidate_id;
    END IF;
    RETURN;
  END IF;

  IF v_left_user_key IS NOT NULL AND v_right_user_key IS NOT NULL
     AND v_left_user_key <> v_right_user_key
  THEN
    v_conflicts := ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[];
  END IF;

  v_candidate_id := 'dup_c' || left(v_detector_key, 24);
  INSERT INTO app.crm_duplicate_candidate (
    id, detector_key, entity_type, left_identity_id, right_identity_id,
    account_fingerprint, evidence_codes, hard_conflict_codes,
    operator_flagged, source_active, status, updated_by,
    detected_at, last_seen_at, created_at, updated_at
  ) VALUES (
    v_candidate_id, v_detector_key, 'CONTACT', v_ordered_left, v_ordered_right,
    NULL, ARRAY['OPERATOR_SUBMITTED', 'SAME_CANONICAL_HOUSEHOLD']::text[], v_conflicts,
    true, true, 'NEW', v_email,
    statement_timestamp(), statement_timestamp(), statement_timestamp(), statement_timestamp()
  );

  INSERT INTO app.crm_duplicate_candidate_event (
    candidate_id, action, actor_email, actor_role, from_status, to_status, detail
  ) VALUES (
    v_candidate_id, 'OPERATOR_FLAGGED', v_email, v_role, NULL, 'NEW',
    jsonb_build_object('entityType', 'CONTACT', 'origin', 'CRM_EXPLORER')
  );

  RETURN QUERY SELECT 'CREATED', v_candidate_id;
END;
$$;

REVOKE ALL ON FUNCTION app.flag_crm_duplicate_contacts(text, text)
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.flag_crm_duplicate_contacts(text, text)
  TO app_rw;

COMMIT;
