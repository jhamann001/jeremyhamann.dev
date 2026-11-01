-- Migration: audit_immutability
-- Purpose: make AuditLog append-only and tamper-evident at the database layer; make Comment
-- immutable; forbid hard-deleting Ticket; expose the client-visible comment view.
-- Everything here is deliberately outside Prisma's model so `prisma migrate dev` never drops it
-- (verified on Prisma 6.19.3 / Postgres 16: `prisma migrate diff` reports no drift for the
-- standalone sequence, the view, or the triggers).

-- 1. Dedicated, trigger-owned sequence for AuditLog.seq (Prisma inserts DEFAULT 0; trigger overwrites).
CREATE SEQUENCE IF NOT EXISTS audit_log_seq AS BIGINT START WITH 1 INCREMENT BY 1;

-- 2. Hash-chain on insert. Serialized with a transaction-scoped advisory lock so seq order == chain order.
--    NOTE: "occurredAt" is timestamp(3) without time zone holding UTC wall time (Prisma convention).
--    Format it verbatim — do NOT apply AT TIME ZONE, which would shift it by the session offset.
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev TEXT;
  payload TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('AuditLog.chain'));
  NEW.seq := nextval('audit_log_seq');
  IF NEW."occurredAt" IS NULL THEN NEW."occurredAt" := (now() AT TIME ZONE 'UTC'); END IF;
  SELECT a.hash INTO prev FROM "AuditLog" a ORDER BY a.seq DESC LIMIT 1;
  NEW."prevHash" := COALESCE(prev, 'GENESIS');
  payload := NEW."prevHash"
    || E'\x1f' || NEW.seq::text
    || E'\x1f' || to_char(NEW."occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    || E'\x1f' || COALESCE(NEW."actorId", '')
    || E'\x1f' || NEW."actorEmail"
    || E'\x1f' || NEW.action::text
    || E'\x1f' || NEW."entityType"::text
    || E'\x1f' || COALESCE(NEW."entityId", '')
    || E'\x1f' || COALESCE(NEW."ticketId", '')
    || E'\x1f' || COALESCE(NEW."fieldChanged", '')
    || E'\x1f' || COALESCE(NEW."oldValue", '')
    || E'\x1f' || COALESCE(NEW."newValue", '')
    || E'\x1f' || NEW."ipAddress"
    || E'\x1f' || NEW."requestId"
    || E'\x1f' || COALESCE(array_to_string(NEW."actorGroups", ','), '')
    || E'\x1f' || COALESCE(NEW."userAgent", '');
  NEW.hash := encode(sha256(convert_to(payload, 'UTF8')), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_log_chain_trg ON "AuditLog";
CREATE TRIGGER audit_log_chain_trg
  BEFORE INSERT ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- 3. Immutability: any UPDATE / DELETE / TRUNCATE raises, regardless of role.
CREATE OR REPLACE FUNCTION raise_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = format('%s is append-only: %s is forbidden (books-and-records control)', TG_TABLE_NAME, TG_OP),
    HINT = 'Corrections are recorded as new rows; the original row is never altered.';
END $$;

DROP TRIGGER IF EXISTS audit_log_no_update_delete ON "AuditLog";
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON "AuditLog";
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- Comment rows are client communications / internal notes of record: immutable too.
DROP TRIGGER IF EXISTS comment_no_update_delete ON "Comment";
CREATE TRIGGER comment_no_update_delete
  BEFORE UPDATE OR DELETE ON "Comment"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS comment_no_truncate ON "Comment";
CREATE TRIGGER comment_no_truncate
  BEFORE TRUNCATE ON "Comment"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- Tickets are never hard-deleted (status CLOSED is the terminal state).
DROP TRIGGER IF EXISTS ticket_no_delete ON "Ticket";
CREATE TRIGGER ticket_no_delete
  BEFORE DELETE ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS ticket_no_truncate ON "Ticket";
CREATE TRIGGER ticket_no_truncate
  BEFORE TRUNCATE ON "Ticket"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- 4. Privilege floor. PUBLIC never gets mutation rights on the ledger; the runtime role, if present,
--    gets INSERT/SELECT only. This block is a floor, not the full grant set: the complete runtime
--    privileges (every table, both sequences, default privileges) live in prisma/sql/runtime-roles.sql,
--    which the operator runs as the owner after `prisma migrate deploy`.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "Comment" FROM PUBLIC;

-- 5. Structural isolation of internal notes: the client-facing read path selects from this view only.
CREATE OR REPLACE VIEW "ClientVisibleComment" AS
  SELECT c.id, c."ticketId", c.body, c."disclaimerKey", c."createdAt"
  FROM "Comment" c
  WHERE c.visibility = 'PUBLIC';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app') THEN
    REVOKE ALL ON "AuditLog" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "AuditLog" TO wm_helpdesk_app;
    GRANT USAGE ON SEQUENCE audit_log_seq TO wm_helpdesk_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "Comment" FROM wm_helpdesk_app;
    REVOKE DELETE, TRUNCATE ON "Ticket" FROM wm_helpdesk_app;
    GRANT SELECT ON "ClientVisibleComment" TO wm_helpdesk_app;
  END IF;
END $$;
