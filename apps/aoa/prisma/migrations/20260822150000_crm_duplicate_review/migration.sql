-- CRM duplicate review, first release.
--
-- CRM remains authoritative. This migration creates an Operations/Admin
-- review surface and a reconciler-owned detector. It deliberately contains no
-- merge, delete, source-mapping reassignment, or survivor-selection function.

BEGIN;

-- Keep the Phase 3A machine role on its reviewed key-only boundary. Duplicate
-- detection needs sensitive join inputs, but they remain visible only inside
-- the tightly-owned SECURITY DEFINER functions below and are never granted to
-- identity_reconciler itself.
REVOKE SELECT (email, cedar_ridge_user_id)
  ON mirror.client FROM identity_reconciler;
REVOKE SELECT (custodian_account_id, cedar_ridge_user_id)
  ON mirror.account_holder FROM identity_reconciler;

CREATE TYPE "app"."CrmDuplicateEntityType" AS ENUM ('HOUSEHOLD', 'ACCOUNT');
CREATE TYPE "app"."CrmDuplicateReviewStatus" AS ENUM (
  'NEW', 'SNOOZED', 'NOT_DUPLICATE', 'READY_FOR_FOLLOW_UP'
);

CREATE TABLE "app"."crm_duplicate_candidate" (
  "id" TEXT NOT NULL,
  "detector_key" CHAR(64) NOT NULL,
  "entity_type" "app"."CrmDuplicateEntityType" NOT NULL,
  "left_identity_id" TEXT NOT NULL,
  "right_identity_id" TEXT NOT NULL,
  "account_fingerprint" CHAR(64),
  "evidence_codes" TEXT[] NOT NULL,
  "hard_conflict_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "review_version" INTEGER NOT NULL DEFAULT 0,
  "source_active" BOOLEAN NOT NULL DEFAULT true,
  "status" "app"."CrmDuplicateReviewStatus" NOT NULL DEFAULT 'NEW',
  "snoozed_until" TIMESTAMPTZ(6),
  "reviewed_at" TIMESTAMPTZ(6),
  "reviewed_by" VARCHAR(320),
  "updated_by" VARCHAR(320),
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "crm_duplicate_candidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_duplicate_candidate_detector_key_key" UNIQUE ("detector_key"),
  CONSTRAINT "crm_duplicate_candidate_left_identity_fkey" FOREIGN KEY ("left_identity_id")
    REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_duplicate_candidate_right_identity_fkey" FOREIGN KEY ("right_identity_id")
    REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_duplicate_candidate_distinct_pair" CHECK (
    "left_identity_id" < "right_identity_id"
  ),
  CONSTRAINT "crm_duplicate_candidate_detector_key_hex" CHECK (
    "detector_key" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "crm_duplicate_candidate_account_fingerprint_hex" CHECK (
    "account_fingerprint" IS NULL OR "account_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "crm_duplicate_candidate_account_scope" CHECK (
    ("entity_type" = 'ACCOUNT' AND "account_fingerprint" IS NOT NULL)
    OR ("entity_type" = 'HOUSEHOLD' AND "account_fingerprint" IS NULL)
  ),
  CONSTRAINT "crm_duplicate_candidate_evidence_nonempty" CHECK (
    cardinality("evidence_codes") > 0
  ),
  CONSTRAINT "crm_duplicate_candidate_evidence_controlled" CHECK (
    "evidence_codes" <@ ARRAY[
      'SOURCE_MERGE_REPLACEMENT',
      'SHARED_CEDAR_RIDGE_USER_ID',
      'EXACT_CUSTODIAN_IDENTITY',
      'OFFICIAL_ACCOUNT_REPLACEMENT'
    ]::TEXT[]
  ),
  CONSTRAINT "crm_duplicate_candidate_conflicts_controlled" CHECK (
    "hard_conflict_codes" <@ ARRAY[
      'CONFLICTING_MEMBER_IDENTITY',
      'DISTINCT_CUSTODIAN_IDENTITIES',
      'SOURCE_TYPE_MISMATCH'
    ]::TEXT[]
  ),
  CONSTRAINT "crm_duplicate_candidate_review_version" CHECK ("review_version" >= 0),
  CONSTRAINT "crm_duplicate_candidate_snooze_date" CHECK (
    ("status" = 'SNOOZED' AND "snoozed_until" IS NOT NULL)
    OR ("status" <> 'SNOOZED' AND "snoozed_until" IS NULL)
  ),
  CONSTRAINT "crm_duplicate_candidate_ready_without_conflicts" CHECK (
    "status" <> 'READY_FOR_FOLLOW_UP'
    OR cardinality("hard_conflict_codes") = 0
  )
);

CREATE TABLE "app"."crm_duplicate_candidate_event" (
  "id" BIGSERIAL NOT NULL,
  "candidate_id" TEXT NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "actor_email" VARCHAR(320),
  "actor_role" VARCHAR(32),
  "from_status" "app"."CrmDuplicateReviewStatus",
  "to_status" "app"."CrmDuplicateReviewStatus",
  "detail" JSONB NOT NULL DEFAULT '{}',
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "crm_duplicate_candidate_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_duplicate_candidate_event_candidate_id_fkey" FOREIGN KEY ("candidate_id")
    REFERENCES "app"."crm_duplicate_candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_duplicate_candidate_event_action_controlled" CHECK (
    "action" IN (
      'DETECTED', 'NOT_DUPLICATE', 'SNOOZED', 'READY_FOR_FOLLOW_UP',
      'INVALIDATED_BY_CONFLICT'
    )
  )
);

CREATE INDEX "crm_duplicate_candidate_active_status_detected_idx"
  ON "app"."crm_duplicate_candidate"("source_active", "status", "detected_at");
CREATE INDEX "crm_duplicate_candidate_left_active_idx"
  ON "app"."crm_duplicate_candidate"("left_identity_id", "source_active");
CREATE INDEX "crm_duplicate_candidate_right_active_idx"
  ON "app"."crm_duplicate_candidate"("right_identity_id", "source_active");
CREATE INDEX "crm_duplicate_candidate_event_candidate_at_idx"
  ON "app"."crm_duplicate_candidate_event"("candidate_id", "at" DESC);
CREATE INDEX "crm_duplicate_candidate_event_at_idx"
  ON "app"."crm_duplicate_candidate_event"("at" DESC);

-- Operations/Admin can read candidates and event history. All human mutation
-- is reachable only through the controlled review function below, which binds
-- provenance to the transaction-local session GUCs. Nobody receives direct
-- INSERT, UPDATE, or DELETE.
REVOKE ALL ON "app"."crm_duplicate_candidate", "app"."crm_duplicate_candidate_event"
  FROM PUBLIC, app_rw, identity_reconciler;
GRANT SELECT ON "app"."crm_duplicate_candidate" TO app_rw;
GRANT SELECT ON "app"."crm_duplicate_candidate_event" TO app_rw;

ALTER TABLE "app"."crm_duplicate_candidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_duplicate_candidate" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_duplicate_candidate_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_duplicate_candidate_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_duplicate_candidate_ops_read
  ON "app"."crm_duplicate_candidate" FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
CREATE POLICY crm_duplicate_candidate_event_ops_read
  ON "app"."crm_duplicate_candidate_event" FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );

-- In Cloud SQL the migration/function owner is deliberately not a superuser,
-- so FORCE RLS still applies inside SECURITY DEFINER routines. Give the actual
-- function owner only the row operations used by detection/review. This follows
-- the existing relationship-function owner precedent and avoids introducing a
-- runtime role with raw-source access.
DO $$
DECLARE
  definer_role text := quote_ident(current_user);
BEGIN
  EXECUTE format(
    'CREATE POLICY crm_duplicate_candidate_definer_read '
    'ON app.crm_duplicate_candidate FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_duplicate_candidate_definer_insert '
    'ON app.crm_duplicate_candidate FOR INSERT TO %s WITH CHECK (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_duplicate_candidate_definer_update '
    'ON app.crm_duplicate_candidate FOR UPDATE TO %s USING (true) WITH CHECK (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_duplicate_candidate_event_definer_read '
    'ON app.crm_duplicate_candidate_event FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_duplicate_candidate_event_definer_insert '
    'ON app.crm_duplicate_candidate_event FOR INSERT TO %s WITH CHECK (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_identity_duplicate_definer_read '
    'ON app.crm_identity FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_source_mapping_duplicate_definer_read '
    'ON app.crm_source_mapping FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY client_duplicate_definer_read '
    'ON mirror.client FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY account_holder_duplicate_definer_read '
    'ON mirror.account_holder FOR SELECT TO %s USING (true)',
    definer_role
  );
  EXECUTE format(
    'CREATE POLICY crm_parent_orphan_duplicate_definer_read '
    'ON mirror.crm_parent_orphan_evidence FOR SELECT TO %s USING (true)',
    definer_role
  );
END $$;

-- Candidate freshness is operational telemetry rather than a business-state
-- change. This table-specific audit function excludes last_seen_at (as well as
-- the standard updated_at housekeeping field), preventing refresh-only churn
-- while retaining every evidence, conflict, activity, and reviewer change.
CREATE OR REPLACE FUNCTION audit.log_crm_duplicate_candidate_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
DECLARE
  old_j jsonb;
  new_j jsonb;
  changed_j jsonb := '{}'::jsonb;
  k text;
  pk text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);
    FOR k IN SELECT jsonb_object_keys(new_j) LOOP
      IF k IN ('updated_at', 'last_seen_at') THEN
        CONTINUE;
      END IF;
      IF (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
        changed_j := changed_j || jsonb_build_object(
          k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k)
        );
      END IF;
    END LOOP;
    IF changed_j = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    pk := new_j ->> 'id';
  ELSIF TG_OP = 'INSERT' THEN
    new_j := to_jsonb(NEW);
    changed_j := new_j;
    pk := new_j ->> 'id';
  ELSE
    old_j := to_jsonb(OLD);
    changed_j := old_j;
    pk := old_j ->> 'id';
  END IF;

  INSERT INTO audit.row_change
    (schema_name, table_name, op, row_pk, changed,
     actor_email, actor_role, db_role)
  VALUES (
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, pk, changed_j,
    nullif(current_setting('app.user_email', true), ''),
    nullif(current_setting('app.user_role', true), ''),
    session_user
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION audit.log_crm_duplicate_candidate_change()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

CREATE TRIGGER crm_duplicate_candidate_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."crm_duplicate_candidate"
  FOR EACH ROW EXECUTE FUNCTION audit.log_crm_duplicate_candidate_change();

-- A 64-character deterministic opaque key without introducing a new extension.
-- md5 is used only for stable identity/fingerprints, never password security.
CREATE OR REPLACE FUNCTION app.crm_duplicate_fingerprint(value text)
RETURNS char(64)
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT (md5(value) || md5('v2:' || value))::char(64)
$$;

REVOKE ALL ON FUNCTION app.crm_duplicate_fingerprint(text)
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
-- Account detail uses this opaque one-way comparison under app_rw. It exposes
-- no source value and is strictly narrower than granting raw account columns.
GRANT EXECUTE ON FUNCTION app.crm_duplicate_fingerprint(text)
  TO app_rw;

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

  -- A reviewer may commit READY immediately before a detector refresh. Capture
  -- those rows before the upsert, then atomically demote them in the same
  -- statement that introduces the hard conflict. The original human READY
  -- event remains immutable; a machine invalidation event is appended below.
  -- Lock every existing signal row before inspecting its state. A concurrent
  -- reviewer then either commits first (and is observed here) or waits and
  -- fails the current-version/conflict gate after this detector transaction.
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

-- Counts-only preview of the exact live detector. The inner subtransaction
-- performs candidate/event/audit writes and deliberately raises a private
-- exception so every one of those changes rolls back before counts escape.
CREATE OR REPLACE FUNCTION app.preview_crm_duplicate_candidates()
RETURNS TABLE (
  signals_seen bigint,
  candidates_opened bigint,
  candidates_refreshed bigint,
  candidates_inactivated bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_signals bigint;
  v_opened bigint;
  v_refreshed bigint;
  v_inactivated bigint;
BEGIN
  BEGIN
    SELECT result.signals_seen, result.candidates_opened,
           result.candidates_refreshed, result.candidates_inactivated
      INTO STRICT v_signals, v_opened, v_refreshed, v_inactivated
      FROM app.reconcile_crm_duplicate_candidates() result;

    RAISE EXCEPTION 'CRM duplicate detector preview rollback'
      USING ERRCODE = 'P2D01';
  EXCEPTION
    WHEN SQLSTATE 'P2D01' THEN
      NULL;
  END;

  RETURN QUERY SELECT v_signals, v_opened, v_refreshed, v_inactivated;
END;
$$;

REVOKE ALL ON FUNCTION app.preview_crm_duplicate_candidates()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.preview_crm_duplicate_candidates()
  TO identity_reconciler;

-- Dry-run must model the state that would exist after parent and identity
-- reconciliation, not the pre-run registry. Run all three live functions in
-- one rollback subtransaction so duplicate detection can see identities and
-- mappings minted earlier in that same hypothetical run. Only typed counts
-- escape; all registry, candidate, event, and audit writes are rolled back.
CREATE OR REPLACE FUNCTION app.preview_crm_identity_duplicate_reconciliation(
  p_run_id text
)
RETURNS TABLE (
  sources_seen bigint,
  identities_created bigint,
  mappings_created bigint,
  mappings_refreshed bigint,
  exceptions_opened bigint,
  exceptions_reopened bigint,
  exceptions_resolved bigint,
  duplicate_signals_seen bigint,
  duplicate_candidates_would_open bigint,
  duplicate_candidates_would_refresh bigint,
  duplicate_candidates_would_inactivate bigint
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_parent record;
  v_identity record;
  v_duplicate record;
BEGIN
  BEGIN
    SELECT * INTO STRICT v_parent
      FROM app.reconcile_crm_parent_source(false);
    SELECT * INTO STRICT v_identity
      FROM app.reconcile_crm_identity_snapshot(p_run_id, false);
    SELECT * INTO STRICT v_duplicate
      FROM app.reconcile_crm_duplicate_candidates();

    RAISE EXCEPTION 'CRM identity and duplicate preview rollback'
      USING ERRCODE = 'P2D02';
  EXCEPTION
    WHEN SQLSTATE 'P2D02' THEN
      NULL;
  END;

  RETURN QUERY SELECT
    v_parent.sources_seen + v_identity.sources_seen,
    v_parent.identities_created + v_identity.identities_created,
    v_parent.mappings_created + v_identity.mappings_created,
    v_parent.mappings_refreshed + v_identity.mappings_refreshed,
    v_identity.exceptions_opened,
    v_identity.exceptions_reopened,
    v_identity.exceptions_resolved,
    v_duplicate.signals_seen,
    v_duplicate.candidates_opened,
    v_duplicate.candidates_refreshed,
    v_duplicate.candidates_inactivated;
END;
$$;

REVOKE ALL ON FUNCTION app.preview_crm_identity_duplicate_reconciliation(text)
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.preview_crm_identity_duplicate_reconciliation(text)
  TO identity_reconciler;

-- Human review is an intentionally non-executing workflow decision. app_rw
-- has no direct mutation privileges; this function derives actor provenance
-- from withUserScope's transaction GUCs and enforces optimistic concurrency
-- plus the hard-conflict READY gate in the same row-locking transaction.
CREATE OR REPLACE FUNCTION app.review_crm_duplicate_candidate(
  p_candidate_id text,
  p_expected_review_version integer,
  p_decision text,
  p_snoozed_until timestamptz DEFAULT NULL
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

  SELECT candidate.status::text AS status,
         candidate.entity_type::text AS entity_type,
         candidate.evidence_codes,
         candidate.hard_conflict_codes
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
  IF p_decision = 'READY_FOR_FOLLOW_UP'
     AND cardinality(v_candidate.hard_conflict_codes) > 0
  THEN
    RETURN QUERY SELECT 'INVALID', v_candidate.status, v_candidate.entity_type,
      cardinality(v_candidate.evidence_codes),
      cardinality(v_candidate.hard_conflict_codes);
    RETURN;
  END IF;

  UPDATE app.crm_duplicate_candidate candidate
     SET status = p_decision::app."CrmDuplicateReviewStatus",
         snoozed_until = CASE WHEN p_decision = 'SNOOZED'
           THEN p_snoozed_until ELSE NULL END,
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
    CASE WHEN p_decision = 'SNOOZED'
      THEN jsonb_build_object('snoozedUntil', p_snoozed_until)
      ELSE '{}'::jsonb END
  );

  RETURN QUERY SELECT 'UPDATED', v_candidate.status, v_candidate.entity_type,
    cardinality(v_candidate.evidence_codes),
    cardinality(v_candidate.hard_conflict_codes);
END;
$$;

REVOKE ALL ON FUNCTION app.review_crm_duplicate_candidate(text, integer, text, timestamptz)
  FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.review_crm_duplicate_candidate(text, integer, text, timestamptz)
  TO app_rw;

COMMIT;
