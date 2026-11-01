-- Migration: wave_a_constraints (#62, #65)
-- Purpose: everything about the Wave A tables that Prisma's model cannot express —
--   1. CHECK constraints (requester contact present; STAFF comments have an author; object-key shape)
--   2. append-only triggers + REVOKE on the two new ledger tables (IngestReceipt, SlaAlert)
--   3. the privilege floor for the new tables, including the explicit REVOKE from the public role
--   4. the "ClientVisibleComment" view rebuilt to expose authorKind (never authorId) so the client
--      path can render a requester's own message as "You"
-- Everything here is deliberately outside Prisma's model so `prisma migrate dev` never drops it
-- (verified with `prisma migrate diff`: no drift is reported for these objects).

-- ---------------------------------------------------------------------------
-- 1. CHECK constraints
-- ---------------------------------------------------------------------------

-- a ticket must be reachable. Email OR phone, at least one, always.
-- Existing rows all carry an email, so the constraint is satisfied at creation time.
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "ticket_requester_contact_present";
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_requester_contact_present"
  CHECK ("requesterEmail" IS NOT NULL OR "requesterPhone" IS NOT NULL);

-- A follow-up ticket never points at itself.
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "ticket_linked_from_not_self";
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_linked_from_not_self"
  CHECK ("linkedFromTicketId" IS NULL OR "linkedFromTicketId" <> "id");

-- STAFF authorship is attributable by construction. REQUESTER and SYSTEM rows carry no
-- authorId — the requester is not a User, and a job is not a person.
ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "comment_staff_has_author";
ALTER TABLE "Comment" ADD CONSTRAINT "comment_staff_has_author"
  CHECK (("authorKind" = 'STAFF' AND "authorId" IS NOT NULL)
      OR ("authorKind" <> 'STAFF' AND "authorId" IS NULL));

-- Object keys are derived (`<ticketId>/<attachmentId>`), never the uploaded filename: no path
-- traversal, no leading slash, no "..", exactly one separator.
ALTER TABLE "Attachment" DROP CONSTRAINT IF EXISTS "attachment_object_key_shape";
ALTER TABLE "Attachment" ADD CONSTRAINT "attachment_object_key_shape"
  CHECK ("objectKey" ~ '^[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}$');

ALTER TABLE "Attachment" DROP CONSTRAINT IF EXISTS "attachment_size_non_negative";
ALTER TABLE "Attachment" ADD CONSTRAINT "attachment_size_non_negative"
  CHECK ("size" >= 0 AND "size" <= 26214400);

-- A delivery's attempt counter never runs away; the sender gives up at MESSAGE_MAX_ATTEMPTS (5).
ALTER TABLE "MessageDelivery" DROP CONSTRAINT IF EXISTS "message_delivery_attempts_bounded";
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "message_delivery_attempts_bounded"
  CHECK ("attempts" >= 0 AND "attempts" <= 100);

-- ---------------------------------------------------------------------------
-- 2. Append-only ledgers: IngestReceipt and SlaAlert
--    Both are evidence of "we already handled this", so a correction is a NEW row, never an edit.
--    `raise_append_only()` is created by 20260916000100_audit_immutability.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS ingest_receipt_no_update_delete ON "IngestReceipt";
CREATE TRIGGER ingest_receipt_no_update_delete
  BEFORE UPDATE OR DELETE ON "IngestReceipt"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS ingest_receipt_no_truncate ON "IngestReceipt";
CREATE TRIGGER ingest_receipt_no_truncate
  BEFORE TRUNCATE ON "IngestReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS sla_alert_no_update_delete ON "SlaAlert";
CREATE TRIGGER sla_alert_no_update_delete
  BEFORE UPDATE OR DELETE ON "SlaAlert"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS sla_alert_no_truncate ON "SlaAlert";
CREATE TRIGGER sla_alert_no_truncate
  BEFORE TRUNCATE ON "SlaAlert"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- Attachment rows are never hard-deleted either: "remove" is a state change (ATTACHMENT_REMOVED).
DROP TRIGGER IF EXISTS attachment_no_delete ON "Attachment";
CREATE TRIGGER attachment_no_delete
  BEFORE DELETE ON "Attachment"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS attachment_no_truncate ON "Attachment";
CREATE TRIGGER attachment_no_truncate
  BEFORE TRUNCATE ON "Attachment"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- A queued outbound message is the record of what the firm sent: it is never deleted, only transitioned.
DROP TRIGGER IF EXISTS message_delivery_no_delete ON "MessageDelivery";
CREATE TRIGGER message_delivery_no_delete
  BEFORE DELETE ON "MessageDelivery"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS message_delivery_no_truncate ON "MessageDelivery";
CREATE TRIGGER message_delivery_no_truncate
  BEFORE TRUNCATE ON "MessageDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- A held inbound message is the record of what the firm received and did not act on.
DROP TRIGGER IF EXISTS suspended_intake_no_delete ON "SuspendedIntake";
CREATE TRIGGER suspended_intake_no_delete
  BEFORE DELETE ON "SuspendedIntake"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS suspended_intake_no_truncate ON "SuspendedIntake";
CREATE TRIGGER suspended_intake_no_truncate
  BEFORE TRUNCATE ON "SuspendedIntake"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- ---------------------------------------------------------------------------
-- 3. Privilege floor. PUBLIC never mutates a ledger; the public (client-API) role never SEES any of
--    the new tables. The complete grant set lives in prisma/sql/runtime-roles.sql, which the operator
--    runs as the owner after `prisma migrate deploy`; this block is the floor.
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON "IngestReceipt" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "SlaAlert" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "Attachment" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "MessageDelivery" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "SuspendedIntake" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app') THEN
    REVOKE ALL ON "IngestReceipt" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "IngestReceipt" TO wm_helpdesk_app;
    REVOKE ALL ON "SlaAlert" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "SlaAlert" TO wm_helpdesk_app;
    GRANT SELECT, INSERT, UPDATE ON "SuspendedIntake", "MessageDelivery", "Attachment", "JobCursor" TO wm_helpdesk_app;
    REVOKE DELETE, TRUNCATE ON "SuspendedIntake", "MessageDelivery", "Attachment" FROM wm_helpdesk_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN
    -- The client-facing role reads "Ticket" and "ClientVisibleComment" and nothing else, ever.
    REVOKE ALL ON "IngestReceipt", "SuspendedIntake", "MessageDelivery", "Attachment", "SlaAlert", "JobCursor"
      FROM wm_helpdesk_public;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. "ClientVisibleComment" — rebuilt for requester-authored messages.
--    Still WHERE visibility = 'PUBLIC'. Still no `visibility` column and NO `authorId`. It now also
--    exposes `authorKind`, which is a THREE-VALUE ENUM, not an identity: the client path maps
--    REQUESTER -> "You" and everything else -> "Your Service Team". A staff member's name, email and
--    id remain structurally unreachable from this view.
--    CREATE OR REPLACE cannot add a column to an existing view, so the view is dropped and recreated;
--    the grant is re-issued below because DROP VIEW drops its privileges with it.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS "ClientVisibleComment";
CREATE VIEW "ClientVisibleComment" AS
  SELECT c.id, c."ticketId", c.body, c."disclaimerKey", c."authorKind", c."createdAt"
  FROM "Comment" c
  WHERE c.visibility = 'PUBLIC';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app') THEN
    GRANT SELECT ON "ClientVisibleComment" TO wm_helpdesk_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN
    GRANT SELECT ON "ClientVisibleComment" TO wm_helpdesk_public;
  END IF;
END $$;
