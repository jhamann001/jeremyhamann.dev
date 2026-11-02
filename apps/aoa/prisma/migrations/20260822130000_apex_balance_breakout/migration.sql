-- AOA Phase 3A — complete Apex account snapshot with cash/securities/total.
--
-- The source is Warehouse card 6601.  It now publishes the full current account
-- master (OPEN and CLOSED) together with the latest Apex balance snapshot.  The
-- mirror keeps omitted rows for auditability but marks them source_present=false;
-- current AUM readers therefore never sum a stale account.

ALTER TABLE mirror.client_account_aum
  ADD COLUMN account_cash numeric(14,2),
  ADD COLUMN account_securities numeric(14,2),
  ADD COLUMN balance_as_of date,
  ADD COLUMN source_snapshot_as_of date,
  -- Fail closed until the first complete Phase-3A snapshot commits. Legacy
  -- totals remain retained but cannot be mistaken for current balances.
  ADD COLUMN balance_current boolean NOT NULL DEFAULT false,
  ADD COLUMN source_present boolean NOT NULL DEFAULT true,
  ADD COLUMN close_date date,
  ADD COLUMN close_date_source text,
  ADD COLUMN snapshot_run_id text,
  ADD COLUMN expected_snapshot_rows integer,
  ADD COLUMN expected_current_accounts integer,
  ADD COLUMN expected_closed_accounts integer,
  ADD COLUMN expected_corporate_accounts integer;

-- Retain legacy source dates for evidence, but keep their current flag false
-- until the first complete Phase-3A snapshot replaces them. Cash/securities
-- remain unknown rather than being fabricated from total AUM.
UPDATE mirror.client_account_aum
SET balance_as_of = as_of::date,
    source_snapshot_as_of = as_of::date;

ALTER TABLE mirror.client_account_aum
  ADD CONSTRAINT client_account_aum_close_date_source_check
    CHECK (close_date_source IS NULL OR close_date_source IN ('APEX', 'PROVISIONAL_OVERRIDE')),
  ADD CONSTRAINT client_account_aum_balance_reconciles_check
    CHECK (
      account_aum IS NULL OR account_cash IS NULL OR account_securities IS NULL
      OR abs(account_aum - account_cash - account_securities) <= 0.01
    ),
  ADD CONSTRAINT client_account_aum_closed_date_pair_check
    CHECK (
      (close_date IS NULL AND close_date_source IS NULL)
      OR (close_date IS NOT NULL AND close_date_source IS NOT NULL)
    ),
  ADD CONSTRAINT client_account_aum_current_requires_source_check
    CHECK (NOT balance_current OR source_present),
  ADD CONSTRAINT client_account_aum_expectations_complete_check
    CHECK (
      (expected_snapshot_rows IS NULL AND expected_current_accounts IS NULL
       AND expected_closed_accounts IS NULL AND expected_corporate_accounts IS NULL)
      OR
      (expected_snapshot_rows IS NOT NULL AND expected_current_accounts IS NOT NULL
       AND expected_closed_accounts IS NOT NULL AND expected_corporate_accounts IS NOT NULL
       AND expected_snapshot_rows > 0 AND expected_current_accounts > 0
       AND expected_closed_accounts >= 0 AND expected_corporate_accounts > 0)
    );

CREATE INDEX client_account_aum_current_household_idx
  ON mirror.client_account_aum (household_sf_id)
  WHERE source_present AND balance_current;

-- Operational fallbacks are data, not UI conditionals. Only ingest_rw can see
-- or retire them. A later non-null Apex close date wins and permanently retires
-- the fallback in the same transaction as the authoritative snapshot.
CREATE TABLE app.account_close_date_override (
  custodian_account_id text PRIMARY KEY,
  provisional_close_date date NOT NULL,
  reason text NOT NULL,
  source_reference text NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  retired_at timestamptz,
  retired_by_snapshot_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(reason)) > 0),
  CHECK (length(trim(source_reference)) > 0),
  CHECK (length(trim(approved_by)) > 0),
  CHECK (
    (retired_at IS NULL AND retired_by_snapshot_run_id IS NULL)
    OR (retired_at IS NOT NULL AND retired_by_snapshot_run_id IS NOT NULL)
  )
);

INSERT INTO app.account_close_date_override
  (custodian_account_id, provisional_close_date, reason, source_reference,
   approved_by, approved_at)
VALUES
  ('01SYNTH91CNZDPTY5FVCZAQCB1', DATE '2026-04-14',
   'Operational close date: 90 days after the account-close request.',
   'Operations-approved close request dated 2026-01-14.',
   'owner', CURRENT_TIMESTAMP);

REVOKE ALL ON app.account_close_date_override FROM app_rw;
REVOKE ALL ON app.account_close_date_override FROM PUBLIC;
REVOKE ALL ON app.account_close_date_override FROM ingest_rw;
GRANT SELECT ON app.account_close_date_override TO ingest_rw;
GRANT UPDATE (retired_at, retired_by_snapshot_run_id)
  ON app.account_close_date_override TO ingest_rw;

ALTER TABLE app.account_close_date_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_close_date_override FORCE ROW LEVEL SECURITY;
CREATE POLICY account_close_date_override_ingest_select
  ON app.account_close_date_override
  FOR SELECT TO ingest_rw
  USING (true);
CREATE POLICY account_close_date_override_ingest_retire
  ON app.account_close_date_override
  FOR UPDATE TO ingest_rw
  USING (retired_at IS NULL)
  WITH CHECK (
    retired_at IS NOT NULL
    AND retired_by_snapshot_run_id IS NOT NULL
  );
