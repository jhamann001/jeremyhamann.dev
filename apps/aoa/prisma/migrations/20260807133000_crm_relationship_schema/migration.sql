-- CRM relationship layer — Phase 4B dark relationship foundation.
--
-- Additive schema only:
--   * no relationship data or backfill;
--   * no app, ingest, or reconciler runtime access;
--   * no relationship reads, traversal, UI, workflow, or flag activation;
--   * no permission-bearing, account, document, or third-party edge types.

BEGIN;

CREATE TABLE "app"."crm_relationship" (
    "id" TEXT NOT NULL,
    "relationship_type" VARCHAR(64) NOT NULL,
    "from_identity_id" TEXT NOT NULL,
    "to_identity_id" TEXT NOT NULL,
    "evidence_mapping_id" TEXT NOT NULL,
    "relationship_state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "contract_version" SMALLINT NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "inactivated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crm_relationship_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_relationship_id_length_check" CHECK (
      char_length("id") BETWEEN 5 AND 64
    ),
    CONSTRAINT "crm_relationship_typed_id_check" CHECK (
      "id" ~ '^rel_[a-z0-9]+$'
    ),
    CONSTRAINT "crm_relationship_type_check" CHECK (
      "relationship_type" IN (
        'HOUSEHOLD_HAS_MEMBER',
        'DEAL_FOR_HOUSEHOLD',
        'TRANSFER_FOR_HOUSEHOLD'
      )
    ),
    CONSTRAINT "crm_relationship_not_self_check" CHECK (
      "from_identity_id" <> "to_identity_id"
    ),
    CONSTRAINT "crm_relationship_state_check" CHECK (
      "relationship_state" IN ('ACTIVE', 'INACTIVE')
    ),
    CONSTRAINT "crm_relationship_contract_version_check" CHECK (
      "contract_version" = 1
    ),
    CONSTRAINT "crm_relationship_inactive_state_check" CHECK (
      (
        "relationship_state" = 'ACTIVE'
        AND "inactivated_at" IS NULL
      ) OR (
        "relationship_state" = 'INACTIVE'
        AND "inactivated_at" IS NOT NULL
      )
    ),
    CONSTRAINT "crm_relationship_seen_order_check" CHECK (
      "last_seen_at" >= "first_seen_at"
      AND (
        "inactivated_at" IS NULL
        OR "inactivated_at" >= "first_seen_at"
      )
    ),
    CONSTRAINT "crm_relationship_from_identity_fkey" FOREIGN KEY ("from_identity_id")
      REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "crm_relationship_to_identity_fkey" FOREIGN KEY ("to_identity_id")
      REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "crm_relationship_evidence_mapping_fkey" FOREIGN KEY ("evidence_mapping_id")
      REFERENCES "app"."crm_source_mapping"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "crm_relationship_coordinate_key"
  ON "app"."crm_relationship"
    ("relationship_type", "from_identity_id", "to_identity_id", "evidence_mapping_id");
CREATE INDEX "crm_relationship_from_active_type_idx"
  ON "app"."crm_relationship"
    ("from_identity_id", "relationship_state", "relationship_type");
CREATE INDEX "crm_relationship_to_active_type_idx"
  ON "app"."crm_relationship"
    ("to_identity_id", "relationship_state", "relationship_type");
CREATE INDEX "crm_relationship_evidence_active_idx"
  ON "app"."crm_relationship" ("evidence_mapping_id", "relationship_state");

-- Type, endpoint lifecycle, and evidence alignment are database constraints,
-- not application conventions. Only an ACTIVE relationship requires ACTIVE
-- endpoints/evidence; historical inactive rows remain queryable if a source
-- mapping or identity later becomes inactive or merged.
CREATE OR REPLACE FUNCTION "app"."validate_crm_relationship"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  from_type text;
  from_state text;
  to_type text;
  to_state text;
  evidence_identity_id text;
  evidence_state text;
  expected_evidence_identity_id text;
BEGIN
  IF NEW."relationship_state" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT i."identity_type", i."lifecycle_state"
    INTO from_type, from_state
    FROM "app"."crm_identity" i
   WHERE i."id" = NEW."from_identity_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM relationship source identity is missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT i."identity_type", i."lifecycle_state"
    INTO to_type, to_state
    FROM "app"."crm_identity" i
   WHERE i."id" = NEW."to_identity_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM relationship target identity is missing'
      USING ERRCODE = '23503';
  END IF;

  IF from_state <> 'ACTIVE' OR to_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Active CRM relationships require active endpoint identities'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (
      NEW."relationship_type" = 'HOUSEHOLD_HAS_MEMBER'
      AND from_type = 'HOUSEHOLD'
      AND to_type = 'CONTACT'
    ) OR (
      NEW."relationship_type" = 'DEAL_FOR_HOUSEHOLD'
      AND from_type = 'DEAL'
      AND to_type = 'HOUSEHOLD'
    ) OR (
      NEW."relationship_type" = 'TRANSFER_FOR_HOUSEHOLD'
      AND from_type = 'TRANSFER'
      AND to_type = 'HOUSEHOLD'
    )
  ) THEN
    RAISE EXCEPTION 'CRM relationship endpoint types do not match the reviewed catalog'
      USING ERRCODE = '23514';
  END IF;

  SELECT m."identity_id", m."mapping_state"
    INTO evidence_identity_id, evidence_state
    FROM "app"."crm_source_mapping" m
   WHERE m."id" = NEW."evidence_mapping_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM relationship evidence mapping is missing'
      USING ERRCODE = '23503';
  END IF;

  IF evidence_state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Active CRM relationships require active evidence mappings'
      USING ERRCODE = '23514';
  END IF;

  expected_evidence_identity_id := CASE NEW."relationship_type"
    WHEN 'HOUSEHOLD_HAS_MEMBER' THEN NEW."to_identity_id"
    WHEN 'DEAL_FOR_HOUSEHOLD' THEN NEW."from_identity_id"
    WHEN 'TRANSFER_FOR_HOUSEHOLD' THEN NEW."from_identity_id"
    ELSE NULL
  END;

  IF evidence_identity_id IS DISTINCT FROM expected_evidence_identity_id THEN
    RAISE EXCEPTION 'CRM relationship evidence does not match the reviewed endpoint'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_relationship_validate
  BEFORE INSERT OR UPDATE OF
    "relationship_type", "from_identity_id", "to_identity_id",
    "evidence_mapping_id", "relationship_state"
  ON "app"."crm_relationship"
  FOR EACH ROW EXECUTE FUNCTION "app"."validate_crm_relationship"();

-- The source/evidence coordinate is immutable. A corrected derivation creates
-- a new relationship and inactivates the old evidence row, preserving history.
CREATE OR REPLACE FUNCTION "app"."protect_crm_relationship_coordinate"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW."relationship_type" IS DISTINCT FROM OLD."relationship_type"
     OR NEW."from_identity_id" IS DISTINCT FROM OLD."from_identity_id"
     OR NEW."to_identity_id" IS DISTINCT FROM OLD."to_identity_id"
     OR NEW."evidence_mapping_id" IS DISTINCT FROM OLD."evidence_mapping_id"
     OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version" THEN
    RAISE EXCEPTION 'CRM relationship coordinates are immutable; create new evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_relationship_protect_coordinate
  BEFORE UPDATE OF
    "relationship_type", "from_identity_id", "to_identity_id",
    "evidence_mapping_id", "contract_version"
  ON "app"."crm_relationship"
  FOR EACH ROW EXECUTE FUNCTION "app"."protect_crm_relationship_coordinate"();

-- Relationship rows contain typed/internal IDs and controlled codes only, so
-- the generic field-level audit trigger is safe and intentionally required by
-- the future-table guardrail.
CREATE TRIGGER crm_relationship_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."crm_relationship"
  FOR EACH ROW EXECUTE FUNCTION "audit"."log_row_change"();

REVOKE ALL ON FUNCTION "app"."validate_crm_relationship"()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
REVOKE ALL ON FUNCTION "app"."protect_crm_relationship_coordinate"()
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

-- Phase 4B is schema-dark. Default app-schema grants are explicitly removed,
-- and no runtime read or write policy exists. A later reviewed slice grants
-- only the constrained snapshot function and Operations-only read seam.
REVOKE ALL ON "app"."crm_relationship"
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;

ALTER TABLE "app"."crm_relationship" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_relationship" FORCE ROW LEVEL SECURITY;

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
      'CREATE POLICY crm_relationship_owner_all ON "app"."crm_relationship" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

COMMIT;
