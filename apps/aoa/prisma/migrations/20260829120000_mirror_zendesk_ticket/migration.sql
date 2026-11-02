-- Zendesk tickets mirrored into AOA. The initial description and PUBLIC
-- comments are retained for the authorized service-history view. Attachments,
-- private/internal notes, requester names, and requester email are excluded.
-- Email / cedar_ridge_user_id are transient ingest match inputs only.

CREATE TABLE mirror.zendesk_ticket (
  zendesk_ticket_id text PRIMARY KEY,
  requester_id      text NOT NULL,
  client_sf_id      text,
  household_sf_id   text,
  match_method      text NOT NULL CHECK (
    match_method IN ('CEDAR_RIDGE_USER_ID', 'EMAIL', 'UNMATCHED', 'AMBIGUOUS')
  ),
  subject           text,
  description       text,
  status            text NOT NULL,
  priority          text,
  ticket_type       text,
  ticket_url        text NOT NULL,
  created_at        timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  comments_truncated boolean NOT NULL DEFAULT false,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mirror.zendesk_ticket_comment (
  zendesk_comment_id text PRIMARY KEY,
  zendesk_ticket_id  text NOT NULL REFERENCES mirror.zendesk_ticket (zendesk_ticket_id),
  author_id          text NOT NULL,
  body               text NOT NULL,
  created_at         timestamptz NOT NULL,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zendesk_ticket_comment_ticket_idx
  ON mirror.zendesk_ticket_comment (zendesk_ticket_id, created_at);

CREATE INDEX zendesk_ticket_client_idx
  ON mirror.zendesk_ticket (client_sf_id, source_updated_at DESC);
CREATE INDEX zendesk_ticket_household_idx
  ON mirror.zendesk_ticket (household_sf_id, source_updated_at DESC);
CREATE INDEX zendesk_ticket_linkage_idx
  ON mirror.zendesk_ticket (match_method, source_updated_at DESC);

GRANT SELECT, INSERT, UPDATE ON mirror.zendesk_ticket TO ingest_rw;
GRANT SELECT ON mirror.zendesk_ticket TO app_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.zendesk_ticket_comment TO ingest_rw;
GRANT SELECT ON mirror.zendesk_ticket_comment TO app_rw;

-- The ingest transaction canonicalizes an exact match through confirmed AOA
-- duplicate decisions. These SECURITY DEFINER functions accept only source
-- keys and return source keys; granting EXECUTE does not expose app tables.
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_contact_source_key(text)
  TO ingest_rw;
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_household_source_key(text)
  TO ingest_rw;

ALTER TABLE mirror.zendesk_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.zendesk_ticket FORCE ROW LEVEL SECURITY;
ALTER TABLE mirror.zendesk_ticket_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.zendesk_ticket_comment FORCE ROW LEVEL SECURITY;

CREATE POLICY zendesk_ticket_ingest_all
  ON mirror.zendesk_ticket FOR ALL TO ingest_rw
  USING (true) WITH CHECK (true);
CREATE POLICY zendesk_ticket_comment_ingest_all
  ON mirror.zendesk_ticket_comment FOR ALL TO ingest_rw
  USING (true) WITH CHECK (true);

CREATE POLICY zendesk_ticket_ops_all
  ON mirror.zendesk_ticket FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true)
      IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
CREATE POLICY zendesk_ticket_comment_ops_all
  ON mirror.zendesk_ticket_comment FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true)
      IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );

CREATE POLICY zendesk_ticket_own_book
  ON mirror.zendesk_ticket FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND (
      EXISTS (
        SELECT 1 FROM mirror.household household
         WHERE household.sf_id = zendesk_ticket.household_sf_id
      )
      OR EXISTS (
        SELECT 1 FROM mirror.client client
         WHERE client.sf_id = zendesk_ticket.client_sf_id
      )
    )
  );
CREATE POLICY zendesk_ticket_comment_own_book
  ON mirror.zendesk_ticket_comment FOR SELECT TO app_rw
  USING (
    EXISTS (
      SELECT 1 FROM mirror.zendesk_ticket ticket
       WHERE ticket.zendesk_ticket_id =
             zendesk_ticket_comment.zendesk_ticket_id
    )
  );
