-- CRM relationship layer — Phase 1 identity schema.
--
-- Additive foundation only:
--   * no existing primary key, source key, route, or mirror row changes;
--   * no data/backfill;
--   * no app_rw or ingest_rw access;
--   * no reconciler role yet;
--   * no relationship/edge storage.
--
-- Runtime access remains dark until a later reviewed phase grants a dedicated
-- machine principal and enables an independently default-off feature flag.

BEGIN;

CREATE TABLE "app"."crm_identity" (
    "id" TEXT NOT NULL,
    "identity_type" VARCHAR(32) NOT NULL,
    "lifecycle_state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "merged_into_id" TEXT,
    "contract_version" SMALLINT NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crm_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_identity_type_check" CHECK (
      "identity_type" IN (
        'HOUSEHOLD', 'CONTACT', 'ACCOUNT', 'DEAL', 'TRANSFER', 'TASK',
        'DOCUMENT', 'THIRD_PARTY', 'EMAIL', 'ACTIVITY', 'APPOINTMENT'
      )
    ),
    CONSTRAINT "crm_identity_id_length_check" CHECK (char_length("id") BETWEEN 5 AND 64),
    CONSTRAINT "crm_identity_typed_prefix_check" CHECK (
      ("identity_type" = 'HOUSEHOLD'   AND "id" ~ '^hld_[a-z0-9]+$') OR
      ("identity_type" = 'CONTACT'     AND "id" ~ '^con_[a-z0-9]+$') OR
      ("identity_type" = 'ACCOUNT'     AND "id" ~ '^acc_[a-z0-9]+$') OR
      ("identity_type" = 'DEAL'        AND "id" ~ '^dea_[a-z0-9]+$') OR
      ("identity_type" = 'TRANSFER'    AND "id" ~ '^xfr_[a-z0-9]+$') OR
      ("identity_type" = 'TASK'        AND "id" ~ '^tsk_[a-z0-9]+$') OR
      ("identity_type" = 'DOCUMENT'    AND "id" ~ '^doc_[a-z0-9]+$') OR
      ("identity_type" = 'THIRD_PARTY' AND "id" ~ '^tpr_[a-z0-9]+$') OR
      ("identity_type" = 'EMAIL'       AND "id" ~ '^eml_[a-z0-9]+$') OR
      ("identity_type" = 'ACTIVITY'    AND "id" ~ '^act_[a-z0-9]+$') OR
      ("identity_type" = 'APPOINTMENT' AND "id" ~ '^apt_[a-z0-9]+$')
    ),
    CONSTRAINT "crm_identity_lifecycle_state_check" CHECK (
      "lifecycle_state" IN ('ACTIVE', 'MERGED', 'ARCHIVED')
    ),
    CONSTRAINT "crm_identity_contract_version_check" CHECK ("contract_version" = 1),
    CONSTRAINT "crm_identity_merge_state_check" CHECK (
      ("lifecycle_state" = 'MERGED' AND "merged_into_id" IS NOT NULL) OR
      ("lifecycle_state" IN ('ACTIVE', 'ARCHIVED') AND "merged_into_id" IS NULL)
    ),
    CONSTRAINT "crm_identity_not_self_merged_check" CHECK (
      "merged_into_id" IS NULL OR "merged_into_id" <> "id"
    ),
    CONSTRAINT "crm_identity_merged_into_fkey" FOREIGN KEY ("merged_into_id")
      REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "crm_identity_identity_type_lifecycle_state_idx"
  ON "app"."crm_identity"("identity_type", "lifecycle_state");
CREATE INDEX "crm_identity_merged_into_id_idx"
  ON "app"."crm_identity"("merged_into_id");

CREATE TABLE "app"."crm_source_mapping" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "source_namespace" VARCHAR(64) NOT NULL,
    "source_key" TEXT NOT NULL,
    "mapping_state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crm_source_mapping_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_source_mapping_identity_id_fkey" FOREIGN KEY ("identity_id")
      REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "crm_source_mapping_system_check" CHECK (
      "source_system" ~ '^[A-Z][A-Z0-9_]{1,63}$'
    ),
    CONSTRAINT "crm_source_mapping_namespace_check" CHECK (
      "source_namespace" ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
    CONSTRAINT "crm_source_mapping_key_check" CHECK (
      char_length(btrim("source_key")) BETWEEN 1 AND 512
    ),
    CONSTRAINT "crm_source_mapping_state_check" CHECK (
      "mapping_state" IN ('ACTIVE', 'SUPERSEDED')
    ),
    CONSTRAINT "crm_source_mapping_superseded_state_check" CHECK (
      ("mapping_state" = 'ACTIVE' AND "superseded_at" IS NULL) OR
      ("mapping_state" = 'SUPERSEDED' AND "superseded_at" IS NOT NULL)
    ),
    CONSTRAINT "crm_source_mapping_seen_order_check" CHECK (
      "last_seen_at" >= "first_seen_at"
      AND ("superseded_at" IS NULL OR "superseded_at" >= "first_seen_at")
    )
);

CREATE UNIQUE INDEX "crm_source_mapping_source_system_source_namespace_source_key_key"
  ON "app"."crm_source_mapping"("source_system", "source_namespace", "source_key");
CREATE INDEX "crm_source_mapping_identity_id_idx"
  ON "app"."crm_source_mapping"("identity_id");
CREATE INDEX "crm_source_mapping_mapping_state_last_seen_at_idx"
  ON "app"."crm_source_mapping"("mapping_state", "last_seen_at");

CREATE TABLE "app"."crm_identity_exception" (
    "id" TEXT NOT NULL,
    "source_mapping_id" TEXT NOT NULL,
    "reason_code" VARCHAR(48) NOT NULL,
    "exception_state" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "resolution_code" VARCHAR(48),
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crm_identity_exception_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_identity_exception_source_mapping_id_fkey"
      FOREIGN KEY ("source_mapping_id")
      REFERENCES "app"."crm_source_mapping"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "crm_identity_exception_reason_check" CHECK (
      "reason_code" IN (
        'MISSING_PARENT_MAPPING', 'AMBIGUOUS_PARENT_MAPPING',
        'IDENTITY_TYPE_MISMATCH', 'SOURCE_KEY_COLLISION'
      )
    ),
    CONSTRAINT "crm_identity_exception_state_check" CHECK (
      "exception_state" IN ('OPEN', 'RESOLVED')
    ),
    CONSTRAINT "crm_identity_exception_resolution_check" CHECK (
      ("exception_state" = 'OPEN' AND "resolution_code" IS NULL AND "resolved_at" IS NULL) OR
      (
        "exception_state" = 'RESOLVED'
        AND "resolution_code" IN (
          'PARENT_MAPPED', 'MANUAL_LINK', 'IDENTITY_MERGED',
          'SOURCE_CORRECTED', 'NOT_APPLICABLE'
        )
        AND "resolved_at" IS NOT NULL
        AND "resolved_at" >= "detected_at"
      )
    )
);

CREATE UNIQUE INDEX "crm_identity_exception_source_mapping_id_reason_code_key"
  ON "app"."crm_identity_exception"("source_mapping_id", "reason_code");
CREATE INDEX "crm_identity_exception_exception_state_detected_at_idx"
  ON "app"."crm_identity_exception"("exception_state", "detected_at");

-- Merge targets must have the same identity type and merge chains must remain
-- acyclic. The FK and CHECK constraints handle existence/self-merges; this
-- trigger handles cross-type and indirect cycles.
CREATE OR REPLACE FUNCTION "app"."validate_crm_identity_merge"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  target_type text;
  reaches_self boolean;
BEGIN
  IF NEW."merged_into_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT i."identity_type"
    INTO target_type
    FROM "app"."crm_identity" i
   WHERE i."id" = NEW."merged_into_id";

  IF FOUND AND target_type <> NEW."identity_type" THEN
    RAISE EXCEPTION 'CRM identity merge types must match'
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE merge_chain AS (
    SELECT i."id", i."merged_into_id", ARRAY[i."id"]::text[] AS path, false AS cycle
      FROM "app"."crm_identity" i
     WHERE i."id" = NEW."merged_into_id"
    UNION ALL
    SELECT i."id", i."merged_into_id", c.path || i."id",
           i."id" = ANY(c.path) AS cycle
      FROM "app"."crm_identity" i
      JOIN merge_chain c ON i."id" = c."merged_into_id"
     WHERE NOT c.cycle
  )
  SELECT EXISTS (
    SELECT 1 FROM merge_chain WHERE "id" = NEW."id" OR cycle
  ) INTO reaches_self;

  IF reaches_self THEN
    RAISE EXCEPTION 'CRM identity merge cycle rejected'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_identity_validate_merge
  BEFORE INSERT OR UPDATE OF "identity_type", "merged_into_id"
  ON "app"."crm_identity"
  FOR EACH ROW EXECUTE FUNCTION "app"."validate_crm_identity_merge"();

-- A source coordinate and its canonical identity are immutable. Re-keying
-- inserts a new mapping for the same identity and marks the old mapping
-- SUPERSEDED, preserving both aliases and their audit history.
CREATE OR REPLACE FUNCTION "app"."protect_crm_source_mapping_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW."identity_id" IS DISTINCT FROM OLD."identity_id"
     OR NEW."source_system" IS DISTINCT FROM OLD."source_system"
     OR NEW."source_namespace" IS DISTINCT FROM OLD."source_namespace"
     OR NEW."source_key" IS DISTINCT FROM OLD."source_key" THEN
    RAISE EXCEPTION 'CRM source identity coordinates are immutable; add a new alias'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_source_mapping_protect_identity
  BEFORE UPDATE OF "identity_id", "source_system", "source_namespace", "source_key"
  ON "app"."crm_source_mapping"
  FOR EACH ROW EXECUTE FUNCTION "app"."protect_crm_source_mapping_identity"();

-- Dedicated audit function for source mappings. External source keys may be
-- account numbers or other sensitive identifiers, so this function never
-- reads or copies that column into audit.row_change. Routine last-seen updates
-- are excluded from the diff to avoid a high-volume, low-value audit trail.
CREATE OR REPLACE FUNCTION "audit"."log_crm_source_mapping_change"()
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
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_j := jsonb_build_object(
      'id', OLD."id",
      'identity_id', OLD."identity_id",
      'source_system', OLD."source_system",
      'source_namespace', OLD."source_namespace",
      'mapping_state', OLD."mapping_state",
      'first_seen_at', OLD."first_seen_at",
      'superseded_at', OLD."superseded_at",
      'created_at', OLD."created_at"
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_j := jsonb_build_object(
      'id', NEW."id",
      'identity_id', NEW."identity_id",
      'source_system', NEW."source_system",
      'source_namespace', NEW."source_namespace",
      'mapping_state', NEW."mapping_state",
      'first_seen_at', NEW."first_seen_at",
      'superseded_at', NEW."superseded_at",
      'created_at', NEW."created_at"
    );
  END IF;

  IF TG_OP = 'INSERT' THEN
    changed_j := new_j;
    pk := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    changed_j := old_j;
    pk := OLD."id";
  ELSE
    FOR k IN SELECT jsonb_object_keys(new_j) LOOP
      IF (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
        changed_j := changed_j || jsonb_build_object(
          k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k)
        );
      END IF;
    END LOOP;
    IF changed_j = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    pk := NEW."id";
  END IF;

  INSERT INTO "audit"."row_change"
    ("schema_name", "table_name", "op", "row_pk", "changed",
     "actor_email", "actor_role", "db_role")
  VALUES (
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    TG_OP,
    pk,
    changed_j,
    nullif(current_setting('app.user_email', true), ''),
    nullif(current_setting('app.user_role', true), ''),
    session_user
  );

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION "audit"."log_crm_source_mapping_change"() FROM PUBLIC, app_rw, ingest_rw;

CREATE TRIGGER crm_identity_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."crm_identity"
  FOR EACH ROW EXECUTE FUNCTION "audit"."log_row_change"();

CREATE TRIGGER crm_source_mapping_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."crm_source_mapping"
  FOR EACH ROW EXECUTE FUNCTION "audit"."log_crm_source_mapping_change"();

CREATE TRIGGER crm_identity_exception_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."crm_identity_exception"
  FOR EACH ROW EXECUTE FUNCTION "audit"."log_row_change"();

-- Phase 1 is schema-dark. Human runtime and ingest receive no privileges, and
-- no policies can fabricate access. The migration owners retain a guarded
-- FORCE-RLS path for migrations and the separately reviewed Phase 2 backfill.
REVOKE ALL ON "app"."crm_identity" FROM PUBLIC, app_rw, ingest_rw;
REVOKE ALL ON "app"."crm_source_mapping" FROM PUBLIC, app_rw, ingest_rw;
REVOKE ALL ON "app"."crm_identity_exception" FROM PUBLIC, app_rw, ingest_rw;

ALTER TABLE "app"."crm_identity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_identity" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_source_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_source_mapping" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_identity_exception" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_identity_exception" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO owner_roles
    FROM pg_roles
   WHERE rolname IN ('aoa', 'aoa_admin');

  IF owner_roles IS NOT NULL THEN
    EXECUTE format(
      'CREATE POLICY crm_identity_owner_all ON "app"."crm_identity" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
    EXECUTE format(
      'CREATE POLICY crm_source_mapping_owner_all ON "app"."crm_source_mapping" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
    EXECUTE format(
      'CREATE POLICY crm_identity_exception_owner_all ON "app"."crm_identity_exception" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

COMMIT;
