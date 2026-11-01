-- Migration: wave_b_constraints
-- Purpose: everything about the Wave B tables that Prisma's model cannot express —
--   1. CHECK constraints (void/merge consistency, link self-reference, bounded free text, the
--      MessageDelivery.subject check carried from Wave A)
--   2. append-only triggers + no-hard-delete triggers on the new tables, and the two deliberate
--      exceptions (ComposerDraft, PushSubscription) stated in SQL comments rather than assumed
--   3. the privilege floor for the new tables, including the explicit REVOKE from the public role
--   4. "ClientVisibleComment" rebuilt so a RETRACTED public comment's body is unreachable at the
--      DATABASE, not merely unrendered by the DTO
-- Everything here is deliberately outside Prisma's model so `prisma migrate dev` never drops it
-- (verified with `prisma migrate diff`: no drift is reported for these objects).
--
-- This file runs in its own transaction, AFTER 20260920000100. That is required, not stylistic:
-- PostgreSQL refuses to USE an enum value added by `ALTER TYPE … ADD VALUE` in the transaction that
-- added it, and the first CHECK below names 'VOIDED'.

-- ---------------------------------------------------------------------------
-- 1. CHECK constraints
-- ---------------------------------------------------------------------------

-- VOIDED is a three-column fact. A voided ticket always says who voided it, when, and
-- why; a live ticket never carries any of the three. Both directions, so neither a status flip with no
-- explanation nor an explanation with no status flip can be written.
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "ticket_void_fields_consistent";
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_void_fields_consistent"
  CHECK ((status = 'VOIDED' AND "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL)
      OR (status <> 'VOIDED' AND "voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL));

-- A ticket is never merged into itself, and `mergedAt` travels with `mergedIntoId`.
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "ticket_merged_into_not_self";
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_merged_into_not_self"
  CHECK ("mergedIntoId" IS NULL OR "mergedIntoId" <> "id");

ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "ticket_merged_fields_consistent";
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_merged_fields_consistent"
  CHECK (("mergedIntoId" IS NULL AND "mergedAt" IS NULL) OR ("mergedIntoId" IS NOT NULL AND "mergedAt" IS NOT NULL));

-- A link always joins two different tickets; the unique index handles the rest.
ALTER TABLE "TicketLink" DROP CONSTRAINT IF EXISTS "ticket_link_not_self";
ALTER TABLE "TicketLink" ADD CONSTRAINT "ticket_link_not_self"
  CHECK ("fromTicketId" <> "toTicketId");

-- A soft remove is who + when, together.
ALTER TABLE "TicketLink" DROP CONSTRAINT IF EXISTS "ticket_link_removal_consistent";
ALTER TABLE "TicketLink" ADD CONSTRAINT "ticket_link_removal_consistent"
  CHECK (("removedAt" IS NULL AND "removedById" IS NULL) OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL));

-- Nobody covers themselves while out of office — that is the one arrangement that guarantees the
-- reassignment job hands the work straight back.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "user_backup_not_self";
ALTER TABLE "User" ADD CONSTRAINT "user_backup_not_self"
  CHECK ("backupUserId" IS NULL OR "backupUserId" <> "id");

-- A retraction always states a reason, and it is a sentence rather than a keystroke. 12 characters is
-- the same floor `changeRequesterEmail` uses for the other privileged, recorded-reason action.
ALTER TABLE "CommentRetraction" DROP CONSTRAINT IF EXISTS "comment_retraction_reason_present";
ALTER TABLE "CommentRetraction" ADD CONSTRAINT "comment_retraction_reason_present"
  CHECK (char_length(btrim(reason)) >= 12 AND char_length(reason) <= 2000);

-- Same floor for a void. The ledger row and the column carry the same text.
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "ticket_void_reason_length";
ALTER TABLE "Ticket" ADD CONSTRAINT "ticket_void_reason_length"
  CHECK ("voidReason" IS NULL OR (char_length(btrim("voidReason")) >= 12 AND char_length("voidReason") <= 2000));

-- An identity verification always says how it was established.
ALTER TABLE "IdentityVerification" DROP CONSTRAINT IF EXISTS "identity_verification_note_present";
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "identity_verification_note_present"
  CHECK (char_length(btrim(note)) >= 8 AND char_length(note) <= 2000);

-- A FLAGGED review is a finding; a finding with no words is not reviewable. APPROVED may be silent.
ALTER TABLE "ReviewStamp" DROP CONSTRAINT IF EXISTS "review_stamp_flagged_has_note";
ALTER TABLE "ReviewStamp" ADD CONSTRAINT "review_stamp_flagged_has_note"
  CHECK (verdict <> 'FLAGGED' OR (note IS NOT NULL AND char_length(btrim(note)) >= 8));

-- The inbox preview is a one-line pointer, never a comment body.
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "notification_preview_bounded";
ALTER TABLE "Notification" ADD CONSTRAINT "notification_preview_bounded"
  CHECK (char_length(preview) <= 200);

-- A webhook endpoint is https, always. The SSRF guard does the rest in code (it has to: DNS moves).
ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "webhook_endpoint_https_only";
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "webhook_endpoint_https_only"
  CHECK (url ~ '^https://[^\s]{3,2000}$');

-- Secrets and tokens are stored as lower-case sha256 hex, never as plaintext. A column that can only
-- hold 64 hex characters cannot hold a bearer token by accident.
ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "webhook_endpoint_secret_is_sha256";
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "webhook_endpoint_secret_is_sha256"
  CHECK ("secretHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "ClientApiToken" DROP CONSTRAINT IF EXISTS "api_token_hash_is_sha256";
ALTER TABLE "ClientApiToken" ADD CONSTRAINT "api_token_hash_is_sha256"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- A token with no scope can do nothing; storing one is a configuration mistake, not a state.
ALTER TABLE "ClientApiToken" DROP CONSTRAINT IF EXISTS "api_token_has_a_scope";
ALTER TABLE "ClientApiToken" ADD CONSTRAINT "api_token_has_a_scope"
  CHECK (array_length(scopes, 1) >= 1);

ALTER TABLE "ClientApiToken" DROP CONSTRAINT IF EXISTS "api_token_prefix_shape";
ALTER TABLE "ClientApiToken" ADD CONSTRAINT "api_token_prefix_shape"
  CHECK (prefix ~ '^wmhd_[0-9a-z]{8}$');

-- Delivery attempts are bounded exactly like MessageDelivery's.
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT IF EXISTS "webhook_delivery_attempts_bounded";
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "webhook_delivery_attempts_bounded"
  CHECK (attempts >= 0 AND attempts <= 100);

ALTER TABLE "WebhookDelivery" DROP CONSTRAINT IF EXISTS "webhook_delivery_payload_hash_is_sha256";
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "webhook_delivery_payload_hash_is_sha256"
  CHECK ("payloadHash" ~ '^[0-9a-f]{64}$');

-- A suppression is one lower-cased address, and a removal is who + when together.
ALTER TABLE "RequesterSuppression" DROP CONSTRAINT IF EXISTS "suppression_email_lowercase";
ALTER TABLE "RequesterSuppression" ADD CONSTRAINT "suppression_email_lowercase"
  CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254);

ALTER TABLE "RequesterSuppression" DROP CONSTRAINT IF EXISTS "suppression_removal_consistent";
ALTER TABLE "RequesterSuppression" ADD CONSTRAINT "suppression_removal_consistent"
  CHECK (("removedAt" IS NULL AND "removedById" IS NULL) OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL));

-- The nudge dedupe key is a firm-local calendar DATE, stored as text so the unique index means what it
-- says whatever the container's zone is (src/lib/firm-time.ts).
ALTER TABLE "FollowUpNudge" DROP CONSTRAINT IF EXISTS "follow_up_nudge_due_on_is_a_date";
ALTER TABLE "FollowUpNudge" ADD CONSTRAINT "follow_up_nudge_due_on_is_a_date"
  CHECK ("dueOn" ~ '^\d{4}-\d{2}-\d{2}$');

-- The held-mail disposition columns move together, exactly like the release pair beside them.
ALTER TABLE "SuspendedIntake" DROP CONSTRAINT IF EXISTS "suspended_intake_discard_consistent";
ALTER TABLE "SuspendedIntake" ADD CONSTRAINT "suspended_intake_discard_consistent"
  CHECK (("discardedAt" IS NULL AND "discardedById" IS NULL) OR ("discardedAt" IS NOT NULL AND "discardedById" IS NOT NULL));

-- Carried from Wave A CONTRACT §14: an outbound subject is never empty and never unbounded. A blank
-- subject is a deliverability problem and an empty line in the client's mailbox.
ALTER TABLE "MessageDelivery" DROP CONSTRAINT IF EXISTS "message_delivery_subject_present";
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "message_delivery_subject_present"
  CHECK (char_length(btrim(subject)) >= 1 AND char_length(subject) <= 500);

-- ---------------------------------------------------------------------------
-- 2. Append-only ledgers and no-hard-delete state tables.
--    `raise_append_only()` is created by 20260916000100_audit_immutability.
--
--    APPEND-ONLY (BEFORE UPDATE OR DELETE): a row here is a statement about a moment, so a correction
--    is a NEW row. CommentRetraction, IdentityVerification, ReviewStamp, FollowUpNudge.
--
--    NO HARD DELETE (BEFORE DELETE): a state machine whose every transition is audited in the same
--    transaction. Notification, TicketFollower, TicketLink, WebhookEndpoint, WebhookDelivery,
--    ClientApiToken, RequesterSuppression.
--
--    DELIBERATELY UNGUARDED, and this is the whole list:
--      ComposerDraft    — an unsent draft is not a record. Nothing here has been seen by a client, has
--                         entered the ledger or has left the desk; "discard my draft" must actually
--                         discard it, and a soft-deleted draft table would accumulate half-written
--                         client correspondence nobody is accountable for. The SUBMITTED comment is
--                         the record, and it is immutable.
--      PushSubscription — a device-side artefact. The push service answers HTTP 410 Gone when a
--                         subscription dies; keeping a row we may never use again, and must not keep
--                         retrying, would be a liability rather than evidence. Pruning on 410 is the
--                         point, and PUSH_SUBSCRIBED / PUSH_UNSUBSCRIBED are in the ledger either way.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS comment_retraction_no_update_delete ON "CommentRetraction";
CREATE TRIGGER comment_retraction_no_update_delete
  BEFORE UPDATE OR DELETE ON "CommentRetraction"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS comment_retraction_no_truncate ON "CommentRetraction";
CREATE TRIGGER comment_retraction_no_truncate
  BEFORE TRUNCATE ON "CommentRetraction"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS identity_verification_no_update_delete ON "IdentityVerification";
CREATE TRIGGER identity_verification_no_update_delete
  BEFORE UPDATE OR DELETE ON "IdentityVerification"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS identity_verification_no_truncate ON "IdentityVerification";
CREATE TRIGGER identity_verification_no_truncate
  BEFORE TRUNCATE ON "IdentityVerification"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS review_stamp_no_update_delete ON "ReviewStamp";
CREATE TRIGGER review_stamp_no_update_delete
  BEFORE UPDATE OR DELETE ON "ReviewStamp"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS review_stamp_no_truncate ON "ReviewStamp";
CREATE TRIGGER review_stamp_no_truncate
  BEFORE TRUNCATE ON "ReviewStamp"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS follow_up_nudge_no_update_delete ON "FollowUpNudge";
CREATE TRIGGER follow_up_nudge_no_update_delete
  BEFORE UPDATE OR DELETE ON "FollowUpNudge"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS follow_up_nudge_no_truncate ON "FollowUpNudge";
CREATE TRIGGER follow_up_nudge_no_truncate
  BEFORE TRUNCATE ON "FollowUpNudge"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS notification_no_delete ON "Notification";
CREATE TRIGGER notification_no_delete
  BEFORE DELETE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS notification_no_truncate ON "Notification";
CREATE TRIGGER notification_no_truncate
  BEFORE TRUNCATE ON "Notification"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS ticket_follower_no_delete ON "TicketFollower";
CREATE TRIGGER ticket_follower_no_delete
  BEFORE DELETE ON "TicketFollower"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS ticket_follower_no_truncate ON "TicketFollower";
CREATE TRIGGER ticket_follower_no_truncate
  BEFORE TRUNCATE ON "TicketFollower"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS ticket_link_no_delete ON "TicketLink";
CREATE TRIGGER ticket_link_no_delete
  BEFORE DELETE ON "TicketLink"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS ticket_link_no_truncate ON "TicketLink";
CREATE TRIGGER ticket_link_no_truncate
  BEFORE TRUNCATE ON "TicketLink"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS webhook_endpoint_no_delete ON "WebhookEndpoint";
CREATE TRIGGER webhook_endpoint_no_delete
  BEFORE DELETE ON "WebhookEndpoint"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS webhook_endpoint_no_truncate ON "WebhookEndpoint";
CREATE TRIGGER webhook_endpoint_no_truncate
  BEFORE TRUNCATE ON "WebhookEndpoint"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS webhook_delivery_no_delete ON "WebhookDelivery";
CREATE TRIGGER webhook_delivery_no_delete
  BEFORE DELETE ON "WebhookDelivery"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS webhook_delivery_no_truncate ON "WebhookDelivery";
CREATE TRIGGER webhook_delivery_no_truncate
  BEFORE TRUNCATE ON "WebhookDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS client_api_token_no_delete ON "ClientApiToken";
CREATE TRIGGER client_api_token_no_delete
  BEFORE DELETE ON "ClientApiToken"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS client_api_token_no_truncate ON "ClientApiToken";
CREATE TRIGGER client_api_token_no_truncate
  BEFORE TRUNCATE ON "ClientApiToken"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

DROP TRIGGER IF EXISTS requester_suppression_no_delete ON "RequesterSuppression";
CREATE TRIGGER requester_suppression_no_delete
  BEFORE DELETE ON "RequesterSuppression"
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
DROP TRIGGER IF EXISTS requester_suppression_no_truncate ON "RequesterSuppression";
CREATE TRIGGER requester_suppression_no_truncate
  BEFORE TRUNCATE ON "RequesterSuppression"
  FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only();

-- ---------------------------------------------------------------------------
-- 3. Privilege floor. PUBLIC never mutates a ledger; the public (client-API) role never SEES any of
--    the new tables. The complete grant set lives in prisma/sql/runtime-roles.sql, which the operator
--    runs as the owner after `prisma migrate deploy`; this block is the floor.
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON "CommentRetraction" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "IdentityVerification" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "ReviewStamp" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "FollowUpNudge" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "Notification" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "TicketFollower" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "TicketLink" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "WebhookEndpoint" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "WebhookDelivery" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "ClientApiToken" FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON "RequesterSuppression" FROM PUBLIC;
REVOKE TRUNCATE ON "ComposerDraft" FROM PUBLIC;
REVOKE TRUNCATE ON "PushSubscription" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app') THEN
    REVOKE ALL ON "CommentRetraction" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "CommentRetraction" TO wm_helpdesk_app;
    REVOKE ALL ON "IdentityVerification" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "IdentityVerification" TO wm_helpdesk_app;
    REVOKE ALL ON "ReviewStamp" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "ReviewStamp" TO wm_helpdesk_app;
    REVOKE ALL ON "FollowUpNudge" FROM wm_helpdesk_app;
    GRANT SELECT, INSERT ON "FollowUpNudge" TO wm_helpdesk_app;
    GRANT SELECT, INSERT, UPDATE ON
      "Notification", "TicketFollower", "TicketLink", "WebhookEndpoint", "WebhookDelivery",
      "ClientApiToken", "RequesterSuppression" TO wm_helpdesk_app;
    REVOKE DELETE, TRUNCATE ON
      "Notification", "TicketFollower", "TicketLink", "WebhookEndpoint", "WebhookDelivery",
      "ClientApiToken", "RequesterSuppression" FROM wm_helpdesk_app;
    -- The two deliberate exceptions. DELETE is granted because the feature IS the delete.
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ComposerDraft", "PushSubscription" TO wm_helpdesk_app;
    REVOKE TRUNCATE ON "ComposerDraft", "PushSubscription" FROM wm_helpdesk_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN
    -- The client-facing role reads named "Ticket" COLUMNS and "ClientVisibleComment", nothing else, ever.
    REVOKE ALL ON
      "Notification", "TicketFollower", "ComposerDraft", "CommentRetraction", "TicketLink",
      "WebhookEndpoint", "WebhookDelivery", "PushSubscription", "ClientApiToken",
      "IdentityVerification", "ReviewStamp", "RequesterSuppression", "FollowUpNudge"
      FROM wm_helpdesk_public;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. "ClientVisibleComment" — rebuilt for retraction.
--
--    Still WHERE visibility = 'PUBLIC'. Still no `visibility`, no `authorId`, no `macroId`, no PII
--    columns. It gains ONE column, `retracted` (a boolean), and changes ONE: `body` is replaced by the
--    empty string for a retracted comment.
--
--    Blanking the body HERE rather than in the DTO is the point. `wm_helpdesk_public` is SELECT-only
--    on this view and holds no privilege on "Comment" or on "CommentRetraction", so after a retraction
--    the withdrawn text is not merely unrendered — it is unreachable by the client path at the
--    privilege layer, which is the same argument I1 already makes about internal notes. The join is to
--    a table that holds no message text of its own (a commentId, a reason and who retracted), so it
--    cannot widen what the view exposes; guardrail G16 pins that it is the ONLY join and that the body
--    expression is exactly this CASE.
--
--    `src/server/client-view.ts` maps `retracted` to the fixed placeholder string in
--    `CLIENT_RETRACTED_BODY` and never renders the stored body for such a row; the boolean does reach
--    the DTO (as `retracted`), because a client who was sent a message and then sees it disappear is
--    owed the fact that it was withdrawn, and the fact carries no content.
--
--    CREATE OR REPLACE cannot add a column to an existing view, so the view is dropped and recreated;
--    the grants are re-issued below because DROP VIEW drops its privileges with it.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS "ClientVisibleComment";
CREATE VIEW "ClientVisibleComment" AS
  SELECT c.id,
         c."ticketId",
         CASE WHEN r."commentId" IS NULL THEN c.body ELSE '' END AS body,
         c."disclaimerKey",
         c."authorKind",
         c."createdAt",
         (r."commentId" IS NOT NULL) AS retracted
  FROM "Comment" c
  LEFT JOIN "CommentRetraction" r ON r."commentId" = c.id
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
