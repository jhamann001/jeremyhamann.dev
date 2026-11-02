-- Public demo: the Outbox under row security. A captured message can name a client (a closeout checklist carries the
-- whole transfer, a trade-request post the client's name), so each message now records what it is about, and a
-- persona reads only the messages about a household or client their own row security shows them: an advisor their
-- own book. Admin and operations read every message, including those about no single record (the trade-request
-- digest, drift alerts, a statement report filed to Drive). The app login still adds rows freely and never changes or
-- removes one; the owner, which the reset and the tests read with, is not subject to these policies.

ALTER TABLE demo.outbox_message
  ADD COLUMN household_sf_id     text CHECK (char_length(household_sf_id) BETWEEN 1 AND 64),
  ADD COLUMN client_sf_id        text CHECK (char_length(client_sf_id) BETWEEN 1 AND 64),
  -- The client's id across the firm's systems (mirror.client.cedar_ridge_user_id), as a trade request names it.
  ADD COLUMN cedar_ridge_user_id text CHECK (char_length(cedar_ridge_user_id) BETWEEN 1 AND 100);

ALTER TABLE demo.outbox_message ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_message_add ON demo.outbox_message FOR INSERT TO app_rw WITH CHECK (true);

CREATE POLICY outbox_message_staff_read ON demo.outbox_message FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
);

-- The subqueries run under the reader's own policies on mirror.household and mirror.client.
CREATE POLICY outbox_message_subject_read ON demo.outbox_message FOR SELECT TO app_rw USING (
  EXISTS (SELECT 1 FROM mirror.household h WHERE h.sf_id = outbox_message.household_sf_id)
  OR EXISTS (SELECT 1 FROM mirror.client c WHERE c.sf_id = outbox_message.client_sf_id)
  OR EXISTS (SELECT 1 FROM mirror.client c WHERE c.cedar_ridge_user_id = outbox_message.cedar_ridge_user_id)
);
