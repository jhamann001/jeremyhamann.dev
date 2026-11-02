-- AI meeting prep (flag AI_MEETING_PREP) — the Gemini-generated internal prep
-- brief for one appointment, written by the generateMeetingPrep Server Action.
--
-- Follows the app-owned child-table template (20260729000000_transfer_position_flag):
-- ENABLE + FORCE ROW LEVEL SECURITY, per-operation policies on the
-- current_setting('app.user_role', true) GUC, REVOKE DELETE + no DELETE policy,
-- and the pg_roles-guarded owner-bypass DO $$ block. TWO deliberate divergences,
-- both because this table holds the densest client PII in the app (a synthesized
-- narrative of one household's money, mail and open items):
--
--   1. VIEWER is EXCLUDED from the SELECT policy (blueprint ADR-3). Every
--      neighbouring app.* child grants all-roles read, and mirror.appointment
--      itself is read by all six roles incl. VIEWER — because the Meetings card
--      is a firm overview and the digest carries only names and times. A
--      GENERATED BRIEF is a different data class. A VIEWER keeps seeing the
--      meeting row; the prep affordance and the underlying SELECT are denied.
--      The five-role predicate matches canWriteTransfers (lib/data/transfer-write.ts:
--      everyone except VIEWER), so the UI gate and the DB gate agree.
--   2. NO ingest_rw grant at all. Nothing machine-written ever touches this
--      table; it is written only by a human clicking Generate.
--
-- NO FOREIGN KEY to mirror.appointment (ADR-2): the appointments feed
-- FULL-REPLACES its set on every run (ingest_rw holds DELETE on
-- mirror.appointment), so an FK would either block the replace or cascade the
-- briefs away — and cross-schema app→mirror FKs are against the house
-- data-class separation. appointment_key is deterministic
-- (appointmentKey(source, clientName, startsAtIso)), so it is stable across
-- digest re-ingests; a RESCHEDULED meeting changes starts_at → changes the key →
-- the old brief no longer resolves and the row offers "Generate prep" again.
--
-- NOT auto-audited (ADR-7): audit.log_row_change() records the FULL NEW row
-- snapshot on INSERT and would copy the brief into audit.row_change on every
-- generate. This table is allowlisted in KNOWN_UNAUDITED
-- (test/audit/row-change.integration.test.ts) and the trail is the explicit
-- writeAudit(MEETING_PREP_GENERATE), whose detail is ids + enums + counts only.

CREATE TABLE "app"."meeting_prep" (
    "id" TEXT NOT NULL,
    -- mirror.appointment.external_key — deliberately NOT a foreign key (ADR-2).
    "appointment_key" TEXT NOT NULL,
    "client_sf_id" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    -- The generated markdown brief: the PII payload. Never logged, never audited.
    "brief" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "finish_reason" TEXT,
    "context_chars" INTEGER NOT NULL,
    "context_truncated" BOOLEAN NOT NULL DEFAULT false,
    -- Lifetime generation counter; the action refuses past the throttle cap.
    "generations" INTEGER NOT NULL DEFAULT 1,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "generated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "meeting_prep_pkey" PRIMARY KEY ("id")
);

-- One brief per appointment; this unique also serves the by-key lookup.
CREATE UNIQUE INDEX "meeting_prep_appointment_key_key"
  ON "app"."meeting_prep"("appointment_key");
CREATE INDEX "meeting_prep_starts_at_idx" ON "app"."meeting_prep"("starts_at");
CREATE INDEX "meeting_prep_client_sf_id_idx" ON "app"."meeting_prep"("client_sf_id");

-- Grants: app_rw reads + inserts + updates (Regenerate UPSERTs in place); never
-- hard-deletes. No ingest_rw grant — nothing machine-written touches this table.
GRANT SELECT, INSERT, UPDATE ON "app"."meeting_prep" TO app_rw;
REVOKE DELETE ON "app"."meeting_prep" FROM app_rw;

-- RLS (FORCE binds the owner too — see the owner-bypass block below).
ALTER TABLE "app"."meeting_prep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."meeting_prep" FORCE ROW LEVEL SECURITY;

-- SELECT: the five NON-VIEWER roles only (ADR-3). A VIEWER still sees the
-- meeting row (mirror.appointment is all-roles) but never the generated brief.
CREATE POLICY meeting_prep_read_write_roles ON "app"."meeting_prep"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY meeting_prep_insert_write_roles ON "app"."meeting_prep"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY meeting_prep_update_write_roles ON "app"."meeting_prep"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

-- NO DELETE policy and no DELETE grant: briefs are UPSERTed in place by
-- Regenerate, never removed. Owner decision 2026-07-27: keep forever — there is
-- deliberately NO age-off job, NO TTL and NO cleanup sweep in this slice.

-- Owner-role bypass (the transfer_*_owner_all analogue): FORCE RLS binds the
-- table owner, so anything run as the owner via DIRECT_DATABASE_URL (migrations,
-- seeds) needs an unconditional policy. Local owner `aoa`, prod `aoa_admin`;
-- pg_roles-guarded so the migration applies in either environment.
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
      'CREATE POLICY meeting_prep_owner_all ON "app"."meeting_prep" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;
