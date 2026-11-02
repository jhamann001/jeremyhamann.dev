-- Asset-mapping run identity (ticket): accepted run → CedarRidge-ID membership
-- and a checked exact-ID canonical CONTACT resolver.
--
-- The statement-pipeline remains authoritative for who a run belongs to (contract
-- acat-run-identity-export v1, household `client_link`). AoA stores that
-- accepted state per immutable run UUID and, separately, its own derived
-- canonical CONTACT target. Folder links (acat_asset_map_link), account links
-- (acat_asset_map_account_link), the dormant household scalars, transfers,
-- financial rows and CRM identity rows are deliberately NOT referenced or
-- altered here.
--
-- Additive only (ADR-5): three new mirror tables, helper/guard functions, one
-- resolver, grants, FORCE RLS and policies. No backfill, no runtime effect until
-- ticket enables identity writes. No down migration: rollback stops writes and
-- retains every row (ADR-7: no deletes).

-- ---------------------------------------------------------------------------
-- 1. Immutable validation helpers shared by row CHECKs on snapshot and history.
--    Opaque ids are case-sensitive; "sorted" is code-point order (COLLATE "C"
--    on UTF-8), which matches the producer's Python sorted().
-- ---------------------------------------------------------------------------
CREATE FUNCTION mirror.acat_asset_map_run_identity_sorted_set(
  p_values text[], p_max_length integer, p_max_count integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    p_values IS NOT NULL
    AND cardinality(p_values) <= p_max_count
    AND (cardinality(p_values) = 0 OR (array_ndims(p_values) = 1 AND array_lower(p_values, 1) = 1))
    AND NOT EXISTS (
      SELECT 1
        FROM unnest(p_values) WITH ORDINALITY AS cur(value, ord)
        LEFT JOIN unnest(p_values) WITH ORDINALITY AS prev(value, ord) ON prev.ord = cur.ord - 1
       WHERE cur.value IS NULL
          OR cur.value ~ '^[[:space:]]*$'
          OR char_length(cur.value) > p_max_length
          OR (prev.ord IS NOT NULL AND NOT (prev.value COLLATE "C" < cur.value COLLATE "C"))
    ),
    false)
$$;

-- Contract v1 accepted-state invariants: linked/unlinked/unreviewed shape,
-- empty-set coverage, primary membership, scalar projection and review state.
CREATE FUNCTION mirror.acat_asset_map_run_identity_state_valid(
  p_decision_id text, p_decision_state text, p_coverage text, p_people text[],
  p_primary text, p_scalar text, p_review text, p_flags text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    mirror.acat_asset_map_run_identity_sorted_set(p_people, 512, 100)
    AND mirror.acat_asset_map_run_identity_sorted_set(p_flags, 64, 32)
    AND (p_decision_id IS NULL
         OR p_decision_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND CASE p_decision_state
          WHEN 'linked' THEN cardinality(p_people) > 0 AND p_decision_id IS NOT NULL
          WHEN 'unlinked' THEN cardinality(p_people) = 0
          WHEN 'unreviewed' THEN cardinality(p_people) = 0 AND p_decision_id IS NULL
          ELSE false
        END
    AND (cardinality(p_people) > 0 OR p_coverage = 'partial')
    AND (p_primary IS NULL OR p_primary = ANY (p_people))
    AND p_scalar IS NOT DISTINCT FROM coalesce(
          p_primary,
          CASE WHEN p_coverage = 'complete' AND cardinality(p_people) = 1 THEN p_people[1] END)
    AND p_review = CASE
          WHEN cardinality(p_flags) > 0 THEN 'conflict'
          WHEN cardinality(p_people) > 0 THEN p_coverage
          ELSE 'unresolved'
        END,
    false)
$$;

-- History resolutions: one controlled object per accepted person, in people
-- order, with only an outcome and (when resolved) the target keys.
CREATE FUNCTION mirror.acat_asset_map_run_identity_resolutions_valid(
  p_resolutions jsonb, p_people text[], p_review text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    jsonb_typeof(p_resolutions) = 'array'
    AND jsonb_array_length(p_resolutions) = cardinality(p_people)
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_resolutions) WITH ORDINALITY AS e(item, ord)
       WHERE jsonb_typeof(e.item) <> 'object'
          OR (SELECT array_agg(k.key COLLATE "C" ORDER BY k.key COLLATE "C")
                FROM jsonb_object_keys(e.item) AS k(key))
             IS DISTINCT FROM ARRAY['canonical_contact_identity_id', 'canonical_contact_source_key',
                                    'cedar_ridge_user_id', 'outcome']::text[]
          OR (e.item ->> 'cedar_ridge_user_id') IS DISTINCT FROM p_people[e.ord]
          OR coalesce(e.item ->> 'outcome', '') NOT IN ('resolved', 'missing', 'ambiguous', 'conflict')
          OR (p_review = 'conflict' AND (e.item ->> 'outcome') <> 'conflict')
          OR ((e.item ->> 'outcome') = 'resolved') IS DISTINCT FROM (
               jsonb_typeof(e.item -> 'canonical_contact_identity_id') = 'string'
               AND jsonb_typeof(e.item -> 'canonical_contact_source_key') = 'string')
          OR ((e.item ->> 'outcome') <> 'resolved' AND (
               jsonb_typeof(e.item -> 'canonical_contact_identity_id') <> 'null'
               OR jsonb_typeof(e.item -> 'canonical_contact_source_key') <> 'null'))
          OR (jsonb_typeof(e.item -> 'canonical_contact_identity_id') = 'string'
              AND (e.item ->> 'canonical_contact_identity_id') !~ '^con_[a-z0-9]+$')
    ),
    false)
$$;

-- ---------------------------------------------------------------------------
-- 2. mirror.acat_asset_map_run_identity — one accepted-source snapshot per
--    immutable source run UUID. identity_version is the source's per-run
--    identity version (NOT run_number, NOT fetch time). payload_digest is the
--    sha256 of the canonical identity equality form. consumer_revision advances
--    on any applied source change OR derived-resolution change; resolution_digest
--    fingerprints the derived targets. Quarantine records the last rejected
--    equal-version mutation / unreviewed-after-accepted observation without
--    applying it.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_run_identity (
  run_id                       text PRIMARY KEY
                               REFERENCES mirror.acat_asset_map_household(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  schema_version               smallint NOT NULL,
  identity_version             bigint NOT NULL,
  payload_digest               text NOT NULL,
  decision_id                  text,
  decision_state               text NOT NULL,
  coverage                     text NOT NULL,
  people_ids                   text[] NOT NULL,
  primary_user_id              text,
  cedar_ridge_user_id            text,
  review_state                 text NOT NULL,
  conflict_flags               text[] NOT NULL,
  consumer_revision            integer NOT NULL,
  resolution_digest            text NOT NULL,
  last_observed_availability   text NOT NULL,
  first_observed_at            timestamptz NOT NULL DEFAULT now(),
  last_observed_at             timestamptz NOT NULL DEFAULT now(),
  source_applied_at            timestamptz NOT NULL DEFAULT now(),
  resolution_evaluated_at      timestamptz NOT NULL DEFAULT now(),
  quarantine_reason            text,
  quarantined_identity_version bigint,
  quarantined_payload_digest   text,
  quarantined_at               timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acat_asset_map_run_identity_run_uuid
    CHECK (run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT acat_asset_map_run_identity_schema_version CHECK (schema_version = 1),
  CONSTRAINT acat_asset_map_run_identity_version_range
    CHECK (identity_version BETWEEN 0 AND 9007199254740991),
  CONSTRAINT acat_asset_map_run_identity_payload_digest CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT acat_asset_map_run_identity_decision_state
    CHECK (decision_state IN ('linked', 'unlinked', 'unreviewed')),
  CONSTRAINT acat_asset_map_run_identity_coverage CHECK (coverage IN ('complete', 'partial')),
  CONSTRAINT acat_asset_map_run_identity_review_state
    CHECK (review_state IN ('complete', 'partial', 'unresolved', 'conflict')),
  CONSTRAINT acat_asset_map_run_identity_availability
    CHECK (last_observed_availability IN ('available', 'unavailable')),
  CONSTRAINT acat_asset_map_run_identity_state CHECK (
    mirror.acat_asset_map_run_identity_state_valid(
      decision_id, decision_state, coverage, people_ids, primary_user_id, cedar_ridge_user_id,
      review_state, conflict_flags)),
  CONSTRAINT acat_asset_map_run_identity_consumer_revision CHECK (consumer_revision >= 1),
  CONSTRAINT acat_asset_map_run_identity_resolution_digest CHECK (resolution_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT acat_asset_map_run_identity_quarantine_reason
    CHECK (quarantine_reason IN ('equal_version_mutation', 'unreviewed_after_accepted')),
  CONSTRAINT acat_asset_map_run_identity_quarantine_shape CHECK (
    (quarantine_reason IS NULL AND quarantined_identity_version IS NULL
       AND quarantined_payload_digest IS NULL AND quarantined_at IS NULL)
    OR (quarantine_reason IS NOT NULL AND quarantined_identity_version >= 0
       AND quarantined_payload_digest ~ '^[0-9a-f]{64}$' AND quarantined_at IS NOT NULL)),
  CONSTRAINT acat_asset_map_run_identity_observed_order CHECK (last_observed_at >= first_observed_at)
);
CREATE INDEX acat_asset_map_run_identity_decision_state_idx
  ON mirror.acat_asset_map_run_identity (decision_state);

-- ---------------------------------------------------------------------------
-- 3. mirror.acat_asset_map_run_person — accepted membership per (run, opaque
--    Cedar Ridge ID). Membership is retired, never deleted, when a newer accepted
--    source version removes the person; version columns are its source
--    provenance. The derived canonical CONTACT target is present only while the
--    member is active and resolved. No names are stored.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_run_person (
  run_id                          text NOT NULL
                                  REFERENCES mirror.acat_asset_map_run_identity(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  cedar_ridge_user_id               text NOT NULL,
  membership_state                text NOT NULL,
  first_identity_version          bigint NOT NULL,
  active_since_identity_version   bigint NOT NULL,
  last_confirmed_identity_version bigint NOT NULL,
  retired_identity_version        bigint,
  retired_at                      timestamptz,
  resolution_outcome              text,
  canonical_contact_identity_id   text,
  canonical_contact_source_key    text,
  resolution_evaluated_at         timestamptz,
  first_seen_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acat_asset_map_run_person_pkey PRIMARY KEY (run_id, cedar_ridge_user_id),
  CONSTRAINT acat_asset_map_run_person_id CHECK (
    char_length(cedar_ridge_user_id) BETWEEN 1 AND 512 AND cedar_ridge_user_id !~ '^[[:space:]]*$'),
  CONSTRAINT acat_asset_map_run_person_membership_state CHECK (membership_state IN ('active', 'retired')),
  CONSTRAINT acat_asset_map_run_person_version_order CHECK (
    first_identity_version >= 0
    AND last_confirmed_identity_version <= 9007199254740991
    AND first_identity_version <= active_since_identity_version
    AND active_since_identity_version <= last_confirmed_identity_version),
  CONSTRAINT acat_asset_map_run_person_retirement CHECK (
    (membership_state = 'active' AND retired_identity_version IS NULL AND retired_at IS NULL)
    OR (membership_state = 'retired' AND retired_at IS NOT NULL
        AND retired_identity_version > last_confirmed_identity_version
        AND retired_identity_version <= 9007199254740991)),
  CONSTRAINT acat_asset_map_run_person_resolution_outcome
    CHECK (resolution_outcome IN ('resolved', 'missing', 'ambiguous', 'conflict')),
  CONSTRAINT acat_asset_map_run_person_resolution_presence CHECK (
    (membership_state = 'active' AND resolution_outcome IS NOT NULL AND resolution_evaluated_at IS NOT NULL)
    OR (membership_state = 'retired' AND resolution_outcome IS NULL AND resolution_evaluated_at IS NULL)),
  CONSTRAINT acat_asset_map_run_person_target_shape CHECK (
    (canonical_contact_identity_id IS NULL) = (canonical_contact_source_key IS NULL)
    AND (resolution_outcome IS NOT DISTINCT FROM 'resolved') = (canonical_contact_identity_id IS NOT NULL)),
  CONSTRAINT acat_asset_map_run_person_target_format CHECK (
    (canonical_contact_identity_id IS NULL OR canonical_contact_identity_id ~ '^con_[a-z0-9]+$')
    AND (canonical_contact_source_key IS NULL OR char_length(btrim(canonical_contact_source_key)) BETWEEN 1 AND 512))
);
CREATE INDEX acat_asset_map_run_person_active_user_idx
  ON mirror.acat_asset_map_run_person (cedar_ridge_user_id) WHERE membership_state = 'active';
CREATE INDEX acat_asset_map_run_person_target_idx
  ON mirror.acat_asset_map_run_person (canonical_contact_identity_id) WHERE resolution_outcome = 'resolved';

-- ---------------------------------------------------------------------------
-- 4. mirror.acat_asset_map_run_identity_history — append-only, one row per
--    consumer revision. Accepted ids, decision/version and controlled
--    resolution outcomes/target keys only: no documents, names, financial
--    payloads or credentials. An identical replay writes no row.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_run_identity_history (
  run_id             text NOT NULL
                     REFERENCES mirror.acat_asset_map_run_identity(run_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  consumer_revision  integer NOT NULL,
  identity_version   bigint NOT NULL,
  payload_digest     text NOT NULL,
  decision_id        text,
  decision_state     text NOT NULL,
  coverage           text NOT NULL,
  people_ids         text[] NOT NULL,
  primary_user_id    text,
  cedar_ridge_user_id  text,
  review_state       text NOT NULL,
  conflict_flags     text[] NOT NULL,
  resolution_digest  text NOT NULL,
  resolutions        jsonb NOT NULL,
  source_changed     boolean NOT NULL,
  resolution_changed boolean NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acat_asset_map_run_identity_history_pkey PRIMARY KEY (run_id, consumer_revision),
  CONSTRAINT acat_asset_map_run_identity_history_revision CHECK (consumer_revision >= 1),
  CONSTRAINT acat_asset_map_run_identity_history_version_range
    CHECK (identity_version BETWEEN 0 AND 9007199254740991),
  CONSTRAINT acat_asset_map_run_identity_history_digests CHECK (
    payload_digest ~ '^[0-9a-f]{64}$' AND resolution_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT acat_asset_map_run_identity_history_decision_state
    CHECK (decision_state IN ('linked', 'unlinked', 'unreviewed')),
  CONSTRAINT acat_asset_map_run_identity_history_coverage CHECK (coverage IN ('complete', 'partial')),
  CONSTRAINT acat_asset_map_run_identity_history_review_state
    CHECK (review_state IN ('complete', 'partial', 'unresolved', 'conflict')),
  CONSTRAINT acat_asset_map_run_identity_history_state CHECK (
    mirror.acat_asset_map_run_identity_state_valid(
      decision_id, decision_state, coverage, people_ids, primary_user_id, cedar_ridge_user_id,
      review_state, conflict_flags)),
  CONSTRAINT acat_asset_map_run_identity_history_resolutions CHECK (
    mirror.acat_asset_map_run_identity_resolutions_valid(resolutions, people_ids, review_state)),
  CONSTRAINT acat_asset_map_run_identity_history_changed CHECK (source_changed OR resolution_changed)
);

-- ---------------------------------------------------------------------------
-- 5. Guards. Row-level: an update can never lower the source version, mutate an
--    equal version, replace accepted state with unreviewed, rewind the consumer
--    revision, or re-key a row. History rejects UPDATE/DELETE for every role.
--    Deferred (commit-time, one identity transaction): active members equal the
--    snapshot's accepted set, a source conflict exposes no resolved target, and
--    the snapshot's consumer revision has its matching history row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION mirror.acat_asset_map_run_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at THEN
    RAISE EXCEPTION 'run identity key and first observation are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.identity_version < OLD.identity_version THEN
    RAISE EXCEPTION 'older source identity version cannot replace a newer one' USING ERRCODE = '23514';
  END IF;
  IF NEW.identity_version = OLD.identity_version AND NEW.payload_digest IS DISTINCT FROM OLD.payload_digest THEN
    RAISE EXCEPTION 'equal source identity version cannot change its payload' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_state = 'unreviewed' AND OLD.decision_state <> 'unreviewed' THEN
    RAISE EXCEPTION 'unreviewed cannot replace accepted run identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.consumer_revision < OLD.consumer_revision THEN
    RAISE EXCEPTION 'consumer revision cannot move backwards' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acat_asset_map_run_identity_guard
  BEFORE UPDATE ON mirror.acat_asset_map_run_identity
  FOR EACH ROW EXECUTE FUNCTION mirror.acat_asset_map_run_identity_guard();

CREATE FUNCTION mirror.acat_asset_map_run_person_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.cedar_ridge_user_id IS DISTINCT FROM OLD.cedar_ridge_user_id
     OR NEW.first_identity_version IS DISTINCT FROM OLD.first_identity_version
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
     OR NEW.last_confirmed_identity_version < OLD.last_confirmed_identity_version THEN
    RAISE EXCEPTION 'run membership provenance is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acat_asset_map_run_person_guard
  BEFORE UPDATE ON mirror.acat_asset_map_run_person
  FOR EACH ROW EXECUTE FUNCTION mirror.acat_asset_map_run_person_guard();

CREATE FUNCTION mirror.acat_asset_map_run_identity_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'asset-map run identity history is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER acat_asset_map_run_identity_history_append_only
  BEFORE UPDATE OR DELETE ON mirror.acat_asset_map_run_identity_history
  FOR EACH ROW EXECUTE FUNCTION mirror.acat_asset_map_run_identity_history_append_only();

CREATE FUNCTION mirror.acat_asset_map_run_identity_check_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_snapshot mirror.acat_asset_map_run_identity%ROWTYPE;
  v_active text[];
BEGIN
  SELECT s.* INTO v_snapshot FROM mirror.acat_asset_map_run_identity s WHERE s.run_id = NEW.run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run membership has no identity snapshot' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(array_agg(p.cedar_ridge_user_id ORDER BY p.cedar_ridge_user_id COLLATE "C"), ARRAY[]::text[])
    INTO v_active
    FROM mirror.acat_asset_map_run_person p
   WHERE p.run_id = NEW.run_id AND p.membership_state = 'active';
  IF v_active IS DISTINCT FROM v_snapshot.people_ids THEN
    RAISE EXCEPTION 'active run membership must equal the accepted people set' USING ERRCODE = '23514';
  END IF;
  IF v_snapshot.review_state = 'conflict' AND EXISTS (
       SELECT 1 FROM mirror.acat_asset_map_run_person p
        WHERE p.run_id = NEW.run_id AND p.membership_state = 'active' AND p.resolution_outcome = 'resolved') THEN
    RAISE EXCEPTION 'a source conflict cannot expose a resolved target' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM mirror.acat_asset_map_run_identity_history h
        WHERE h.run_id = NEW.run_id
          AND h.consumer_revision = v_snapshot.consumer_revision
          AND h.identity_version = v_snapshot.identity_version
          AND h.payload_digest = v_snapshot.payload_digest
          AND h.resolution_digest = v_snapshot.resolution_digest) THEN
    RAISE EXCEPTION 'run identity revision has no matching history row' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER acat_asset_map_run_identity_consistency
  AFTER INSERT OR UPDATE ON mirror.acat_asset_map_run_identity
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mirror.acat_asset_map_run_identity_check_consistency();

CREATE CONSTRAINT TRIGGER acat_asset_map_run_person_consistency
  AFTER INSERT OR UPDATE ON mirror.acat_asset_map_run_person
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mirror.acat_asset_map_run_identity_check_consistency();

-- ---------------------------------------------------------------------------
-- 6. app.resolve_asset_map_run_people(text[]) — bounded, checked, exact-ID
--    batch resolver. For each requested id (case-sensitive exact match on
--    mirror.client.cedar_ridge_user_id) every matching client is walked through
--    its single ACTIVE CRM contact mapping and confirmed CONTACT duplicate
--    chain (same 8-lookup bound as resolve_crm_canonical_contact_source_key).
--    Unlike that helper, a bad chain never falls back to its input: branch,
--    cycle, depth, wrong type, inactive survivor, unregistered client, an
--    ambiguous survivor alias, or a survivor carrying a different Cedar Ridge id
--    is `conflict`. Candidates converging on one survivor collapse to
--    `resolved`; different valid survivors are `ambiguous`; no client is
--    `missing`. Read-only: creates no source or client identity. No dynamic SQL.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.resolve_asset_map_run_people(p_cedar_ridge_user_ids text[])
RETURNS TABLE (
  cedar_ridge_user_id text,
  outcome text,
  canonical_contact_identity_id text,
  canonical_contact_source_key text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id text;
  v_client_key text;
  v_found boolean;
  v_conflict boolean;
  v_start text[];
  v_current text;
  v_next text[];
  v_seen text[];
  v_depth integer;
  v_survivor text;
  v_type text;
  v_state text;
  v_targets text[];
  v_compatible boolean;
  v_survivors text[];
  v_keys text[];
BEGIN
  IF p_cedar_ridge_user_ids IS NULL OR cardinality(p_cedar_ridge_user_ids) > 1000 THEN
    RAISE EXCEPTION 'asset-map run people batch must hold 0..1000 ids' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
       SELECT 1 FROM unnest(p_cedar_ridge_user_ids) AS r(id)
        WHERE r.id IS NULL OR r.id ~ '^[[:space:]]*$' OR char_length(r.id) > 512) THEN
    RAISE EXCEPTION 'asset-map run people batch contains an invalid id' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT r.id) FROM unnest(p_cedar_ridge_user_ids) AS r(id))
     <> cardinality(p_cedar_ridge_user_ids) THEN
    RAISE EXCEPTION 'asset-map run people batch contains a duplicate id' USING ERRCODE = '22023';
  END IF;

  FOREACH v_id IN ARRAY p_cedar_ridge_user_ids LOOP
    v_found := false;
    v_conflict := false;
    v_survivors := ARRAY[]::text[];
    v_keys := ARRAY[]::text[];

    FOR v_client_key IN
      SELECT c.sf_id FROM mirror.client c WHERE c.cedar_ridge_user_id = v_id ORDER BY c.sf_id
    LOOP
      v_found := true;

      SELECT array_agg(DISTINCT m.identity_id)
        INTO v_start
        FROM app.crm_source_mapping m
       WHERE m.source_system = 'CRM'
         AND m.source_namespace = 'contact'
         AND m.mapping_state = 'ACTIVE'
         AND left(m.source_key, 15) = left(v_client_key, 15);
      IF v_start IS NULL OR cardinality(v_start) <> 1 THEN
        v_conflict := true;
        EXIT;
      END IF;

      v_current := v_start[1];
      v_seen := ARRAY[v_current];
      v_survivor := NULL;
      FOR v_depth IN 1..8 LOOP
        SELECT i.identity_type INTO v_type FROM app.crm_identity i WHERE i.id = v_current;
        EXIT WHEN v_type IS DISTINCT FROM 'CONTACT';
        SELECT array_agg(DISTINCT d.canonical_identity_id)
          INTO v_next
          FROM app.crm_duplicate_candidate d
         WHERE d.entity_type = 'CONTACT'
           AND d.status = 'READY_FOR_FOLLOW_UP'
           AND d.canonical_identity_id IS NOT NULL
           AND d.canonical_identity_id <> v_current
           AND v_current IN (d.left_identity_id, d.right_identity_id);
        IF v_next IS NULL THEN
          v_survivor := v_current;
          EXIT;
        END IF;
        EXIT WHEN cardinality(v_next) <> 1 OR v_next[1] = ANY (v_seen);
        v_current := v_next[1];
        v_seen := v_seen || v_current;
      END LOOP;
      IF v_survivor IS NULL THEN
        v_conflict := true;
        EXIT;
      END IF;

      SELECT i.identity_type, i.lifecycle_state INTO v_type, v_state
        FROM app.crm_identity i WHERE i.id = v_survivor;
      IF v_type IS DISTINCT FROM 'CONTACT' OR v_state IS DISTINCT FROM 'ACTIVE' THEN
        v_conflict := true;
        EXIT;
      END IF;

      SELECT array_agg(DISTINCT c.sf_id), coalesce(bool_and(c.cedar_ridge_user_id IS NULL OR c.cedar_ridge_user_id = v_id), false)
        INTO v_targets, v_compatible
        FROM app.crm_source_mapping m
        JOIN mirror.client c ON left(c.sf_id, 15) = left(m.source_key, 15)
       WHERE m.identity_id = v_survivor
         AND m.source_system = 'CRM'
         AND m.source_namespace = 'contact'
         AND m.mapping_state = 'ACTIVE';
      IF v_targets IS NULL OR cardinality(v_targets) <> 1 OR NOT v_compatible THEN
        v_conflict := true;
        EXIT;
      END IF;

      IF NOT (v_survivor = ANY (v_survivors)) THEN
        v_survivors := v_survivors || v_survivor;
        v_keys := v_keys || v_targets[1];
      END IF;
    END LOOP;

    cedar_ridge_user_id := v_id;
    canonical_contact_identity_id := NULL;
    canonical_contact_source_key := NULL;
    IF NOT v_found THEN
      outcome := 'missing';
    ELSIF v_conflict THEN
      outcome := 'conflict';
    ELSIF cardinality(v_survivors) = 1 THEN
      outcome := 'resolved';
      canonical_contact_identity_id := v_survivors[1];
      canonical_contact_source_key := v_keys[1];
    ELSE
      outcome := 'ambiguous';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- The resolver owner (this migration's role) reads the FORCE-RLS sources it
-- walks through these narrow SELECT-only policies. No runtime role gains any
-- registry or client privilege from them.
CREATE POLICY acat_asset_map_run_people_resolver_read ON mirror.client
  FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY acat_asset_map_run_people_resolver_read ON app.crm_identity
  FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY acat_asset_map_run_people_resolver_read ON app.crm_source_mapping
  FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY acat_asset_map_run_people_resolver_read ON app.crm_duplicate_candidate
  FOR SELECT TO CURRENT_USER USING (true);

-- ---------------------------------------------------------------------------
-- 7. Privileges. The mirror schema's default privileges give app_rw SELECT and
--    ingest_rw SELECT/INSERT/UPDATE on every new table; a narrower GRANT does
--    not remove those. Reset everything first, then grant only what ingest
--    needs. app_rw and PUBLIC receive nothing. No role may DELETE; history is
--    INSERT/SELECT only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON mirror.acat_asset_map_run_identity, mirror.acat_asset_map_run_person, mirror.acat_asset_map_run_identity_history
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_run_identity TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_run_person TO ingest_rw;
GRANT SELECT, INSERT ON mirror.acat_asset_map_run_identity_history TO ingest_rw;

REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_identity_sorted_set(text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_identity_state_valid(text, text, text, text[], text, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_identity_resolutions_valid(jsonb, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_identity_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_person_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_identity_history_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION mirror.acat_asset_map_run_identity_check_consistency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mirror.acat_asset_map_run_identity_sorted_set(text[], integer, integer) TO ingest_rw;
GRANT EXECUTE ON FUNCTION mirror.acat_asset_map_run_identity_state_valid(text, text, text, text[], text, text, text, text[]) TO ingest_rw;
GRANT EXECUTE ON FUNCTION mirror.acat_asset_map_run_identity_resolutions_valid(jsonb, text[], text) TO ingest_rw;

REVOKE ALL ON FUNCTION app.resolve_asset_map_run_people(text[]) FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION app.resolve_asset_map_run_people(text[]) TO ingest_rw;

-- ---------------------------------------------------------------------------
-- 8. Row-Level Security. ENABLE + FORCE on all three tables so the
--    non-superuser owner is filtered too. Only ingest_rw has policies, split by
--    command so history has no UPDATE/DELETE path; app_rw has none.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.acat_asset_map_run_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_run_identity FORCE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_run_person ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_run_person FORCE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_run_identity_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_run_identity_history FORCE ROW LEVEL SECURITY;

CREATE POLICY acat_asset_map_run_identity_ingest_select ON mirror.acat_asset_map_run_identity
  FOR SELECT TO ingest_rw USING (true);
CREATE POLICY acat_asset_map_run_identity_ingest_insert ON mirror.acat_asset_map_run_identity
  FOR INSERT TO ingest_rw WITH CHECK (true);
CREATE POLICY acat_asset_map_run_identity_ingest_update ON mirror.acat_asset_map_run_identity
  FOR UPDATE TO ingest_rw USING (true) WITH CHECK (true);

CREATE POLICY acat_asset_map_run_person_ingest_select ON mirror.acat_asset_map_run_person
  FOR SELECT TO ingest_rw USING (true);
CREATE POLICY acat_asset_map_run_person_ingest_insert ON mirror.acat_asset_map_run_person
  FOR INSERT TO ingest_rw WITH CHECK (true);
CREATE POLICY acat_asset_map_run_person_ingest_update ON mirror.acat_asset_map_run_person
  FOR UPDATE TO ingest_rw USING (true) WITH CHECK (true);

CREATE POLICY acat_asset_map_run_identity_history_ingest_select ON mirror.acat_asset_map_run_identity_history
  FOR SELECT TO ingest_rw USING (true);
CREATE POLICY acat_asset_map_run_identity_history_ingest_insert ON mirror.acat_asset_map_run_identity_history
  FOR INSERT TO ingest_rw WITH CHECK (true);
