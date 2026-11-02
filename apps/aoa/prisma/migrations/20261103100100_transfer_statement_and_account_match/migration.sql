-- ATW-02 (ticket): statement acceptance and the delivering/receiving account
-- types, as child records of app.transfer. Additive only. Same read/write role
-- posture as the transfer children: every app role reads, the write roles
-- insert and update, nobody deletes.

CREATE TABLE app.transfer_statement (
  id text NOT NULL,
  transfer_id text NOT NULL,
  accepted boolean NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT transfer_statement_pkey PRIMARY KEY (id)
);
CREATE INDEX transfer_statement_transfer_id_idx ON app.transfer_statement (transfer_id);
ALTER TABLE app.transfer_statement ADD CONSTRAINT transfer_statement_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES app.transfer (id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE app.transfer_account_match (
  id text NOT NULL,
  transfer_id text NOT NULL,
  delivering_account_type text NOT NULL,
  receiving_account_type text NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL,
  CONSTRAINT transfer_account_match_pkey PRIMARY KEY (id)
);
CREATE INDEX transfer_account_match_transfer_id_idx ON app.transfer_account_match (transfer_id);
ALTER TABLE app.transfer_account_match ADD CONSTRAINT transfer_account_match_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES app.transfer (id) ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON app.transfer_statement TO app_rw;
REVOKE DELETE ON app.transfer_statement FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON app.transfer_account_match TO app_rw;
REVOKE DELETE ON app.transfer_account_match FROM app_rw;

ALTER TABLE app.transfer_statement ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transfer_statement FORCE ROW LEVEL SECURITY;
ALTER TABLE app.transfer_account_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transfer_account_match FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_statement_read_all_roles ON app.transfer_statement
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_statement_insert_write_roles ON app.transfer_statement
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_statement_update_write_roles ON app.transfer_statement
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_account_match_read_all_roles ON app.transfer_account_match
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_account_match_insert_write_roles ON app.transfer_account_match
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_account_match_update_write_roles ON app.transfer_account_match
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
