-- Up Migration

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_account_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_account_type_check
  CHECK (account_type IN ('Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'));

-- Down Migration

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_account_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_account_type_check
  CHECK (account_type IN ('Taxable', 'Traditional IRA', 'Roth IRA'));
