-- Slack closeout checklist (SLACK_TRANSFER_CLOSEOUT): two transfer CHILD tables
-- seeded on entry into IN_TRANSFER. Same posture as transfer_position_flag (all-roles
-- read, write-roles write, NO delete, owner-bypass for the seed) PLUS a GUC-less
-- ingest_rw policy so the n8n callback (withIngestScope) can update state — the
-- ingest_rw sibling pattern from the mirror ingest migrations
-- (…_mirror_roles_grants_rls: FOR ALL TO ingest_rw USING(true) WITH CHECK(true)).
-- NOT auto-audited (children ride the parent — allowlisted in KNOWN_UNAUDITED);
-- completion emits the explicit writeAudit(TRANSFER_SLACK_CLOSEOUT).

-- =========================================================================
-- app.transfer_slack_closeout — one row per transfer (the posted message ref +
-- overall status).
-- =========================================================================
CREATE TABLE "app"."transfer_slack_closeout" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "channel" TEXT,
    "message_ts" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "posted_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "transfer_slack_closeout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transfer_slack_closeout_transfer_id_key"
  ON "app"."transfer_slack_closeout"("transfer_id");

ALTER TABLE "app"."transfer_slack_closeout"
  ADD CONSTRAINT "transfer_slack_closeout_transfer_id_fkey"
  FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Grants: app_rw seeds + reads + updates; ingest_rw (the callback) reads +
-- updates; neither hard-deletes.
GRANT SELECT, INSERT, UPDATE ON "app"."transfer_slack_closeout" TO app_rw;
REVOKE DELETE ON "app"."transfer_slack_closeout" FROM app_rw;
GRANT SELECT, UPDATE ON "app"."transfer_slack_closeout" TO ingest_rw;

ALTER TABLE "app"."transfer_slack_closeout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_slack_closeout" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_slack_closeout_read_all_roles ON "app"."transfer_slack_closeout"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_slack_closeout_insert_write_roles ON "app"."transfer_slack_closeout"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_slack_closeout_update_write_roles ON "app"."transfer_slack_closeout"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

-- ingest_rw (the n8n callback via withIngestScope) — GUC-less, unconditional
-- (withIngestScope sets no app.user_role; a role-predicated policy would reject
-- every ingest write). Grants above limit it to SELECT/UPDATE.
CREATE POLICY transfer_slack_closeout_ingest_all ON "app"."transfer_slack_closeout"
  FOR ALL TO ingest_rw
  USING (true)
  WITH CHECK (true);

-- NO DELETE policy.

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
      'CREATE POLICY transfer_slack_closeout_owner_all ON "app"."transfer_slack_closeout" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

-- =========================================================================
-- app.transfer_slack_item — N rows per transfer (the checklist items).
-- =========================================================================
CREATE TABLE "app"."transfer_slack_item" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_by" TEXT,
    "done_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "transfer_slack_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transfer_slack_item_transfer_id_item_key_key"
  ON "app"."transfer_slack_item"("transfer_id", "item_key");
CREATE INDEX "transfer_slack_item_transfer_id_idx"
  ON "app"."transfer_slack_item"("transfer_id");

ALTER TABLE "app"."transfer_slack_item"
  ADD CONSTRAINT "transfer_slack_item_transfer_id_fkey"
  FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "app"."transfer_slack_item" TO app_rw;
REVOKE DELETE ON "app"."transfer_slack_item" FROM app_rw;
GRANT SELECT, UPDATE ON "app"."transfer_slack_item" TO ingest_rw;

ALTER TABLE "app"."transfer_slack_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_slack_item" FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_slack_item_read_all_roles ON "app"."transfer_slack_item"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_slack_item_insert_write_roles ON "app"."transfer_slack_item"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_slack_item_update_write_roles ON "app"."transfer_slack_item"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_slack_item_ingest_all ON "app"."transfer_slack_item"
  FOR ALL TO ingest_rw
  USING (true)
  WITH CHECK (true);

-- NO DELETE policy.

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
      'CREATE POLICY transfer_slack_item_owner_all ON "app"."transfer_slack_item" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;
