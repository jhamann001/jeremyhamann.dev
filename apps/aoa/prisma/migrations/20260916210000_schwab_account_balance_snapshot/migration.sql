-- Schwab S3 account-balance snapshot. This is deliberately separate from
-- mirror.client_account_aum: that table's completeness and authorization
-- contracts are Apex-specific and must never be retired by a Schwab run.

CREATE TABLE mirror.schwab_account_balance (
  account_id                    text PRIMARY KEY,
  account_number                text NOT NULL UNIQUE,
  account_number_last4          text NOT NULL,
  account_name                  text NOT NULL,
  client_sf_id                  text,
  household_sf_id               text,
  candidate_client_sf_id        text,
  candidate_household_sf_id     text,
  account_type                  text,
  registration_type             text,
  account_status                text NOT NULL DEFAULT 'OPEN',
  account_cash                  numeric(18,2) NOT NULL,
  account_securities            numeric(18,2) NOT NULL,
  account_aum                   numeric(18,2) NOT NULL,
  balance_as_of                 date NOT NULL,
  balance_current               boolean NOT NULL DEFAULT true,
  source_present                boolean NOT NULL DEFAULT true,
  resolution_method             text NOT NULL,
  resolution_state              text NOT NULL,
  source_key                    text NOT NULL,
  source_etag                   text,
  source_sha256                 text NOT NULL,
  snapshot_run_id               text NOT NULL,
  expected_snapshot_rows        integer NOT NULL,
  synced_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schwab_account_last4_check CHECK (
    length(account_number_last4) BETWEEN 1 AND 4
  ),
  CONSTRAINT schwab_account_name_check CHECK (
    length(trim(account_name)) BETWEEN 1 AND 256
  ),
  CONSTRAINT schwab_account_status_check CHECK (account_status IN ('OPEN', 'CLOSED')),
  CONSTRAINT schwab_account_balance_reconciles_check CHECK (
    abs(account_aum - account_cash - account_securities) <= 0.01
  ),
  CONSTRAINT schwab_account_current_requires_source_check CHECK (
    NOT balance_current OR source_present
  ),
  CONSTRAINT schwab_account_resolution_method_check CHECK (
    resolution_method IN (
      'CRM_ACCOUNT_NUMBER', 'EXACT_CLIENT_NAME', 'EXACT_HOUSEHOLD_NAME',
      'AMBIGUOUS_NAME', 'UNMATCHED'
    )
  ),
  CONSTRAINT schwab_account_resolution_state_check CHECK (
    resolution_state IN ('CONFIRMED', 'PROPOSED', 'REVIEW_REQUIRED', 'UNMATCHED')
  ),
  CONSTRAINT schwab_account_resolution_shape_check CHECK (
    (resolution_state = 'CONFIRMED' AND household_sf_id IS NOT NULL
      AND candidate_client_sf_id IS NULL AND candidate_household_sf_id IS NULL)
    OR
    (resolution_state = 'PROPOSED' AND client_sf_id IS NULL AND household_sf_id IS NULL
      AND candidate_household_sf_id IS NOT NULL)
    OR
    (resolution_state IN ('REVIEW_REQUIRED', 'UNMATCHED')
      AND client_sf_id IS NULL AND household_sf_id IS NULL
      AND candidate_client_sf_id IS NULL AND candidate_household_sf_id IS NULL)
  ),
  CONSTRAINT schwab_account_source_sha_check CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schwab_account_expected_rows_check CHECK (expected_snapshot_rows > 0)
);

CREATE INDEX schwab_account_balance_client_idx
  ON mirror.schwab_account_balance (client_sf_id)
  WHERE source_present;
CREATE INDEX schwab_account_balance_household_idx
  ON mirror.schwab_account_balance (household_sf_id)
  WHERE source_present;
CREATE INDEX schwab_account_balance_candidate_client_idx
  ON mirror.schwab_account_balance (candidate_client_sf_id)
  WHERE source_present AND resolution_state = 'PROPOSED';
CREATE INDEX schwab_account_balance_candidate_household_idx
  ON mirror.schwab_account_balance (candidate_household_sf_id)
  WHERE source_present AND resolution_state = 'PROPOSED';
CREATE INDEX schwab_account_balance_snapshot_idx
  ON mirror.schwab_account_balance (balance_as_of DESC, source_present);

GRANT USAGE ON SCHEMA mirror TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.schwab_account_balance TO ingest_rw;

-- app_rw deliberately has no access to the full account_number. UI seams use
-- account_id + fixed-mask last four only.
REVOKE SELECT ON mirror.schwab_account_balance FROM app_rw;
GRANT SELECT (
  account_id, account_number_last4, account_name, client_sf_id, household_sf_id,
  candidate_client_sf_id, candidate_household_sf_id, account_type,
  registration_type, account_status, account_cash, account_securities,
  account_aum, balance_as_of, balance_current, source_present,
  resolution_method, resolution_state, synced_at
) ON mirror.schwab_account_balance TO app_rw;

ALTER TABLE mirror.schwab_account_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.schwab_account_balance FORCE ROW LEVEL SECURITY;

CREATE POLICY schwab_account_balance_ingest_all
  ON mirror.schwab_account_balance FOR ALL TO ingest_rw
  USING (true) WITH CHECK (true);

CREATE POLICY schwab_account_balance_ops_all
  ON mirror.schwab_account_balance FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );

CREATE POLICY schwab_account_balance_own_book
  ON mirror.schwab_account_balance FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND resolution_state = 'CONFIRMED'
    AND EXISTS (
      SELECT 1
      FROM mirror.household household
      WHERE left(household.sf_id, 15) = left(schwab_account_balance.household_sf_id, 15)
    )
  );
