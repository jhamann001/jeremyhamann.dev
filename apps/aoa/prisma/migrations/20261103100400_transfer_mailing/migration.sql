-- ATW-05 (ticket): paperwork mailings as a child record of app.transfer.
-- Additive only. Every app role reads, the transfer write roles insert and
-- update, nobody deletes.

CREATE TABLE app.transfer_mailing (
  id text NOT NULL,
  transfer_id text NOT NULL,
  reason text NOT NULL,
  contents text NOT NULL,
  journey text NOT NULL,
  postage numeric(10, 2),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT transfer_mailing_pkey PRIMARY KEY (id),
  CONSTRAINT transfer_mailing_journey_check CHECK (journey IN (
    'Cedar Ridge to the final destination',
    'Cedar Ridge to the client to the final destination',
    'Cedar Ridge to the client to Cedar Ridge to the final destination',
    'Cedar Ridge to the client'
  )),
  CONSTRAINT transfer_mailing_postage_check CHECK (postage IS NULL OR postage >= 0)
);
CREATE INDEX transfer_mailing_transfer_id_idx ON app.transfer_mailing (transfer_id);
ALTER TABLE app.transfer_mailing ADD CONSTRAINT transfer_mailing_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES app.transfer (id) ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON app.transfer_mailing TO app_rw;
REVOKE DELETE ON app.transfer_mailing FROM app_rw;

ALTER TABLE app.transfer_mailing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transfer_mailing FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_mailing_read_all_roles ON app.transfer_mailing
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_mailing_insert_write_roles ON app.transfer_mailing
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_mailing_update_write_roles ON app.transfer_mailing
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
