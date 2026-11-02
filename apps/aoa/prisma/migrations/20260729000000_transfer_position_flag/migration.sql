-- Partial-ACAT "is transferring" decision, AOA-owned, per (transfer, symbol).
-- A transfer CHILD (like transfer_task/decision/account): all-roles read,
-- write-roles write, NO delete, owner-bypass for the seed. NOT auto-audited
-- (children ride their parent — allowlisted in KNOWN_UNAUDITED); the per-edit
-- business audit is the explicit writeAudit(TRANSFER_POSITION_TRANSFERRING).

CREATE TABLE "app"."transfer_position_flag" (
    "id" TEXT NOT NULL,
    "transfer_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "is_transferring" BOOLEAN NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "transfer_position_flag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transfer_position_flag_transfer_id_symbol_key"
  ON "app"."transfer_position_flag"("transfer_id", "symbol");

ALTER TABLE "app"."transfer_position_flag"
  ADD CONSTRAINT "transfer_position_flag_transfer_id_fkey"
  FOREIGN KEY ("transfer_id") REFERENCES "app"."transfer"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Grants: app_rw reads + inserts + updates; never hard-deletes (ADR-7).
GRANT SELECT, INSERT, UPDATE ON "app"."transfer_position_flag" TO app_rw;
REVOKE DELETE ON "app"."transfer_position_flag" FROM app_rw;

-- RLS (FORCE binds the owner too — see the owner-bypass block below).
ALTER TABLE "app"."transfer_position_flag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."transfer_position_flag" FORCE ROW LEVEL SECURITY;

-- All app roles read; only the write roles insert/update (VIEWER cannot write
-- even if the UI misbehaves — the DB polices the server action).
CREATE POLICY transfer_position_flag_read_all_roles ON "app"."transfer_position_flag"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_position_flag_insert_write_roles ON "app"."transfer_position_flag"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_position_flag_update_write_roles ON "app"."transfer_position_flag"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

-- NO DELETE policy: rows are never deleted (uncheck / re-set instead).

-- Owner-role bypass (analogue of transfer_*_owner_all): FORCE RLS binds the
-- table owner, so the seed (run as the owner via DIRECT_DATABASE_URL) needs an
-- unconditional policy. Local owner `aoa`, prod `aoa_admin`; pg_roles-guarded.
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
      'CREATE POLICY transfer_position_flag_owner_all ON "app"."transfer_position_flag" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;
