-- Always-On Advice — database-enforced automatic audit logging (ADR-5).
--
-- This migration is hand-authored (Prisma scaffolded the empty folder), the
-- mirror_roles_grants_rls / app_deal idiom: the CreateTable / CreateIndex block
-- is written EXACTLY as Prisma would generate it for the `RowChange` model
-- (@@map("row_change"), @@schema("audit")) so there is no drift vs the datamodel
-- (Prisma's migrate-diff ignores the trigger/function/grants/RLS below — they
-- are not part of the datamodel — and only reconciles the table shape, which
-- matches the model 1:1). Everything below the table is the raw, Prisma-invisible
-- layer: a generic row-change trigger that fires on every write to the app.*
-- business tables, so the field-level trail can never be forgotten in app code.
-- It is COMPLEMENTARY to lib/audit.ts writeAudit (business events) — a raw layer
-- beneath it, not a replacement.
--
-- Additive-only (ADR-5): no drops/renames.

-- ---------------------------------------------------------------------------
-- 1. audit.row_change — the raw field-level trail (Prisma-generated shape).
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "audit"."row_change" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schema_name" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "row_pk" TEXT,
    "changed" JSONB NOT NULL,
    "actor_email" TEXT,
    "actor_role" TEXT,
    "db_role" TEXT NOT NULL,

    CONSTRAINT "row_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "row_change_schema_name_table_name_row_pk_idx" ON "audit"."row_change"("schema_name", "table_name", "row_pk");

-- CreateIndex
CREATE INDEX "row_change_at_idx" ON "audit"."row_change"("at");

-- ---------------------------------------------------------------------------
-- 2. audit.log_row_change() — the generic trigger function.
--
-- SECURITY DEFINER (owner = the migration role: `aoa` local / `aoa_admin` prod)
-- with a pinned search_path, so it ALWAYS writes the trail regardless of the
-- writing role's grants/search_path or the RLS on audit.row_change (the owner
-- bypasses non-forced RLS — see §4). Fully-qualified references throughout.
--
-- Diff logic:
--   * op          = TG_OP.
--   * UPDATE      = { col: {from, to} } for every column where OLD IS DISTINCT
--                   FROM NEW, computed by diffing to_jsonb(OLD) vs to_jsonb(NEW)
--                   per key. The housekeeping column `updated_at` is EXCLUDED
--                   from the diff (it bumps on every write — pure noise). If
--                   after excluding it nothing changed (updated_at was the ONLY
--                   difference), we SKIP the audit row entirely (RETURN NULL) to
--                   avoid noise — the documented recommended choice.
--   * INSERT      = full NEW snapshot; DELETE = full OLD snapshot.
--   * row_pk      = the row's id (NEW for ins/upd, OLD for del).
--   * actor_email = app.user_email GUC, '' -> NULL (unset outside withUserScope,
--                   e.g. an ingest_rw feed write, records NULL).
--   * actor_role  = app.user_role GUC, '' -> NULL.
--   * db_role     = session_user — the actual authenticated login role
--                   (app_rw / ingest_rw / aoa|aoa_admin), which is what
--                   distinguishes a user write from a feed write from a
--                   script/seed write. NOTE (judgement call): the spec wrote
--                   `current_user`, but inside a SECURITY DEFINER function
--                   current_user resolves to the function OWNER (always
--                   aoa/aoa_admin), which would make the column useless for its
--                   stated purpose. session_user is unaffected by SECURITY
--                   DEFINER and captures the real writer — so it is used here.
--
-- FAIL-CLOSED: any error here rolls back the triggering write (the app's
-- same-transaction audit philosophy — see lib/audit.ts). Errors are NOT
-- swallowed. Triggers are AFTER (row already validated/persisted); the return
-- value is ignored by AFTER triggers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.log_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
DECLARE
  old_j     jsonb;
  new_j     jsonb;
  changed_j jsonb := '{}'::jsonb;
  k         text;
  pk        text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);
    FOR k IN SELECT jsonb_object_keys(new_j) LOOP
      -- Housekeeping column: changes on every write, so never audited.
      IF k = 'updated_at' THEN
        CONTINUE;
      END IF;
      IF (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
        changed_j := changed_j
          || jsonb_build_object(k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k));
      END IF;
    END LOOP;
    -- Nothing changed except updated_at -> skip the noise row.
    IF changed_j = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    pk := new_j ->> 'id';
  ELSIF TG_OP = 'INSERT' THEN
    new_j := to_jsonb(NEW);
    changed_j := new_j;
    pk := new_j ->> 'id';
  ELSIF TG_OP = 'DELETE' THEN
    old_j := to_jsonb(OLD);
    changed_j := old_j;
    pk := old_j ->> 'id';
  END IF;

  INSERT INTO audit.row_change
    (schema_name, table_name, op, row_pk, changed, actor_email, actor_role, db_role)
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

  RETURN NULL; -- AFTER trigger: return value is ignored.
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Attach the trigger to the two real app.* business tables today
--    (app.deal, app.transfer). AFTER so the row is already validated/persisted
--    and the diff sees the committed OLD/NEW images. New app business tables
--    add their own `<table>_audit` trigger in their own migration.
-- ---------------------------------------------------------------------------
CREATE TRIGGER deal_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."deal"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();

CREATE TRIGGER transfer_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."transfer"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();

-- ---------------------------------------------------------------------------
-- 4. Grants + RLS on audit.row_change.
--    GRANTS mirror audit."AuditLog" exactly — append-only/immutable: SELECT +
--    INSERT only, NEVER UPDATE/DELETE (the audit posture from
--    mirror_roles_grants_rls + mirror_account_ingest). The trigger inserts as
--    the SECURITY DEFINER owner regardless of the writer's role, but INSERT is
--    still granted to app_rw + ingest_rw for cleanliness / consistency with the
--    AuditLog grant. Sequence usage matches the AuditLog_id_seq grant.
--    RLS is NOT mirrored — it is a DELIBERATE IMPROVEMENT over AuditLog:
--    audit."AuditLog" has NO row-level security (any app_rw session can read
--    every row); audit.row_change ADDS `ENABLE ROW LEVEL SECURITY` + the
--    `row_change_ops_read` SELECT policy, so this raw field-level trail is
--    readable ONLY by Ops/Admin/HoA — stricter than AuditLog on purpose (the
--    raw trail can carry full row snapshots, so it is a privileged view).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA audit TO app_rw, ingest_rw;

GRANT SELECT, INSERT ON "audit"."row_change" TO app_rw;
GRANT USAGE, SELECT ON SEQUENCE "audit"."row_change_id_seq" TO app_rw;

GRANT SELECT, INSERT ON "audit"."row_change" TO ingest_rw;
GRANT USAGE, SELECT ON SEQUENCE "audit"."row_change_id_seq" TO ingest_rw;

-- RLS: ENABLE only (NOT FORCE). ENABLE lets the table OWNER — i.e. the
-- SECURITY DEFINER function — bypass the policies so the trigger INSERT always
-- lands; FORCE would bind the owner too and block the trigger (there is
-- deliberately no INSERT policy — only the trigger writes). app_rw is subject
-- to the read policy below; a direct app_rw INSERT is denied (no INSERT policy),
-- which is intended — the app never writes this table by hand.
ALTER TABLE "audit"."row_change" ENABLE ROW LEVEL SECURITY;

-- Read: Ops / Admin / Head of Advisory only (the audit trail is a privileged
-- view). Same GUC idiom as the *_ops_all mirror policies; a missing GUC returns
-- NULL, so this fails closed (no rows outside a scoped withUserScope).
CREATE POLICY row_change_ops_read ON "audit"."row_change"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
