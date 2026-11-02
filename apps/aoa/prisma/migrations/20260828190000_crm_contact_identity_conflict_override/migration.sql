-- Permit one explicit, audited Operations override for same-person CONTACT
-- records whose only blocker is a differing Cedar Ridge user identity.
--
-- This remains an AOA read overlay. CRM records and identity mappings are
-- never merged, deleted, or rewritten. Every other blocker remains absolute.

BEGIN;

ALTER TABLE app.crm_duplicate_candidate
  ADD COLUMN accepted_hard_conflict_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN conflict_override_at timestamptz(6),
  ADD COLUMN conflict_override_by varchar(320);

ALTER TABLE app.crm_duplicate_candidate
  ADD CONSTRAINT crm_duplicate_candidate_accepted_conflicts_controlled CHECK (
    accepted_hard_conflict_codes <@ ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[]
  ),
  ADD CONSTRAINT crm_duplicate_candidate_conflict_override_consistent CHECK (
    (
      cardinality(accepted_hard_conflict_codes) = 0
      AND conflict_override_at IS NULL
      AND conflict_override_by IS NULL
    ) OR (
      entity_type = 'CONTACT'
      AND status = 'READY_FOR_FOLLOW_UP'
      AND accepted_hard_conflict_codes = ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[]
      AND hard_conflict_codes = accepted_hard_conflict_codes
      AND evidence_codes @> ARRAY[
        'EXACT_NORMALIZED_CONTACT_NAME',
        'SAME_CANONICAL_HOUSEHOLD'
      ]::text[]
      AND decision_reason = 'SAME_PERSON_SOURCE_DUPLICATE'
      AND conflict_override_at IS NOT NULL
      AND conflict_override_by IS NOT NULL
    )
  );

ALTER TABLE app.crm_duplicate_candidate
  DROP CONSTRAINT crm_duplicate_candidate_ready_without_conflicts,
  ADD CONSTRAINT crm_duplicate_candidate_ready_without_conflicts CHECK (
    status <> 'READY_FOR_FOLLOW_UP'
    OR cardinality(hard_conflict_codes) = 0
    OR (
      entity_type = 'CONTACT'
      AND hard_conflict_codes = ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[]
      AND accepted_hard_conflict_codes = hard_conflict_codes
      AND evidence_codes @> ARRAY[
        'EXACT_NORMALIZED_CONTACT_NAME',
        'SAME_CANONICAL_HOUSEHOLD'
      ]::text[]
      AND decision_reason = 'SAME_PERSON_SOURCE_DUPLICATE'
    )
  );

-- The contact reconciler refreshes detector evidence through an upsert. Keep a
-- reviewed overlay only while the exact acknowledged warning remains unchanged.
-- Removing the warning clears the acknowledgement; adding or changing a
-- warning follows the existing demotion and invalidation path.
CREATE OR REPLACE FUNCTION app.preserve_accepted_contact_identity_conflict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF current_setting('app.contact_duplicate_reconcile', true) = '1'
     AND OLD.status = 'READY_FOR_FOLLOW_UP'
     AND cardinality(OLD.accepted_hard_conflict_codes) > 0
     AND NEW.source_active
  THEN
    IF NEW.entity_type = 'CONTACT'
       AND NEW.hard_conflict_codes = OLD.accepted_hard_conflict_codes
       AND NEW.evidence_codes @> ARRAY[
         'EXACT_NORMALIZED_CONTACT_NAME',
         'SAME_CANONICAL_HOUSEHOLD'
       ]::text[]
    THEN
      NEW.status := 'READY_FOR_FOLLOW_UP';
      NEW.accepted_hard_conflict_codes := OLD.accepted_hard_conflict_codes;
      NEW.conflict_override_at := OLD.conflict_override_at;
      NEW.conflict_override_by := OLD.conflict_override_by;
    ELSE
      NEW.accepted_hard_conflict_codes := ARRAY[]::text[];
      NEW.conflict_override_at := NULL;
      NEW.conflict_override_by := NULL;
    END IF;
  ELSIF NEW.status <> 'READY_FOR_FOLLOW_UP' THEN
    NEW.accepted_hard_conflict_codes := ARRAY[]::text[];
    NEW.conflict_override_at := NULL;
    NEW.conflict_override_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.preserve_accepted_contact_identity_conflict()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

DROP TRIGGER IF EXISTS crm_duplicate_candidate_preserve_accepted_contact_conflict
  ON app.crm_duplicate_candidate;
CREATE TRIGGER crm_duplicate_candidate_preserve_accepted_contact_conflict
BEFORE UPDATE ON app.crm_duplicate_candidate
FOR EACH ROW EXECUTE FUNCTION app.preserve_accepted_contact_identity_conflict();

-- The older reconciler prepares an invalidation event before its upsert. If
-- the trigger above preserved an exact acknowledged warning, suppress only
-- that now-inapplicable machine event. A changed/new conflict still records it.
CREATE OR REPLACE FUNCTION app.suppress_preserved_contact_conflict_invalidation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.action = 'INVALIDATED_BY_CONFLICT'
     AND current_setting('app.contact_duplicate_reconcile', true) = '1'
     AND EXISTS (
       SELECT 1
         FROM app.crm_duplicate_candidate candidate
        WHERE candidate.id = NEW.candidate_id
          AND candidate.status = 'READY_FOR_FOLLOW_UP'
          AND cardinality(candidate.accepted_hard_conflict_codes) > 0
          AND candidate.hard_conflict_codes = candidate.accepted_hard_conflict_codes
     )
  THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.suppress_preserved_contact_conflict_invalidation()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

DROP TRIGGER IF EXISTS crm_duplicate_event_suppress_preserved_contact_conflict
  ON app.crm_duplicate_candidate_event;
CREATE TRIGGER crm_duplicate_event_suppress_preserved_contact_conflict
BEFORE INSERT ON app.crm_duplicate_candidate_event
FOR EACH ROW EXECUTE FUNCTION app.suppress_preserved_contact_conflict_invalidation();

-- Confirmed contact shells are intentionally suppressed from the ordinary
-- pair detector. Wrap that detector with a narrow revalidation pass so an
-- accepted identity warning is still checked on every scheduled sweep.
ALTER FUNCTION app.reconcile_crm_contact_duplicate_candidates()
  RENAME TO reconcile_crm_contact_duplicate_candidates_v1;
REVOKE ALL ON FUNCTION app.reconcile_crm_contact_duplicate_candidates_v1()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE OR REPLACE FUNCTION app.revalidate_accepted_contact_identity_conflicts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.crm_contact_override_validation (
    candidate_id text PRIMARY KEY,
    validation_state text NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.crm_contact_override_validation;

  INSERT INTO pg_temp.crm_contact_override_validation (candidate_id, validation_state)
  SELECT candidate.id,
         CASE
           WHEN left_profile.normalized_name IS NULL
             OR right_profile.normalized_name IS NULL
             OR left_profile.normalized_name = ''
             OR left_profile.normalized_name <> right_profile.normalized_name
             OR left_profile.canonical_household_key IS NULL
             OR left_profile.canonical_household_key = ''
             OR left_profile.canonical_household_key
                  <> right_profile.canonical_household_key
             OR left_profile.cedar_ridge_user_key IS NULL
             OR right_profile.cedar_ridge_user_key IS NULL
           THEN 'INVALID'
           WHEN left_profile.cedar_ridge_user_key = right_profile.cedar_ridge_user_key
           THEN 'RESOLVED'
           ELSE 'STABLE'
         END
    FROM app.crm_duplicate_candidate candidate
    LEFT JOIN LATERAL (
      SELECT regexp_replace(
               lower(btrim(coalesce(client.first_name, '') || ' '
                 || coalesce(client.last_name, ''))),
               '[[:space:]]+', ' ', 'g'
             ) AS normalized_name,
             left(app.resolve_crm_canonical_household_source_key(client.household_id), 15)
               AS canonical_household_key,
             nullif(lower(btrim(client.cedar_ridge_user_id)), '') AS cedar_ridge_user_key
        FROM app.crm_source_mapping mapping
        JOIN mirror.client client
          ON left(client.sf_id, 15) = left(mapping.source_key, 15)
       WHERE mapping.identity_id = candidate.left_identity_id
         AND mapping.source_system = 'CRM'
         AND mapping.source_namespace = 'contact'
         AND mapping.mapping_state = 'ACTIVE'
       ORDER BY client.synced_at DESC, mapping.first_seen_at, mapping.id
       LIMIT 1
    ) left_profile ON true
    LEFT JOIN LATERAL (
      SELECT regexp_replace(
               lower(btrim(coalesce(client.first_name, '') || ' '
                 || coalesce(client.last_name, ''))),
               '[[:space:]]+', ' ', 'g'
             ) AS normalized_name,
             left(app.resolve_crm_canonical_household_source_key(client.household_id), 15)
               AS canonical_household_key,
             nullif(lower(btrim(client.cedar_ridge_user_id)), '') AS cedar_ridge_user_key
        FROM app.crm_source_mapping mapping
        JOIN mirror.client client
          ON left(client.sf_id, 15) = left(mapping.source_key, 15)
       WHERE mapping.identity_id = candidate.right_identity_id
         AND mapping.source_system = 'CRM'
         AND mapping.source_namespace = 'contact'
         AND mapping.mapping_state = 'ACTIVE'
       ORDER BY client.synced_at DESC, mapping.first_seen_at, mapping.id
       LIMIT 1
    ) right_profile ON true
   WHERE candidate.entity_type = 'CONTACT'
     AND candidate.status = 'READY_FOR_FOLLOW_UP'
     AND candidate.accepted_hard_conflict_codes
       = ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[];

  UPDATE app.crm_duplicate_candidate candidate
     SET hard_conflict_codes = ARRAY[]::text[],
         accepted_hard_conflict_codes = ARRAY[]::text[],
         conflict_override_at = NULL,
         conflict_override_by = NULL,
         review_version = candidate.review_version + 1,
         updated_at = statement_timestamp()
    FROM pg_temp.crm_contact_override_validation validation
   WHERE validation.candidate_id = candidate.id
     AND validation.validation_state = 'RESOLVED';

  UPDATE app.crm_duplicate_candidate candidate
     SET status = 'NEW',
         source_active = false,
         snoozed_until = NULL,
         decision_reason = NULL,
         canonical_identity_id = NULL,
         accepted_hard_conflict_codes = ARRAY[]::text[],
         conflict_override_at = NULL,
         conflict_override_by = NULL,
         review_version = candidate.review_version + 1,
         updated_at = statement_timestamp()
    FROM pg_temp.crm_contact_override_validation validation
   WHERE validation.candidate_id = candidate.id
     AND validation.validation_state = 'INVALID';

  INSERT INTO app.crm_duplicate_candidate_event (
    candidate_id, action, from_status, to_status, detail
  )
  SELECT validation.candidate_id, 'INVALIDATED_BY_CONFLICT',
         'READY_FOR_FOLLOW_UP', 'NEW',
         jsonb_build_object('reason', 'ACCEPTED_CONTACT_IDENTITY_EVIDENCE_CHANGED')
    FROM pg_temp.crm_contact_override_validation validation
   WHERE validation.validation_state = 'INVALID';
END;
$$;

REVOKE ALL ON FUNCTION app.revalidate_accepted_contact_identity_conflicts()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

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
BEGIN
  RETURN QUERY
    SELECT * FROM app.reconcile_crm_contact_duplicate_candidates_v1();
  PERFORM app.revalidate_accepted_contact_identity_conflicts();
END;
$$;

REVOKE ALL ON FUNCTION app.reconcile_crm_contact_duplicate_candidates()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.reconcile_crm_contact_duplicate_candidates()
  TO identity_reconciler;

CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate_v5(
  p_candidate_id text,
  p_expected_review_version integer,
  p_decision text,
  p_snoozed_until timestamptz DEFAULT NULL,
  p_decision_reason text DEFAULT NULL,
  p_canonical_identity_id text DEFAULT NULL,
  p_accept_contact_identity_conflict boolean DEFAULT false
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
  v_override_eligible boolean := false;
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

  v_override_eligible := v_candidate.entity_type = 'CONTACT'
    AND v_candidate.hard_conflict_codes = ARRAY['CONFLICTING_CONTACT_IDENTITY']::text[]
    AND v_candidate.evidence_codes @> ARRAY[
      'EXACT_NORMALIZED_CONTACT_NAME',
      'SAME_CANONICAL_HOUSEHOLD'
    ]::text[];

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
        OR (v_candidate.entity_type = 'CONTACT'
          AND p_decision_reason <> 'SAME_PERSON_SOURCE_DUPLICATE')
        OR (v_candidate.entity_type <> 'CONTACT'
          AND p_decision_reason = 'SAME_PERSON_SOURCE_DUPLICATE')
        OR (cardinality(v_candidate.hard_conflict_codes) > 0 AND (
          NOT coalesce(p_accept_contact_identity_conflict, false)
          OR NOT v_override_eligible
        ))
        OR (cardinality(v_candidate.hard_conflict_codes) = 0
          AND coalesce(p_accept_contact_identity_conflict, false))
      ))
     OR (p_decision = 'NOT_DUPLICATE' AND (
        p_decision_reason IS NULL
        OR p_decision_reason NOT IN (
          'DISTINCT_PEOPLE_OR_HOUSEHOLDS', 'DISTINCT_ACCOUNTS', 'SOURCE_DATA_ERROR'
        )
        OR p_canonical_identity_id IS NOT NULL
        OR coalesce(p_accept_contact_identity_conflict, false)
      ))
     OR (p_decision IN ('NEW', 'SNOOZED') AND (
        p_decision_reason IS NOT NULL
        OR p_canonical_identity_id IS NOT NULL
        OR coalesce(p_accept_contact_identity_conflict, false)
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
         accepted_hard_conflict_codes = CASE
           WHEN p_decision = 'READY_FOR_FOLLOW_UP'
            AND coalesce(p_accept_contact_identity_conflict, false)
           THEN candidate.hard_conflict_codes
           ELSE ARRAY[]::text[]
         END,
         conflict_override_at = CASE
           WHEN p_decision = 'READY_FOR_FOLLOW_UP'
            AND coalesce(p_accept_contact_identity_conflict, false)
           THEN statement_timestamp() ELSE NULL END,
         conflict_override_by = CASE
           WHEN p_decision = 'READY_FOR_FOLLOW_UP'
            AND coalesce(p_accept_contact_identity_conflict, false)
           THEN v_email ELSE NULL END,
         reviewed_at = statement_timestamp(),
         reviewed_by = v_email,
         updated_by = v_email,
         review_version = candidate.review_version + 1,
         updated_at = statement_timestamp()
   WHERE candidate.id = p_candidate_id
     AND candidate.review_version = p_expected_review_version
     AND (candidate.source_active OR p_decision = 'NEW')
     AND (
       p_decision <> 'READY_FOR_FOLLOW_UP'
       OR cardinality(candidate.hard_conflict_codes) = 0
       OR (coalesce(p_accept_contact_identity_conflict, false) AND v_override_eligible)
     );
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
      ELSE jsonb_build_object(
        'reason', p_decision_reason,
        'canonicalSide', v_canonical_side,
        'acceptedHardConflictCodes', CASE
          WHEN coalesce(p_accept_contact_identity_conflict, false)
          THEN v_candidate.hard_conflict_codes ELSE ARRAY[]::text[] END
      )
    END
  );

  RETURN QUERY SELECT 'UPDATED', v_candidate.status, v_candidate.entity_type,
    cardinality(v_candidate.evidence_codes), cardinality(v_candidate.hard_conflict_codes);
END;
$$;

REVOKE ALL ON FUNCTION app.review_crm_duplicate_candidate_v5(
  text, integer, text, timestamptz, text, text, boolean
) FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.review_crm_duplicate_candidate_v5(
  text, integer, text, timestamptz, text, text, boolean
) TO app_rw;

COMMIT;
