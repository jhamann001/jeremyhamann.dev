BEGIN;

-- The directory joins normalize Salesforce IDs to their stable 15-character
-- prefix. Exact-column indexes cannot serve those expressions, so add narrow,
-- non-PII expression indexes for the three high-frequency joins. These are
-- additive only and do not change grants, policies, or source data.
CREATE INDEX IF NOT EXISTS client_household_canonical_idx
  ON mirror.client (left(household_id, 15))
  WHERE household_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS client_account_aum_household_canonical_present_idx
  ON mirror.client_account_aum (left(household_sf_id, 15))
  WHERE source_present;

CREATE INDEX IF NOT EXISTS employee_client_status_client_canonical_idx
  ON app.employee_client_status (left(client_sf_id, 15));

COMMIT;
