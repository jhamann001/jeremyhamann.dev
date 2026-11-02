-- ticket: Fee-schedule document bytes for custodian authority library.
-- Additive empty table. Foreign key to custodian_profile. No DELETE grant.
-- SELECT is role-only (ADMIN/OPERATIONS). INSERT/UPDATE require ADMIN.

CREATE TABLE "app"."custodian_fee_schedule_document" (
    "id" TEXT NOT NULL,
    "custodian_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_by" TEXT NOT NULL,

    CONSTRAINT "custodian_fee_schedule_document_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custodian_fee_schedule_document_content_type_check" CHECK ("content_type" IN ('application/pdf', 'image/png', 'image/jpeg')),
    CONSTRAINT "custodian_fee_schedule_document_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 10485760),
    CONSTRAINT "custodian_fee_schedule_document_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "custodian_fee_schedule_document_custodian_id_idx" ON "app"."custodian_fee_schedule_document"("custodian_id");

ALTER TABLE "app"."custodian_fee_schedule_document"
  ADD CONSTRAINT "custodian_fee_schedule_document_custodian_id_fkey"
  FOREIGN KEY ("custodian_id") REFERENCES "app"."custodian_profile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

REVOKE ALL ON "app"."custodian_fee_schedule_document" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON "app"."custodian_fee_schedule_document" TO app_rw;

ALTER TABLE "app"."custodian_fee_schedule_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_fee_schedule_document" FORCE ROW LEVEL SECURITY;

CREATE POLICY custodian_fee_schedule_document_read ON "app"."custodian_fee_schedule_document"
  FOR SELECT TO app_rw USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY custodian_fee_schedule_document_admin_insert ON "app"."custodian_fee_schedule_document"
  FOR INSERT TO app_rw WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
CREATE POLICY custodian_fee_schedule_document_admin_update ON "app"."custodian_fee_schedule_document"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

DO $$ BEGIN
  EXECUTE format('CREATE POLICY custodian_fee_schedule_document_owner ON "app"."custodian_fee_schedule_document" TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE TRIGGER custodian_fee_schedule_document_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_fee_schedule_document"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
