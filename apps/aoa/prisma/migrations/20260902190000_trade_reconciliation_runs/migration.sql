-- Development-first Trade Reconciliation archive. Completed result snapshots,
-- run notes, and break reviews are all append-only. The persisted payload is
-- already redacted by the server: account IDs are reduced to a masked suffix.

BEGIN;

CREATE TABLE "app"."trade_reconciliation_run" (
  "id" TEXT NOT NULL,
  "business_date" DATE NOT NULL,
  "algorithm_version" VARCHAR(32) NOT NULL,
  "source_scope_version" VARCHAR(32) NOT NULL,
  "source_digest" CHAR(64) NOT NULL,
  "source_commit_sha" VARCHAR(64) NOT NULL,
  "apex_record_count" INTEGER NOT NULL,
  "meridian_record_count" INTEGER NOT NULL,
  "raw_match_count" INTEGER NOT NULL,
  "exception_count" INTEGER NOT NULL,
  "raw_match_rate" DECIMAL(7,4) NOT NULL,
  "payload" JSONB NOT NULL,
  "completed_by" VARCHAR(320),
  "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "trade_reconciliation_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trade_reconciliation_run_idempotency_key"
    UNIQUE ("business_date", "algorithm_version", "source_digest"),
  CONSTRAINT "trade_reconciliation_run_digest_check"
    CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "trade_reconciliation_run_counts_check"
    CHECK (
      "apex_record_count" >= 0 AND "meridian_record_count" >= 0
      AND "raw_match_count" >= 0 AND "exception_count" >= 0
      AND "raw_match_count" + "exception_count" >= "apex_record_count"
    ),
  CONSTRAINT "trade_reconciliation_run_rate_check"
    CHECK ("raw_match_rate" >= 0 AND "raw_match_rate" <= 100),
  CONSTRAINT "trade_reconciliation_run_payload_check"
    CHECK (jsonb_typeof("payload") = 'array')
);

CREATE INDEX "trade_reconciliation_run_business_date_completed_idx"
  ON "app"."trade_reconciliation_run"("business_date" DESC, "completed_at" DESC);
CREATE INDEX "trade_reconciliation_run_completed_idx"
  ON "app"."trade_reconciliation_run"("completed_at" DESC);

CREATE TABLE "app"."trade_reconciliation_review_event" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "row_fingerprint" CHAR(64) NOT NULL,
  "classification" VARCHAR(64) NOT NULL,
  "explanation" VARCHAR(1000) NOT NULL,
  "reviewer_email" VARCHAR(320),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "trade_reconciliation_review_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trade_reconciliation_review_event_run_fkey" FOREIGN KEY ("run_id")
    REFERENCES "app"."trade_reconciliation_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "trade_reconciliation_review_event_fingerprint_check"
    CHECK ("row_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "trade_reconciliation_review_event_classification_check"
    CHECK ("classification" IN (
      'Expected Apex-only trade', 'Timing difference', 'Correction/cancellation',
      'Quantity discrepancy', 'Needs investigation', 'Other'
    )),
  CONSTRAINT "trade_reconciliation_review_event_explanation_check"
    CHECK (length(btrim("explanation")) BETWEEN 1 AND 1000)
);

CREATE INDEX "trade_reconciliation_review_event_row_idx"
  ON "app"."trade_reconciliation_review_event"("run_id", "row_fingerprint", "created_at" DESC);
CREATE INDEX "trade_reconciliation_review_event_created_idx"
  ON "app"."trade_reconciliation_review_event"("created_at" DESC);

CREATE TABLE "app"."trade_reconciliation_note_event" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "note" VARCHAR(1000) NOT NULL,
  "author_email" VARCHAR(320),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "trade_reconciliation_note_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trade_reconciliation_note_event_run_fkey" FOREIGN KEY ("run_id")
    REFERENCES "app"."trade_reconciliation_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "trade_reconciliation_note_event_note_check"
    CHECK (length(btrim("note")) BETWEEN 1 AND 1000)
);

CREATE INDEX "trade_reconciliation_note_event_run_idx"
  ON "app"."trade_reconciliation_note_event"("run_id", "created_at" DESC);
CREATE INDEX "trade_reconciliation_note_event_created_idx"
  ON "app"."trade_reconciliation_note_event"("created_at" DESC);

REVOKE ALL ON "app"."trade_reconciliation_run" FROM PUBLIC, app_rw;
REVOKE ALL ON "app"."trade_reconciliation_review_event" FROM PUBLIC, app_rw;
REVOKE ALL ON "app"."trade_reconciliation_note_event" FROM PUBLIC, app_rw;
GRANT SELECT, INSERT ON "app"."trade_reconciliation_run" TO app_rw;
GRANT SELECT, INSERT ON "app"."trade_reconciliation_review_event" TO app_rw;
GRANT SELECT, INSERT ON "app"."trade_reconciliation_note_event" TO app_rw;

ALTER TABLE "app"."trade_reconciliation_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."trade_reconciliation_run" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."trade_reconciliation_review_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."trade_reconciliation_review_event" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."trade_reconciliation_note_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."trade_reconciliation_note_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY trade_reconciliation_run_ops_read ON "app"."trade_reconciliation_run"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY trade_reconciliation_run_ops_insert ON "app"."trade_reconciliation_run"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "completed_by" IS NOT DISTINCT FROM NULLIF(current_setting('app.user_email', true), '')
  );

CREATE POLICY trade_reconciliation_review_ops_read ON "app"."trade_reconciliation_review_event"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY trade_reconciliation_review_ops_insert ON "app"."trade_reconciliation_review_event"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "reviewer_email" IS NOT DISTINCT FROM NULLIF(current_setting('app.user_email', true), '')
    AND EXISTS (
      SELECT 1 FROM "app"."trade_reconciliation_run" r WHERE r.id = "run_id"
    )
  );

CREATE POLICY trade_reconciliation_note_ops_read ON "app"."trade_reconciliation_note_event"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY trade_reconciliation_note_ops_insert ON "app"."trade_reconciliation_note_event"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "author_email" IS NOT DISTINCT FROM NULLIF(current_setting('app.user_email', true), '')
    AND EXISTS (
      SELECT 1 FROM "app"."trade_reconciliation_run" r WHERE r.id = "run_id"
    )
  );

COMMIT;
