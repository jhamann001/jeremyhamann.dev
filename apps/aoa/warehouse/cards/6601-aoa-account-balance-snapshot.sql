-- Warehouse card 6601 — AOA Account Balance Snapshot
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This reviewed SQL must be applied to live card 6601 before the Phase-3A app
-- ingest is enabled. Editing this file does not change Warehouse.
--
-- OPEN accounts and the four corporate accounts carry one same-day Apex
-- balance row. CLOSED accounts remain in the account master with raw balance
-- fields (normally NULL) so the app can reject any unexpected nonzero balance
-- before displaying lifecycle $0, plus their authoritative account close_date.
-- The application owns the narrowly approved provisional close-date fallback.
-- sha256(normalized): 771b9e4eb625aff4b52dc92b18a2c53a623067f072a2d74f32a2266363c04de8

WITH latest AS (
  SELECT MAX(CAST(process_date AS date)) AS d
  FROM apex.apex_daily_overnight_balances
),
current_balances AS (
  SELECT
    account_id,
    CAST(process_date AS date) AS balance_as_of,
    cash_equity,
    position_market_value,
    total_equity
  FROM apex.apex_daily_overnight_balances
  WHERE CAST(process_date AS date) = (SELECT d FROM latest)
),
account_master AS (
  SELECT
    custodian_account_id,
    custodian_account_number,
    account_type,
    is_managed,
    account_status,
    close_date,
    user_id
  FROM views_for_reporting.apex_client_investments
),
source_expectations AS (
  SELECT
    (SELECT COUNT(*) FROM account_master) AS expected_master_accounts,
    (SELECT COUNT(*) FROM account_master WHERE account_status = 'OPEN') AS expected_open_accounts,
    (SELECT COUNT(*) FROM account_master WHERE account_status = 'CLOSED') AS expected_closed_accounts,
    (SELECT COUNT(*) FROM current_balances) AS expected_current_balance_rows,
    (
      SELECT COUNT(*)
      FROM current_balances ob
      LEFT JOIN account_master am ON am.custodian_account_id = ob.account_id
      WHERE am.custodian_account_id IS NULL
    ) AS expected_unmapped_balances
),
client_accounts AS (
  SELECT
    aci.custodian_account_id,
    aci.custodian_account_number AS apex_account_number,
    aci.account_type,
    CAST(aci.is_managed AS varchar) AS is_managed,
    aci.account_status,
    ob.cash_equity AS account_cash,
    ob.position_market_value AS account_securities,
    ob.total_equity AS account_aum,
    ob.balance_as_of,
    (SELECT d FROM latest) AS source_snapshot_as_of,
    ob.balance_as_of = (SELECT d FROM latest) AS balance_current,
    aci.close_date,
    pc.id AS client_sf_id,
    pc.accountid AS household_sf_id,
    'CLIENT'::varchar AS source_record_class
  FROM account_master aci
  LEFT JOIN current_balances ob
    ON ob.account_id = aci.custodian_account_id
  LEFT JOIN crm.crm_contacts pc
    ON CAST(pc.cedar_ridge_user_id__c AS varchar) = CAST(aci.user_id AS varchar)
),
unmapped_current_balances AS (
  SELECT
    ob.account_id AS custodian_account_id,
    NULL::varchar AS apex_account_number,
    NULL::varchar AS account_type,
    'false'::varchar AS is_managed,
    'OPEN'::varchar AS account_status,
    ob.cash_equity AS account_cash,
    ob.position_market_value AS account_securities,
    ob.total_equity AS account_aum,
    ob.balance_as_of,
    (SELECT d FROM latest) AS source_snapshot_as_of,
    true AS balance_current,
    NULL::date AS close_date,
    NULL::varchar AS client_sf_id,
    NULL::varchar AS household_sf_id,
    'UNMAPPED_BALANCE'::varchar AS source_record_class
  FROM current_balances ob
  LEFT JOIN account_master aci
    ON aci.custodian_account_id = ob.account_id
  WHERE aci.custodian_account_id IS NULL
)
SELECT
  custodian_account_id,
  apex_account_number,
  account_type,
  is_managed,
  account_status,
  account_cash,
  account_securities,
  account_aum,
  balance_as_of,
  source_snapshot_as_of,
  balance_current,
  close_date,
  client_sf_id,
  household_sf_id,
  source_record_class,
  expected_master_accounts + expected_unmapped_balances AS expected_snapshot_rows,
  expected_open_accounts,
  expected_closed_accounts,
  expected_unmapped_balances AS expected_corporate_accounts,
  expected_current_balance_rows,
  source_snapshot_as_of AS as_of
FROM client_accounts
CROSS JOIN source_expectations
UNION ALL
SELECT
  custodian_account_id,
  apex_account_number,
  account_type,
  is_managed,
  account_status,
  account_cash,
  account_securities,
  account_aum,
  balance_as_of,
  source_snapshot_as_of,
  balance_current,
  close_date,
  client_sf_id,
  household_sf_id,
  source_record_class,
  expected_master_accounts + expected_unmapped_balances AS expected_snapshot_rows,
  expected_open_accounts,
  expected_closed_accounts,
  expected_unmapped_balances AS expected_corporate_accounts,
  expected_current_balance_rows,
  source_snapshot_as_of AS as_of
FROM unmapped_current_balances
CROSS JOIN source_expectations;
