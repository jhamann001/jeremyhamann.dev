-- ---------------------------------------------------------------------------
-- integration round 1.
--
-- Three DB-level items the thirteen slices found and could not fix themselves, because
-- `prisma/migrations/**` belongs to the foundation. Each is recorded in the slice's own integration
-- note; the note is named above the statement.
--
--   1. `webhook_endpoint_https_only` is an INVALID regular expression, so no `WebhookEndpoint` row
--      can be inserted at all (outbound-webhooks.md §1).
--   2. `api_token_has_a_scope` does not refuse a scope-less credential (client-api-mcp.md §3.1).
--   3. The reporting role cannot compute reopen rate, because it is denied the two audit VALUE
--      columns and a column grant cannot be conditioned on a row (reporting.md §3.2).
--
-- This migration adds NO table, NO trigger and NO Wave B model, so guardrails G16, G17 and G18 —
-- which all read `20260920000200_wave_b_constraints` by name — keep asserting exactly what they did.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. `WebhookEndpoint.url` — a CHECK that refused every row, including the valid ones.
--
--    `CHECK (url ~ '^https://[^\s]{3,2000}$')` was written to say two things at once: "https, and no
--    whitespace" and "at most about 2 KB". PostgreSQL caps a POSIX repetition bound at 255, so the
--    pattern is invalid. A CHECK's expression is not evaluated until a row exists, so the original
--    `ALTER TABLE` succeeded against the empty table and the defect only appears on the first INSERT:
--
--      ERROR:  invalid regular expression: invalid repetition count(s)   (SQLSTATE 2201B)
--
--    The two intentions are separated here rather than squeezed back into one bound: the regex checks
--    the SHAPE (scheme, at least three more non-whitespace characters, nothing but non-whitespace to
--    the end) inside the engine's limit, and `char_length` checks the LENGTH, which is what the 2000
--    was ever about. `{3,255}` plus the length cap is not a narrowing — the anchored `$` with a
--    `[^\s]` class already forbade whitespace anywhere, and the length ceiling is unchanged.
--
--    This is the shape guard only. It cannot be the SSRF control and is not meant to be: a hostname's
--    address can change after the row is written, which is why `src/lib/ssrf-guard.ts` runs at
--    creation AND again immediately before every send.
-- ---------------------------------------------------------------------------

ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT IF EXISTS "webhook_endpoint_https_only";
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "webhook_endpoint_https_only"
  CHECK (url ~ '^https://[^\s]{3,255}$' AND char_length(url) <= 2000);

-- ---------------------------------------------------------------------------
-- 2. `ClientApiToken.scopes` — a CHECK that checked nothing.
--
--    `CHECK (array_length(scopes, 1) >= 1)` reads as "a credential must be able to do at least one
--    thing". For an EMPTY array `array_length` returns NULL, not 0; the comparison is then NULL; and a
--    Postgres CHECK treats NULL as SATISFIED. So the one row the constraint existed to refuse was the
--    one row it let through. `coalesce(..., 0)` is the whole fix.
--
--    No PRODUCTION row has ever been written this way — `createApiToken`'s zod schema requires
--    `scopes.min(1)` and is the only write path. It matters because the constraint reads as a
--    guarantee it did not provide, which is worse than no constraint: a reviewer stops looking.
--
--    ADDED `NOT VALID`, THEN VALIDATED WHEN THE DATA ALLOWS. `NOT VALID` does not mean "not
--    enforced": PostgreSQL checks it on every INSERT and UPDATE from this statement onward. It only
--    skips the scan of rows that already exist. That distinction is the whole reason it is used here.
--
--    `wm_helpdesk_test` already holds two scope-less rows — the fixtures B8's integration test wrote
--    to PROVE the defect, on a database whose rows are permanent by design (the immutability triggers
--    and the no-hard-delete guard are the point of it). A plain `ADD CONSTRAINT` fails there with
--    23514 and the migration cannot be applied at all; deleting the evidence to make a migration run
--    is the wrong trade in a books-and-records system, and rewriting it quietly is worse.
--
--    So the constraint goes on unvalidated and is then validated in the same migration IF AND ONLY IF
--    the table is clean — which is every real environment, every fresh database and the CI-equivalent
--    throwaway. The only database left at `convalidated = false` is the one that holds the two proof
--    rows, and on that one the constraint still refuses every new scope-less row. Check with:
--
--      SELECT convalidated FROM pg_constraint WHERE conname = 'api_token_has_a_scope';
-- ---------------------------------------------------------------------------

ALTER TABLE "ClientApiToken" DROP CONSTRAINT IF EXISTS "api_token_has_a_scope";
ALTER TABLE "ClientApiToken" ADD CONSTRAINT "api_token_has_a_scope"
  CHECK (coalesce(array_length(scopes, 1), 0) >= 1) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ClientApiToken" WHERE coalesce(array_length(scopes, 1), 0) < 1) THEN
    ALTER TABLE "ClientApiToken" VALIDATE CONSTRAINT "api_token_has_a_scope";
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. `ReportingStatusChange` — the reopen-rate view for `wm_helpdesk_reporting`.
--
--    The reporting role is granted the ledger's metadata columns but NOT `oldValue` / `newValue`
--    (prisma/sql/reporting-role.sql §7). For `TICKET_STATUS_CHANGED` those two hold a pair of enum
--    values; for `TICKET_FIELD_CHANGED` they hold the old and new ticket SUBJECT — a client's words.
--    A column grant cannot be conditioned on the row's action, so the two travel together or not at
--    all, and "not at all" is the only answer compatible with a role that reads no client material.
--    The consequence was that the reopen-rate card could not run as that role.
--
--    A view can do what a grant cannot: filter by row FIRST, then expose the values.
--
--    The two `IN` lists are what make this safe, and they are the reason this is a view rather than a
--    widened grant. A row reaches the view only when BOTH values are `TicketStatus` members, so a
--    subject cannot appear here even if some future action reuses `fieldChanged = 'status'` with free
--    text on either side. The action filter is a second, independent narrowing rather than the only
--    one — belt and braces, in the order that matters: even if the action list is widened by mistake,
--    the value lists still hold.
--
--    `voidReason` and every other free-text column stay unreachable: this view selects six columns and
--    joins nothing.
--
--    The list is spelled out rather than cast to the enum type deliberately — `"oldValue"::"TicketStatus"`
--    would ERROR on the first non-member row instead of excluding it, which turns a filter into an
--    outage the first time an unrelated action writes `fieldChanged = 'status'`.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS "ReportingStatusChange";
CREATE VIEW "ReportingStatusChange" AS
  SELECT a.seq,
         a."occurredAt",
         a."ticketId",
         a."actorId",
         a."oldValue" AS from_status,
         a."newValue" AS to_status
  FROM "AuditLog" a
  WHERE a."fieldChanged" = 'status'
    AND a.action IN ('TICKET_STATUS_CHANGED', 'TICKET_REOPENED_BY_REQUESTER')
    AND a."oldValue" IN ('NEW', 'OPEN', 'PENDING_CLIENT', 'PENDING_INTERNAL', 'RESOLVED', 'CLOSED', 'VOIDED')
    AND a."newValue" IN ('NEW', 'OPEN', 'PENDING_CLIENT', 'PENDING_INTERNAL', 'RESOLVED', 'CLOSED', 'VOIDED');

-- The privilege floor for the new view, in the same all-or-nothing shape the Wave B constraints
-- migration uses: PUBLIC first (so an unmigrated cluster is still closed), then each role by name and
-- only if it exists, because roles are cluster state that a `prisma migrate deploy` does not create.
--
-- `wm_helpdesk_public` is REVOKEd explicitly. The client-API role has no business reading the ledger
-- in any shape, and "it was never granted" is an argument where this is an assertion (I1, G17's rule,
-- applied by hand because G17 scans the constraints migration rather than this one).
REVOKE ALL ON "ReportingStatusChange" FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_reporting') THEN
    GRANT SELECT ON "ReportingStatusChange" TO wm_helpdesk_reporting;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app') THEN
    GRANT SELECT ON "ReportingStatusChange" TO wm_helpdesk_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN
    REVOKE ALL ON "ReportingStatusChange" FROM wm_helpdesk_public;
  END IF;
END $$;
