-- ticket: the client's prior-custodian statement file and its statement
-- date, as child records of app.transfer. Additive only. Same role posture as
-- the transfer children: every app role reads, the write roles insert and
-- update, nobody deletes. The bytes follow the custodian fee-schedule
-- document pattern (bytea, sha256, size and type CHECKs). There is no
-- audit.log_row_change trigger: it records the full row, which would copy the
-- statement bytes into the audit log. The application audit records ids,
-- size, digest and review only.

CREATE TABLE app.transfer_statement_document (
  id text NOT NULL,
  transfer_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  content bytea NOT NULL,
  sha256 text NOT NULL,
  byte_size integer NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by text NOT NULL,
  CONSTRAINT transfer_statement_document_pkey PRIMARY KEY (id),
  CONSTRAINT transfer_statement_document_id_transfer_key UNIQUE (id, transfer_id),
  CONSTRAINT transfer_statement_document_content_type_check
    CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  CONSTRAINT transfer_statement_document_byte_size_check
    CHECK (byte_size > 0 AND byte_size <= 8388608 AND octet_length(content) = byte_size),
  CONSTRAINT transfer_statement_document_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT transfer_statement_document_filename_check
    CHECK (char_length(filename) BETWEEN 1 AND 200),
  CONSTRAINT transfer_statement_document_created_by_check CHECK (created_by <> '')
);
CREATE INDEX transfer_statement_document_transfer_id_idx
  ON app.transfer_statement_document (transfer_id);
ALTER TABLE app.transfer_statement_document
  ADD CONSTRAINT transfer_statement_document_transfer_id_fkey
  FOREIGN KEY (transfer_id) REFERENCES app.transfer (id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- A statement review may point at a stored file. Rows written before this
-- migration keep NULLs: they recorded acceptance only.
ALTER TABLE app.transfer_statement
  ADD COLUMN document_id text,
  ADD COLUMN statement_date date,
  ADD COLUMN review_status text;
ALTER TABLE app.transfer_statement
  ADD CONSTRAINT transfer_statement_review_status_check
    CHECK (review_status IS NULL OR review_status IN ('pending', 'accepted', 'replacement_needed')),
  ADD CONSTRAINT transfer_statement_review_accepted_check
    CHECK (review_status IS NULL OR (review_status = 'accepted') = accepted),
  ADD CONSTRAINT transfer_statement_document_fields_check
    CHECK ((document_id IS NULL) = (statement_date IS NULL) AND (document_id IS NULL) = (review_status IS NULL));
ALTER TABLE app.transfer_statement
  ADD CONSTRAINT transfer_statement_document_id_fkey
  FOREIGN KEY (document_id, transfer_id)
  REFERENCES app.transfer_statement_document (id, transfer_id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX transfer_statement_document_id_idx ON app.transfer_statement (document_id);

REVOKE ALL ON app.transfer_statement_document FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.transfer_statement_document TO app_rw;
REVOKE DELETE ON app.transfer_statement_document FROM app_rw;

ALTER TABLE app.transfer_statement_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transfer_statement_document FORCE ROW LEVEL SECURITY;

CREATE POLICY transfer_statement_document_read_all_roles ON app.transfer_statement_document
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
  );

CREATE POLICY transfer_statement_document_insert_write_roles ON app.transfer_statement_document
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );

CREATE POLICY transfer_statement_document_update_write_roles ON app.transfer_statement_document
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
  );
