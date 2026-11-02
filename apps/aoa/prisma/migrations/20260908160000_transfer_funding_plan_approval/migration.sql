-- Funding-plan approval contract.
-- Selection changes remain browser-local drafts. One explicit approval writes
-- the rail, position instructions, immutable version metadata, and the exact
-- execution snapshot in a single transaction. Root metadata inherits the
-- transfer's RLS; snapshot history gets its own narrower policy below.

ALTER TABLE "app"."transfer"
  ADD COLUMN "funding_plan_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN "funding_plan_approved_at" timestamptz(6),
  ADD COLUMN "funding_plan_approved_by" text;

-- Immutable approval history. It is deliberately restricted to Operations and
-- admins and excluded from the generic row-change trigger because snapshot
-- and note can contain client financial context. approveFundingPlan writes one
-- redacted business audit event in the same transaction.
CREATE TABLE "app"."transfer_funding_plan_approval" (
  "id" text NOT NULL,
  "transfer_id" text NOT NULL,
  "version" integer NOT NULL,
  "funding_type" "FundingType" NOT NULL,
  "snapshot" jsonb NOT NULL,
  "note" text,
  "approved_by" text,
  "approved_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transfer_funding_plan_approval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transfer_funding_plan_approval_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "transfer_funding_plan_approval_transfer_id_version_key"
  ON "app"."transfer_funding_plan_approval"("transfer_id", "version");
CREATE INDEX "transfer_funding_plan_approval_transfer_id_idx"
  ON "app"."transfer_funding_plan_approval"("transfer_id");

GRANT SELECT, INSERT ON "app"."transfer_funding_plan_approval" TO app_rw;
REVOKE UPDATE, DELETE ON "app"."transfer_funding_plan_approval" FROM app_rw;

ALTER TABLE "app"."transfer_funding_plan_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_funding_plan_approval" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_funding_plan_approval_read_ops
  ON "app"."transfer_funding_plan_approval"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );

CREATE POLICY transfer_funding_plan_approval_insert_ops
  ON "app"."transfer_funding_plan_approval"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );
