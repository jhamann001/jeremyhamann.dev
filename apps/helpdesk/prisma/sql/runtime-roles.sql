-- Runtime database roles (operator-run as the OWNER after `prisma migrate deploy`).
-- Not a Prisma migration: roles and grants are environment state, not schema.
-- Amended by Wave B — the thirteen new tables are granted
-- explicitly in §2c and REVOKEd from the public role in §3; guardrails G17 and G18 pin both halves.
-- Amended by Wave A — the six new tables are granted explicitly,
-- the public (client-API) role is explicitly denied every one of them, and its read of "Ticket" is
-- narrowed from the whole table to the ten columns the client API actually projects (§3 below).
-- Amended by Decision #117 — the opening entry is read through the
-- "ClientVisibleOpeningMessage" view, which carries its gate in SQL, and the "Ticket" grant therefore
-- stays at those ten columns: `description`, `source` and `externalId` are REVOKEd, not granted.

-- 1. Roles (create-if-absent; passwords set out of band with ALTER ROLE … PASSWORD).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app')    THEN CREATE ROLE wm_helpdesk_app    LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN CREATE ROLE wm_helpdesk_public LOGIN; END IF;
END $$;
GRANT CONNECT ON DATABASE :"dbname" TO wm_helpdesk_app, wm_helpdesk_public;   -- run with -v dbname=<db>
GRANT USAGE ON SCHEMA public TO wm_helpdesk_app, wm_helpdesk_public;

-- 2. Runtime role: explicit per-table grants. Never GRANT ALL ON ALL TABLES (it would hand back UPDATE/DELETE on AuditLog).
GRANT SELECT, INSERT, UPDATE ON "User", "Ticket", "Comment", "Queue", "SLA", "Macro" TO wm_helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Account", "Session", "VerificationToken" TO wm_helpdesk_app;   -- Auth.js adapter contract
GRANT SELECT ON "_prisma_migrations" TO wm_helpdesk_app;
REVOKE ALL ON "AuditLog" FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "AuditLog" TO wm_helpdesk_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "Comment" FROM wm_helpdesk_app;   -- Comment is insert-only for the app (I8)
REVOKE DELETE, TRUNCATE ON "Ticket" FROM wm_helpdesk_app;
GRANT USAGE ON SEQUENCE audit_log_seq, "Ticket_number_seq" TO wm_helpdesk_app;
GRANT SELECT ON "ClientVisibleComment" TO wm_helpdesk_app;
-- Decision #117's view, granted to the app role for symmetry with the one above (neither is read by
-- the app path). SELECT only, and the REVOKE in front of it is load-bearing rather than decorative:
-- "ClientVisibleOpeningMessage" is a simple single-table view and therefore AUTO-UPDATABLE, while §4's
-- ALTER DEFAULT PRIVILEGES hands this role SELECT, INSERT, UPDATE on every relation the owner creates
-- — which would be a second, unmodelled write path into "Ticket".description.
REVOKE ALL ON "ClientVisibleOpeningMessage" FROM wm_helpdesk_app;
GRANT SELECT ON "ClientVisibleOpeningMessage" TO wm_helpdesk_app;

-- 2b. Wave A tables. Two are append-only ledgers (INSERT/SELECT only, like AuditLog); the rest are
--     state machines whose every transition is audited in the same transaction, so they need UPDATE —
--     but never DELETE or TRUNCATE (DB triggers refuse those for every role anyway).
REVOKE ALL ON "IngestReceipt" FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "IngestReceipt" TO wm_helpdesk_app;
REVOKE ALL ON "SlaAlert"      FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "SlaAlert"      TO wm_helpdesk_app;
GRANT SELECT, INSERT, UPDATE ON "SuspendedIntake", "MessageDelivery", "Attachment", "JobCursor" TO wm_helpdesk_app;
REVOKE DELETE, TRUNCATE ON "SuspendedIntake", "MessageDelivery", "Attachment" FROM wm_helpdesk_app;

-- 2c. Wave B tables. Four are append-only ledgers (INSERT/SELECT only,
--     like AuditLog); seven are state machines whose every transition is audited in the same
--     transaction, so they need UPDATE but never DELETE or TRUNCATE; and TWO are deliberately
--     DELETABLE, which is the whole of that list:
--       ComposerDraft    — an unsent draft is not a record. Nothing in it has been seen by a client,
--                          entered the ledger or left the desk, and "discard my draft" has to actually
--                          discard it. The SUBMITTED comment is the record, and it is immutable.
--       PushSubscription — a device-side artefact. The push service answers HTTP 410 Gone when a
--                          subscription dies, and pruning on 410 is the point; PUSH_SUBSCRIBED /
--                          PUSH_UNSUBSCRIBED are in the ledger either way.
REVOKE ALL ON "CommentRetraction"    FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "CommentRetraction"    TO wm_helpdesk_app;
REVOKE ALL ON "IdentityVerification" FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "IdentityVerification" TO wm_helpdesk_app;
REVOKE ALL ON "ReviewStamp"          FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "ReviewStamp"          TO wm_helpdesk_app;
REVOKE ALL ON "FollowUpNudge"        FROM wm_helpdesk_app;  GRANT SELECT, INSERT ON "FollowUpNudge"        TO wm_helpdesk_app;
GRANT SELECT, INSERT, UPDATE ON
  "Notification", "TicketFollower", "TicketLink", "WebhookEndpoint", "WebhookDelivery",
  "ClientApiToken", "RequesterSuppression" TO wm_helpdesk_app;
REVOKE DELETE, TRUNCATE ON
  "Notification", "TicketFollower", "TicketLink", "WebhookEndpoint", "WebhookDelivery",
  "ClientApiToken", "RequesterSuppression" FROM wm_helpdesk_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ComposerDraft", "PushSubscription" TO wm_helpdesk_app;
REVOKE TRUNCATE ON "ComposerDraft", "PushSubscription" FROM wm_helpdesk_app;
-- Demo only (NEXT_PUBLIC_DEMO_MODE=on): the Outbox the stand-ins write and the Outbox screen reads.
GRANT SELECT, INSERT ON "DemoOutboxMessage" TO wm_helpdesk_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "DemoOutboxMessage" FROM wm_helpdesk_app;

-- 3. Public (client-API) role: read TWO views whole, and ten named columns of "Ticket". Nothing else.
--    The REVOKEs below are not redundant with the default privileges: they are the assertion a reviewer
--    reads, and on a re-run they are what removes a wider grant an earlier version of this script left
--    behind (a column GRANT does not narrow an existing table-wide one, so the REVOKE must come first).
--    "Ticket" is column-scoped because Wave A widened the table with requester PII (requesterPhone),
--    identity pointers (householdId, requesterExternalId), compliance state (isComplaint,
--    complaintFiledAt, escalationTarget), routing (brand, source, linkedFromTicketId) and vendor keys
--    (externalRef, externalId) — none of which the client API reads. The column list is exactly the
--    projection of getClientTicketView (src/server/client-view.ts); guardrail G15 fails if the two
--    diverge, so a new "Ticket" column is opt-in for the client role the same way a new table is.
--    Both views are column-scoped by construction (that is what G16 defends), so each is granted whole.
--    "ClientVisibleComment" exposes authorKind (a three-value enum) but never authorId.
--    "ClientVisibleOpeningMessage" (Decision #117, shipped as a view by
--    prisma/migrations/20260920000400_client_visible_opening_message) is the OPENING ENTRY: the ticket's
--    own description, which on an emailed or client-app ticket is the client's OWN words, returned as
--    the first entry of the thread so a client no longer reads our replies without their own request.
--    It is granted INSTEAD OF the columns that feed it, and that is the whole point of this paragraph.
--    An earlier version of Decision #117 granted `description`, `source` and `externalId` on "Ticket"
--    and put the gate — REQUESTER_AUTHORED_SOURCES plus the released-held-mail marker — in
--    src/server/client-view.ts. That inverted the reason "ClientVisibleComment" exists: an INTERNAL
--    comment cannot leak through a coding mistake because the database will not return one, whereas a
--    mistake in an application-side allowlist COULD have returned a staff-composed description to the
--    client it was written about. The view carries both gates in its own WHERE, so for a ticket the desk
--    composed there is no row to return, to anybody, however the read path is written — and the three
--    columns are revoked below. The application-side allowlist is kept as a SECOND belt over the view's
--    own `source` column, not as the only one.
--    OPERATOR NOTE: NO HAND-RUN IS REQUIRED. scripts/migrate-deploy.sh step [2/3] applies this file as
--    the owner role inside the wm-helpdesk-migrate Cloud Run Job, and both pipelines run that job BEFORE
--    the new revision takes traffic (.github/workflows/deploy-{dev,prod}.yml; ci.yml does the same), so a
--    normal deploy carries these grants. The script cannot be run from a laptop or Cloud Shell anyway —
--    the instance is private-IP only. The ONE case that needs a manual re-run is a database that was
--    provisioned before this branch and is NOT redeployed through the pipeline, e.g. a hand-built local
--    wm_helpdesk_public; until it is re-run there, every read on /api/client/tickets/** fails with a
--    permission error on "ClientVisibleOpeningMessage". The REVOKE below is what narrows a database that
--    ran the previous version of this file, and it runs before the GRANT for exactly that reason.
REVOKE ALL ON "Ticket" FROM wm_helpdesk_public;
GRANT SELECT (id, number, subject, status, priority, category, "createdAt", "updatedAt", "resolvedAt", "requesterEmail")
  ON "Ticket" TO wm_helpdesk_public;
GRANT SELECT ON "ClientVisibleComment" TO wm_helpdesk_public;
GRANT SELECT ON "ClientVisibleOpeningMessage" TO wm_helpdesk_public;
REVOKE ALL ON "Comment", "AuditLog", "User", "Account", "Session", "VerificationToken", "Queue", "SLA", "Macro"
  FROM wm_helpdesk_public;
REVOKE ALL ON "IngestReceipt", "SuspendedIntake", "MessageDelivery", "Attachment", "SlaAlert", "JobCursor"
  FROM wm_helpdesk_public;
--    the same REVOKE over all thirteen new tables. None of them has a client-facing DTO by
--    design, and guardrail G17 fails if any is granted or any is left un-revoked. The retraction table
--    is on this list for a reason worth stating: the client path must be able to learn THAT a message
--    was withdrawn (the view's `retracted` boolean) and never WHY or BY WHOM, which is what
--    "CommentRetraction" holds.
REVOKE ALL ON
  "Notification", "TicketFollower", "ComposerDraft", "CommentRetraction", "TicketLink",
  "WebhookEndpoint", "WebhookDelivery", "PushSubscription", "ClientApiToken",
  "IdentityVerification", "ReviewStamp", "RequesterSuppression", "FollowUpNudge", "DemoOutboxMessage"
  FROM wm_helpdesk_public;

-- 4. Future tables/sequences created by the owner via migrations get the app defaults automatically.
--    AuditLog/Comment/Ticket already exist, so these defaults never widen them. The public role is
--    deliberately absent here: a new table is invisible to the client API until someone grants it by name.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO wm_helpdesk_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT USAGE ON SEQUENCES TO wm_helpdesk_app;
