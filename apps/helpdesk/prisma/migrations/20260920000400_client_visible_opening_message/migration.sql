-- ---------------------------------------------------------------------------
-- Migration: client_visible_opening_message
--
-- Purpose: move the OPENING ENTRY's gate out of application code and into the
-- privilege layer, where the rest of I1 already lives.
--
-- What shipped first, and why it was the wrong shape. The client API returns a ticket's opening
-- message as the first entry of the thread, synthesised from `Ticket.description`. To read that
-- column through `publicDb` the SELECT-only role's `"Ticket"` grant was widened from ten columns to
-- thirteen (`description`, `source`, `externalId`), and the two gates that decide WHOSE words the
-- description is — the `REQUESTER_AUTHORED_SOURCES` allowlist and the released-held-mail marker —
-- were enforced in `src/server/client-view.ts`. That inverts the reason "ClientVisibleComment"
-- exists: an INTERNAL comment cannot leak through a coding mistake because the DATABASE will not
-- return one, whereas a mistake in an application-side allowlist could return a staff-composed
-- description to the client it was written about.
--
-- This view is the same construction applied to the same problem. It carries both gates in its own
-- WHERE, so for a ticket the desk composed there is no row to return, to anybody, however the read
-- path is written. With it in place `prisma/sql/runtime-roles.sql` REVOKEs `description`, `source`
-- and `externalId` from `wm_helpdesk_public` and grants this view instead — the client role goes
-- back to the ten `"Ticket"` columns the DTO projects.
--
-- Outside Prisma's model, exactly like "ClientVisibleComment": `prisma migrate dev` does not drop a
-- view it does not model (verified on Prisma 6.19.3 / Postgres 16 — `prisma migrate diff` reports no
-- drift for this migration), and `prisma/schema.prisma` is unchanged by it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. "ClientVisibleOpeningMessage" — the opening entry, gated at the database.
--
--    FOUR columns, and each one is here because the read needs it:
--      "ticketId"  the key the client read joins on, exactly as "ClientVisibleComment" does. It is
--                  `Ticket.id`, which the client role may already read and which the DTO omits.
--      source      NOT for the payload — `source` is in CLIENT_FORBIDDEN_KEYS and never reaches a
--                  client. It is the gate's own value, returned so `openingMessageFor` can re-check
--                  the allowlist on the row it was handed: two independent gates, either of which
--                  alone withholds the entry. It discloses nothing, because a row that exists here
--                  has already passed the WHERE — its `source` is always on the allowlist.
--      body        `Ticket.description`, named as what it becomes. The alias is deliberate: the view
--                  speaks the thread's vocabulary, and the client role never gets a column called
--                  `description` on any relation.
--      "createdAt" the ticket's, which is the opening entry's timestamp.
--
--    The DESK's truncation note is NOT stripped here. `BODY_TRUNCATION_NOTE` is a presentation rule
--    over text the client did write, it has to stay on the stored record, and putting a string
--    literal that must equal a TypeScript constant inside a view is a duplication with no safety
--    value — the gate is what belongs in SQL. `openingMessageFor` strips it, and drops a body that is
--    empty or whitespace, for the same reason: neither is a disclosure rule.
--
--    GATE 1 — the source allowlist. `REQUESTER_AUTHORED_SOURCES` (src/types/domain.ts) is EMAIL and
--    CLIENT_APP: the two channels whose `description` really is the requester's own words. On
--    STAFF_FORM, PHONE, VOICEMAIL, SLACK, SYSTEM, API and IMPORT the field is an operator's account
--    of the request — a transcript wrapped in desk metadata, an associate's note, an imported agent's
--    summary — and showing it back to the client as "You" is the I1 class the invariant names. The
--    literals below are compared against a `TicketSource` enum column, so a source that does not
--    exist fails at CREATE VIEW rather than silently matching nothing. A guardrail in
--    src/lib/guardrails.test.ts pins this list against the TypeScript allowlist in both directions.
--
--    GATE 2 — the released-held-mail marker. `releaseHeldIntake` creates a ticket with
--    `source: EMAIL` and a description the DESK composed: the stored preview PLUS the hold reason,
--    the internal mailbox, the Message-ID, the raw-message pointer, a "SENDER NOT VERIFIED"
--    instruction, the staff address that forwarded it and the reviewer's note. Source alone would
--    have handed all of that to a client as their own message. The gate keys on `externalId`, which
--    every released ticket already carries, so tickets ALREADY IN THIS DATABASE are covered — a gate
--    keyed on a new column or a new source would fix tomorrow's rows and leave history leaking.
--    `left(…, length(…)) <> …` is a prefix test with no pattern semantics: unlike LIKE, no character
--    of the marker can ever be read as a wildcard. It is the same test as JavaScript's
--    `startsWith(INTAKE_RELEASE_EXTERNAL_ID_PREFIX)`, and the literal is pinned against that constant
--    by the same guardrail.
--
--    Both gates fail SAFE in both directions: a row that merely looks like a release loses its
--    opening entry (no disclosure), and nothing can force its way INTO the view by dropping the
--    marker, because the source allowlist still has to pass.
--
--    No join, and it is worth saying why the view cannot widen: it reads ONE table and selects four
--    of its columns by name, so a column added to "Ticket" later — PII, a compliance flag, another
--    vendor key — is invisible here as well as ungranted. That is the same opt-in G15 gives the
--    column grant.
--
--    DROP + CREATE rather than CREATE OR REPLACE: the view does not exist yet, and the pair is what
--    makes a re-run of this file (on a database restored to an earlier point, say) idempotent. DROP
--    VIEW drops its privileges with it, which is why the grants are re-issued below.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS "ClientVisibleOpeningMessage";
CREATE VIEW "ClientVisibleOpeningMessage" AS
  SELECT t.id AS "ticketId",
         t.source,
         t.description AS body,
         t."createdAt"
  FROM "Ticket" t
  WHERE t.source IN ('EMAIL', 'CLIENT_APP')
    AND (t."externalId" IS NULL OR left(t."externalId", length('intake-release.')) <> 'intake-release.');

-- ---------------------------------------------------------------------------
-- 2. Grants. Same shape as "ClientVisibleComment" (20260920000200_wave_b_constraints §4): each role
--    is granted only if it exists, because the runtime roles are operator-provisioned environment
--    state and a database that has only had `prisma migrate deploy` run against it has neither.
--    SELECT only, to both. The complete privilege set — including the narrowed `"Ticket"` column
--    grant this view pays for — lives in prisma/sql/runtime-roles.sql, which
--    scripts/migrate-deploy.sh re-applies as the owner on every deploy.
--
--    The client role gets SELECT and nothing else, which matters more than usual here: this is a
--    simple single-table view and therefore AUTO-UPDATABLE in Postgres, so an INSERT/UPDATE
--    privilege on it would be a write path into "Ticket".description for a role that holds no
--    privilege on "Ticket" at all. `ALTER DEFAULT PRIVILEGES` in runtime-roles.sql deliberately names
--    only wm_helpdesk_app, so the client role gains nothing automatically from a new relation.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_app') THEN
    GRANT SELECT ON "ClientVisibleOpeningMessage" TO wm_helpdesk_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN
    GRANT SELECT ON "ClientVisibleOpeningMessage" TO wm_helpdesk_public;
  END IF;
END $$;
