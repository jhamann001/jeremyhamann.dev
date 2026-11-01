-- Reporting database role.
-- Operator-run as the OWNER, after `prisma migrate deploy` and after prisma/sql/runtime-roles.sql.
-- Not a Prisma migration: roles and grants are environment state, not schema — the same rule
-- runtime-roles.sql states, and the reason this file creates no view, no table and no index.
--
-- WHAT THIS ROLE IS FOR. Warehouse (and anything else that wants to read the desk's numbers without
-- going through the app) connects as `wm_helpdesk_reporting` and runs the queries in
-- the build record. The app's own /reports page does NOT use this role; it runs as
-- `wm_helpdesk_app` through `src/server/reports.ts`, where the viewer's readable queues narrow every
-- statement. This role has no such narrowing and therefore reads every queue — that is the trade, and
-- it is why the column set is metadata only.
--
-- WHAT "METADATA ONLY" MEANS HERE, precisely:
--   * No client words. No `Ticket.subject`, no `Ticket.description`, no `Comment.body`, no
--     `Queue`-free-text nothing — the columns a client or an agent typed are unreachable, so a report
--     that joined the wrong way still cannot produce correspondence.
--   * No requester identifiers. `requesterName`, `requesterEmail`, `requesterPhone`, `householdId`,
--     `requesterExternalId`, `clientReference`, `externalRef` and `externalId` are all withheld. A
--     metric is about volume and timing; a name in a BI tool is a copy of the book of record in a
--     system with its own sharing model.
--   * No tables whose PURPOSE is content: `SuspendedIntake` (held inbound mail, subject and snippet),
--     `MessageDelivery` (the rendered outbound email), `Attachment`, `ComposerDraft`, `Notification`,
--     `CommentRetraction`, `IdentityVerification`, `WebhookEndpoint` (it holds a secret hash) and the
--     Auth.js tables are revoked outright.
--   * `AuditLog.oldValue` / `.newValue` are NOT granted, and that is deliberate rather than an
--     oversight: for a status change they hold two enum values, but for `TICKET_FIELD_CHANGED` they
--     hold the old and new SUBJECT. A column grant cannot be conditioned on a row, so the two travel
--     together or not at all, and "not at all" is the only answer compatible with the line above.
--     The consequence is stated in the build record: the reopen-rate card is the one metric this
--     role cannot compute, and the app's /reports page (which reads as `wm_helpdesk_app`) is where it
--     lived until a narrow `ReportingStatusChange` view existed. That view now does — it is created by
--     prisma/migrations/20260920000300_wave_b_integration_r1 and granted in §7b below — so this role
--     can compute reopen rate WITHOUT ever being able to read a subject.
--
-- Re-running this file is safe and is the intended way to apply a change: every REVOKE precedes its
-- GRANT, because a column-level GRANT does not narrow a table-wide one an earlier version left behind.
--
-- Usage:  psql -v dbname=wm_helpdesk -f prisma/sql/reporting-role.sql
--         ALTER ROLE wm_helpdesk_reporting PASSWORD '…';   -- out of band, never in this file

-- 1. The role. LOGIN, no inheritance of anything: it is a member of no group role, so it cannot pick
--    up the app role's INSERT/UPDATE by transitivity.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_reporting') THEN
    CREATE ROLE wm_helpdesk_reporting LOGIN NOINHERIT;
  END IF;
END $$;
GRANT CONNECT ON DATABASE :"dbname" TO wm_helpdesk_reporting;   -- run with -v dbname=<db>
GRANT USAGE ON SCHEMA public TO wm_helpdesk_reporting;

-- 2. Start from nothing. This is the assertion a reviewer reads, and on a re-run it is what removes a
--    wider grant an earlier version of this file (or a well-meaning hand) left behind.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wm_helpdesk_reporting;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM wm_helpdesk_reporting;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM wm_helpdesk_reporting;

-- 3. Tickets — the metadata spine of every report. Enumerated column by column; a new Ticket column is
--    opt-in for this role the same way it is for the client role (runtime-roles.sql §3).
GRANT SELECT (
  id, number, status, resolution, priority, category,
  "queueId", "assigneeId", "createdById",
  "createdAt", "updatedAt", "firstRespondedAt", "resolvedAt", "closedAt",
  "firstResponseDueAt", "resolutionDueAt", "slaFirstResponseMinutes", "slaResolutionMinutes",
  "isComplaint", "complaintFiledAt", "escalationTarget", "followUpAt",
  source, brand, "piiRedacted", "piiRedactionCount",
  "linkedFromTicketId", "mergedIntoId", "mergedAt", "voidedAt", "voidedById", version
) ON "Ticket" TO wm_helpdesk_reporting;

-- 4. Comments — shape only, never the words. Enough to count public replies, internal notes and who
--    wrote them; not enough to read one.
GRANT SELECT (
  id, "ticketId", "authorId", "authorKind", visibility, "disclaimerKey", "macroId",
  "piiRedacted", "piiRedactionCount", "createdAt"
) ON "Comment" TO wm_helpdesk_reporting;

-- 5. Configuration and staff directory. `Queue.description` and `Macro.title` are firm-authored
--    configuration rather than client material, so they are readable; `Macro.body` — the wording that
--    reaches a client — is not.
GRANT SELECT ON "Queue", "SLA" TO wm_helpdesk_reporting;
GRANT SELECT (id, key, title, "queueId", channel, "disclaimerKey", "isActive", "sortOrder",
              "createdAt", "updatedAt", "updatedById")
  ON "Macro" TO wm_helpdesk_reporting;
GRANT SELECT (id, name, email, groups, "isActive", "createdAt", "outOfOfficeUntil", "backupUserId")
  ON "User" TO wm_helpdesk_reporting;

-- 6. SLA alerts and webhook deliveries — operational counters with no content in them.
GRANT SELECT ON "SlaAlert" TO wm_helpdesk_reporting;
GRANT SELECT (id, "endpointId", "auditSeq", "eventAction", "ticketId", status, attempts,
              "responseStatus", "sentAt", "createdAt", "updatedAt")
  ON "WebhookDelivery" TO wm_helpdesk_reporting;

-- 7. The ledger, WITHOUT the two value columns (see the header).
GRANT SELECT (
  id, seq, "occurredAt", "actorId", "actorEmail", "actorGroups",
  action, "entityType", "entityId", "ticketId", "fieldChanged", "requestId"
) ON "AuditLog" TO wm_helpdesk_reporting;

-- 7b. Reopen rate, through the one view that can do what a column grant cannot: filter by ROW first.
--     `ReportingStatusChange` admits a row only when `fieldChanged = 'status'`, the action is one of
--     the two status-change actions, AND both values are `TicketStatus` members — so a subject can
--     never appear in it even if a future action reuses `fieldChanged = 'status'` with free text.
--     The underlying `AuditLog.oldValue` / `.newValue` columns stay ungranted in §7; this view is the
--     only path to them, which is the point.
GRANT SELECT ON "ReportingStatusChange" TO wm_helpdesk_reporting;

-- 8. Everything else, named so the refusal is visible rather than implied. A table that appears in
--    this list has been considered and excluded; a table that appears in neither list is caught by the
--    blanket REVOKE in §2 and by the default privileges in §9.
REVOKE ALL ON
  "SuspendedIntake", "MessageDelivery", "Attachment", "IngestReceipt", "JobCursor",
  "ComposerDraft", "Notification", "CommentRetraction", "TicketFollower", "TicketLink",
  "WebhookEndpoint", "PushSubscription", "ClientApiToken", "IdentityVerification",
  "ReviewStamp", "RequesterSuppression", "FollowUpNudge",
  "Account", "Session", "VerificationToken", "ClientVisibleComment", "ClientVisibleOpeningMessage"
  FROM wm_helpdesk_reporting;

-- 9. Future tables created by the owner are NOT readable by this role. New columns on the tables above
--    are not either: §3 to §7 grant by name, so widening a table is opt-in, which is the whole point.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM wm_helpdesk_reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM wm_helpdesk_reporting;

-- 10. Verification. Run after applying; the first should return only the tables named above, and the
--     second must return NO rows at all.
--
--   SELECT table_name, string_agg(DISTINCT privilege_type, ',') AS privs
--     FROM information_schema.table_privileges
--    WHERE grantee = 'wm_helpdesk_reporting' GROUP BY 1 ORDER BY 1;
--
--   SELECT table_name, column_name
--     FROM information_schema.column_privileges
--    WHERE grantee = 'wm_helpdesk_reporting'
--      AND (table_name, column_name) IN (
--            ('Ticket','subject'), ('Ticket','description'), ('Ticket','requesterEmail'),
--            ('Ticket','requesterName'), ('Ticket','requesterPhone'), ('Ticket','voidReason'),
--            ('Comment','body'), ('AuditLog','oldValue'), ('AuditLog','newValue'));
--
--   SELECT has_table_privilege('wm_helpdesk_reporting', 'Ticket', 'UPDATE');   -- must be false
--   SELECT has_table_privilege('wm_helpdesk_reporting', 'SuspendedIntake', 'SELECT'); -- must be false
