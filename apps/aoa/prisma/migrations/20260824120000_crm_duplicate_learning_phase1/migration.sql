-- CRM duplicate learning, phase 1.
--
-- Adds structured, PII-free human outcomes and a canonical-side recommendation.
-- CRM remains authoritative: no function in this migration merges, deletes,
-- re-parents, or rewrites a source record or CRM identity.

BEGIN;

ALTER TABLE "app"."crm_duplicate_candidate"
  ADD COLUMN "decision_reason" VARCHAR(48),
  ADD COLUMN "canonical_identity_id" TEXT;

ALTER TABLE "app"."crm_duplicate_candidate"
  ADD CONSTRAINT "crm_duplicate_candidate_canonical_identity_fkey"
    FOREIGN KEY ("canonical_identity_id")
    REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "crm_duplicate_candidate_reason_controlled" CHECK (
    "decision_reason" IS NULL OR "decision_reason" IN (
      'SAME_RELATIONSHIP_SOURCE_DUPLICATE',
      'OFFICIAL_SOURCE_REPLACEMENT',
      'SHARED_IDENTIFIER_CONFIRMED',
      'DISTINCT_PEOPLE_OR_HOUSEHOLDS',
      'DISTINCT_ACCOUNTS',
      'SOURCE_DATA_ERROR'
    )
  ),
  ADD CONSTRAINT "crm_duplicate_candidate_canonical_in_pair" CHECK (
    "canonical_identity_id" IS NULL
    OR "canonical_identity_id" IN ("left_identity_id", "right_identity_id")
  ),
  ADD CONSTRAINT "crm_duplicate_candidate_canonical_only_when_ready" CHECK (
    "canonical_identity_id" IS NULL OR "status" = 'READY_FOR_FOLLOW_UP'
  ),
  ADD CONSTRAINT "crm_duplicate_candidate_reason_only_on_outcome" CHECK (
    "decision_reason" IS NULL
    OR "status" IN ('NOT_DUPLICATE', 'READY_FOR_FOLLOW_UP')
  );

CREATE INDEX "crm_duplicate_candidate_canonical_identity_idx"
  ON "app"."crm_duplicate_candidate"("canonical_identity_id");

-- A later detector run can invalidate READY after adding a hard conflict. Clear
-- the current structured recommendation during that demotion; the append-only
-- event still preserves the original controlled reason and canonical side.
CREATE OR REPLACE FUNCTION app.clear_crm_duplicate_outcome_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.status NOT IN ('NOT_DUPLICATE', 'READY_FOR_FOLLOW_UP') THEN
    NEW.decision_reason := NULL;
  END IF;
  IF NEW.status <> 'READY_FOR_FOLLOW_UP' THEN
    NEW.canonical_identity_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.clear_crm_duplicate_outcome_on_status_change()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE TRIGGER crm_duplicate_candidate_clear_outcome
  BEFORE UPDATE OF status ON "app"."crm_duplicate_candidate"
  FOR EACH ROW EXECUTE FUNCTION app.clear_crm_duplicate_outcome_on_status_change();

-- Version 2 preserves the original function during rolling deployment. The old
-- app may continue saving its legacy decisions while the new app requires
-- structured outcomes through this narrower function.
CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate_v2(
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
     OR p_decision NOT IN ('NOT_DUPLICATE', 'SNOOZED', 'READY_FOR_FOLLOW_UP')
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
      )) OR (p_decision = 'SNOOZED' AND (
        p_decision_reason IS NOT NULL OR p_canonical_identity_id IS NOT NULL
      ))
  THEN
    RETURN QUERY SELECT 'INVALID', NULL::text, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  SELECT candidate.status::text AS status,
         candidate.entity_type::text AS entity_type,
         candidate.left_identity_id, candidate.right_identity_id,
         candidate.evidence_codes, candidate.hard_conflict_codes
    INTO v_candidate
    FROM app.crm_duplicate_candidate candidate
   WHERE candidate.id = p_candidate_id
     AND candidate.source_active
     AND candidate.review_version = p_expected_review_version
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'CONFLICT', NULL::text, NULL::text, NULL::integer, NULL::integer;
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
     AND candidate.source_active
     AND candidate.review_version = p_expected_review_version
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
    p_candidate_id, p_decision, v_email, v_role,
    v_candidate.status::app."CrmDuplicateReviewStatus",
    p_decision::app."CrmDuplicateReviewStatus",
    CASE
      WHEN p_decision = 'SNOOZED'
        THEN jsonb_build_object('snoozedUntil', p_snoozed_until)
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

REVOKE ALL ON FUNCTION app.review_crm_duplicate_candidate_v2(
  text, integer, text, timestamptz, text, text
) FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.review_crm_duplicate_candidate_v2(
  text, integer, text, timestamptz, text, text
) TO app_rw;

COMMIT;
