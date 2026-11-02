-- Operations-confirmed CRM parent mappings. The source record remains
-- authoritative for its text; AOA stores only internal CRM IDs, a controlled
-- relationship code, and reviewer provenance. Confirming a mapping resolves
-- the CRM exception and its central queue item in one transaction.

BEGIN;

CREATE TABLE "app"."crm_parent_override" (
  "id" TEXT NOT NULL,
  "source_mapping_id" TEXT NOT NULL,
  "child_identity_id" TEXT NOT NULL,
  "parent_identity_id" TEXT NOT NULL,
  "relationship_code" VARCHAR(64) NOT NULL,
  "confirmed_by" VARCHAR(320) NOT NULL,
  "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "crm_parent_override_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_parent_override_source_mapping_key" UNIQUE ("source_mapping_id"),
  CONSTRAINT "crm_parent_override_id_check" CHECK ("id" ~ '^c[0-9a-f]{24}$'),
  CONSTRAINT "crm_parent_override_not_self" CHECK ("child_identity_id" <> "parent_identity_id"),
  CONSTRAINT "crm_parent_override_relationship_check" CHECK (
    "relationship_code" IN (
      'CONTACT_TO_HOUSEHOLD',
      'DEAL_TO_HOUSEHOLD', 'DEAL_TO_CONTACT',
      'TRANSFER_TO_HOUSEHOLD', 'TRANSFER_TO_CONTACT',
      'EMAIL_TO_HOUSEHOLD', 'ACTIVITY_TO_HOUSEHOLD',
      'TASK_TO_HOUSEHOLD',
      'APPOINTMENT_TO_CONTACT', 'APPOINTMENT_TO_HOUSEHOLD'
    )
  ),
  CONSTRAINT "crm_parent_override_source_mapping_fkey" FOREIGN KEY ("source_mapping_id")
    REFERENCES "app"."crm_source_mapping"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_parent_override_child_identity_fkey" FOREIGN KEY ("child_identity_id")
    REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "crm_parent_override_parent_identity_fkey" FOREIGN KEY ("parent_identity_id")
    REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "crm_parent_override_child_idx"
  ON "app"."crm_parent_override"("child_identity_id");
CREATE INDEX "crm_parent_override_parent_idx"
  ON "app"."crm_parent_override"("parent_identity_id");

CREATE OR REPLACE FUNCTION "app"."validate_crm_parent_override"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_mapping_identity text;
  v_mapping_state text;
  v_child_type text;
  v_child_state text;
  v_parent_type text;
  v_parent_state text;
  v_expected_code text;
BEGIN
  SELECT m.identity_id, m.mapping_state
    INTO v_mapping_identity, v_mapping_state
    FROM app.crm_source_mapping m
   WHERE m.id = NEW.source_mapping_id;
  SELECT i.identity_type, i.lifecycle_state
    INTO v_child_type, v_child_state
    FROM app.crm_identity i
   WHERE i.id = NEW.child_identity_id;
  SELECT i.identity_type, i.lifecycle_state
    INTO v_parent_type, v_parent_state
    FROM app.crm_identity i
   WHERE i.id = NEW.parent_identity_id;

  IF v_mapping_identity IS DISTINCT FROM NEW.child_identity_id
     OR v_mapping_state IS DISTINCT FROM 'ACTIVE'
     OR v_child_state IS DISTINCT FROM 'ACTIVE'
     OR v_parent_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'CRM parent override requires active aligned records'
      USING ERRCODE = '23514';
  END IF;

  v_expected_code := CASE
    WHEN v_child_type = 'CONTACT' AND v_parent_type = 'HOUSEHOLD'
      THEN 'CONTACT_TO_HOUSEHOLD'
    WHEN v_child_type = 'DEAL' AND v_parent_type = 'HOUSEHOLD'
      THEN 'DEAL_TO_HOUSEHOLD'
    WHEN v_child_type = 'DEAL' AND v_parent_type = 'CONTACT'
      THEN 'DEAL_TO_CONTACT'
    WHEN v_child_type = 'TRANSFER' AND v_parent_type = 'HOUSEHOLD'
      THEN 'TRANSFER_TO_HOUSEHOLD'
    WHEN v_child_type = 'TRANSFER' AND v_parent_type = 'CONTACT'
      THEN 'TRANSFER_TO_CONTACT'
    WHEN v_child_type = 'EMAIL' AND v_parent_type = 'HOUSEHOLD'
      THEN 'EMAIL_TO_HOUSEHOLD'
    WHEN v_child_type = 'ACTIVITY' AND v_parent_type = 'HOUSEHOLD'
      THEN 'ACTIVITY_TO_HOUSEHOLD'
    WHEN v_child_type = 'TASK' AND v_parent_type = 'HOUSEHOLD'
      THEN 'TASK_TO_HOUSEHOLD'
    WHEN v_child_type = 'APPOINTMENT' AND v_parent_type = 'CONTACT'
      THEN 'APPOINTMENT_TO_CONTACT'
    WHEN v_child_type = 'APPOINTMENT' AND v_parent_type = 'HOUSEHOLD'
      THEN 'APPOINTMENT_TO_HOUSEHOLD'
    ELSE NULL
  END;

  IF v_expected_code IS NULL OR NEW.relationship_code <> v_expected_code THEN
    RAISE EXCEPTION 'CRM parent override endpoint types are not permitted'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_parent_override_validate
  BEFORE INSERT OR UPDATE OF
    source_mapping_id, child_identity_id, parent_identity_id, relationship_code
  ON "app"."crm_parent_override"
  FOR EACH ROW EXECUTE FUNCTION "app"."validate_crm_parent_override"();

-- The row contains controlled/internal IDs and reviewer provenance only. The
-- generic field-level audit therefore preserves every manual replacement
-- without copying appointment/client text or source keys.
CREATE TRIGGER crm_parent_override_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."crm_parent_override"
  FOR EACH ROW EXECUTE FUNCTION "audit"."log_row_change"();

GRANT SELECT ON "app"."crm_parent_override" TO app_rw;
REVOKE INSERT, UPDATE, DELETE ON "app"."crm_parent_override" FROM app_rw;

ALTER TABLE "app"."crm_parent_override" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."crm_parent_override" FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_parent_override_ops_read ON "app"."crm_parent_override"
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );

DO $$
DECLARE owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO owner_roles
    FROM pg_roles WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    EXECUTE format(
      'CREATE POLICY crm_parent_override_owner_all ON "app"."crm_parent_override" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

-- A later machine reconciliation must not reopen a human-confirmed mapping
-- simply because the upstream source still lacks a parent key. Returning NULL
-- skips that one UPDATE and keeps the manual decision authoritative.
CREATE OR REPLACE FUNCTION "app"."preserve_manual_crm_parent_resolution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF OLD.reason_code = 'MISSING_PARENT_MAPPING'
     AND OLD.exception_state = 'RESOLVED'
     AND OLD.resolution_code = 'MANUAL_LINK'
     AND NEW.exception_state = 'OPEN'
     AND EXISTS (
       SELECT 1 FROM app.crm_parent_override o
        WHERE o.source_mapping_id = OLD.source_mapping_id
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_identity_exception_preserve_manual_parent
  BEFORE UPDATE OF exception_state, resolution_code, resolved_at
  ON "app"."crm_identity_exception"
  FOR EACH ROW EXECUTE FUNCTION "app"."preserve_manual_crm_parent_resolution"();

CREATE OR REPLACE FUNCTION "app"."confirm_crm_parent_override"(
  p_exception_id text,
  p_child_identity_id text,
  p_parent_identity_id text
)
RETURNS TABLE(saved_override_id text, saved_relationship_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE
  v_role text := current_setting('app.user_role', true);
  v_email text := nullif(btrim(current_setting('app.user_email', true)), '');
  v_source_mapping_id text;
  v_child_type text;
  v_parent_type text;
  v_parent_state text;
  v_relationship_code text;
  v_override_id text;
  v_queue record;
BEGIN
  IF v_role NOT IN ('ADMIN', 'OPERATIONS') OR v_email IS NULL THEN
    RAISE EXCEPTION 'CRM parent confirmation is restricted to Operations'
      USING ERRCODE = '42501';
  END IF;

  SELECT e.source_mapping_id, i.identity_type
    INTO v_source_mapping_id, v_child_type
    FROM app.crm_identity_exception e
    JOIN app.crm_source_mapping m ON m.id = e.source_mapping_id
    JOIN app.crm_identity i ON i.id = m.identity_id
   WHERE e.id = p_exception_id
     AND e.reason_code = 'MISSING_PARENT_MAPPING'
     AND m.identity_id = p_child_identity_id
     AND m.mapping_state = 'ACTIVE'
     AND i.lifecycle_state = 'ACTIVE'
     AND (
       e.exception_state = 'OPEN'
       OR (
         e.exception_state = 'RESOLVED'
         AND e.resolution_code = 'MANUAL_LINK'
         AND EXISTS (
           SELECT 1 FROM app.crm_parent_override current_override
            WHERE current_override.source_mapping_id = e.source_mapping_id
         )
       )
     )
   FOR UPDATE OF e, m;

  IF v_source_mapping_id IS NULL THEN
    RAISE EXCEPTION 'CRM parent exception is not available for confirmation'
      USING ERRCODE = '23514';
  END IF;

  SELECT identity_type, lifecycle_state
    INTO v_parent_type, v_parent_state
    FROM app.crm_identity
   WHERE id = p_parent_identity_id;
  IF v_parent_state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'CRM parent candidate is not active' USING ERRCODE = '23514';
  END IF;

  v_relationship_code := CASE
    WHEN v_child_type = 'CONTACT' AND v_parent_type = 'HOUSEHOLD'
      THEN 'CONTACT_TO_HOUSEHOLD'
    WHEN v_child_type = 'DEAL' AND v_parent_type = 'HOUSEHOLD'
      THEN 'DEAL_TO_HOUSEHOLD'
    WHEN v_child_type = 'DEAL' AND v_parent_type = 'CONTACT'
      THEN 'DEAL_TO_CONTACT'
    WHEN v_child_type = 'TRANSFER' AND v_parent_type = 'HOUSEHOLD'
      THEN 'TRANSFER_TO_HOUSEHOLD'
    WHEN v_child_type = 'TRANSFER' AND v_parent_type = 'CONTACT'
      THEN 'TRANSFER_TO_CONTACT'
    WHEN v_child_type = 'EMAIL' AND v_parent_type = 'HOUSEHOLD'
      THEN 'EMAIL_TO_HOUSEHOLD'
    WHEN v_child_type = 'ACTIVITY' AND v_parent_type = 'HOUSEHOLD'
      THEN 'ACTIVITY_TO_HOUSEHOLD'
    WHEN v_child_type = 'TASK' AND v_parent_type = 'HOUSEHOLD'
      THEN 'TASK_TO_HOUSEHOLD'
    WHEN v_child_type = 'APPOINTMENT' AND v_parent_type = 'CONTACT'
      THEN 'APPOINTMENT_TO_CONTACT'
    WHEN v_child_type = 'APPOINTMENT' AND v_parent_type = 'HOUSEHOLD'
      THEN 'APPOINTMENT_TO_HOUSEHOLD'
    ELSE NULL
  END;
  IF v_relationship_code IS NULL THEN
    RAISE EXCEPTION 'CRM parent candidate type is not permitted'
      USING ERRCODE = '23514';
  END IF;

  SELECT id INTO v_override_id
    FROM app.crm_parent_override
   WHERE source_mapping_id = v_source_mapping_id
   FOR UPDATE;
  IF v_override_id IS NULL THEN
    v_override_id := app.new_crm_internal_id();
    INSERT INTO app.crm_parent_override (
      id, source_mapping_id, child_identity_id, parent_identity_id,
      relationship_code, confirmed_by, updated_at
    ) VALUES (
      v_override_id, v_source_mapping_id, p_child_identity_id,
      p_parent_identity_id, v_relationship_code, v_email, now()
    );
  ELSE
    UPDATE app.crm_parent_override
       SET parent_identity_id = p_parent_identity_id,
           relationship_code = v_relationship_code,
           confirmed_by = v_email,
           confirmed_at = now(),
           updated_at = now()
     WHERE id = v_override_id;
  END IF;

  UPDATE app.crm_identity_exception
     SET exception_state = 'RESOLVED', resolution_code = 'MANUAL_LINK',
         resolved_at = now(), updated_at = now()
   WHERE id = p_exception_id;

  FOR v_queue IN
    SELECT id, status, exception_type
      FROM app.review_queue_item
     WHERE source = 'CRM_IDENTITY'::app."ReviewQueueSource"
       AND source_record_ref = p_exception_id
       AND source_active = true
     FOR UPDATE
  LOOP
    UPDATE app.review_queue_item
       SET source_active = false, status = 'RESOLVED',
           source_resolved_at = now(), resolved_at = now(),
           resolved_by = v_email, snoozed_until = NULL,
           updated_by = v_email, updated_at = now()
     WHERE id = v_queue.id;
    INSERT INTO app.review_queue_event (
      item_id, action, actor_email, actor_role, from_status, to_status, detail
    ) VALUES (
      v_queue.id, 'CONTEXT_RESOLVED', v_email, v_role,
      v_queue.status, 'RESOLVED',
      jsonb_build_object('source', 'CRM_IDENTITY', 'type', v_queue.exception_type)
    );
  END LOOP;

  INSERT INTO audit."AuditLog" (
    "actorEmail", "actorRole", "action", "entityType", "entityId", "detail"
  ) VALUES (
    v_email, v_role, 'crm.parent_mapping.confirm', 'crm_parent_override',
    v_override_id,
    jsonb_build_object(
      'childCrmId', p_child_identity_id,
      'parentCrmId', p_parent_identity_id,
      'relationshipCode', v_relationship_code
    )::text
  );

  RETURN QUERY SELECT v_override_id, v_relationship_code;
END;
$$;

REVOKE ALL ON FUNCTION "app"."validate_crm_parent_override"() FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
REVOKE ALL ON FUNCTION "app"."preserve_manual_crm_parent_resolution"() FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
REVOKE ALL ON FUNCTION "app"."confirm_crm_parent_override"(text, text, text) FROM PUBLIC, ingest_rw, identity_reconciler;
GRANT EXECUTE ON FUNCTION "app"."confirm_crm_parent_override"(text, text, text) TO app_rw;

COMMIT;
