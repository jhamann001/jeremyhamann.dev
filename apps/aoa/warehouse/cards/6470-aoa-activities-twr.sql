-- Warehouse card 6470 — AOA Activities (TWR)
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This file exists so the SQL behind every client-facing performance figure
-- is reviewable in version control and so unreviewed edits are detectable
-- (see warehouse/README.md). Editing this file does NOT change the report.
--
-- Role: Flows, dividends, fees and corporate actions. TRADE/ALLOCATION are excluded by the category filter, so internal trading never reads as a client flow.
-- Parameters: {{account_id}} (text, required), {{as_of}} (text, optional)
-- sha256(normalized): 28b46414666b1d12437c5fb6a95a48828ead160b4131116629781c3dcffb2d32

SELECT
  CAST(activity_date AS date) AS d,
  type,
  sub_type,
  subtype_category,
  net_amount,
  symbol,
  activity_description,
  state
FROM apex.apex_daily_activities
WHERE account_id = {{account_id}}
  AND state = 'CURRENT'
  [[ AND CAST(activity_date AS date) <= {{as_of}} ]]
  AND (
        subtype_category IN
          ('DEPOSIT','WITHDRAWAL','TRANSFER','ACCOUNT_TRANSFER','CREDIT',
           'REDEMPTION_FULL','LIQUIDATION','CASH_DIVIDEND','INTEREST','CAPITAL_GAINS','FEE')
     OR subtype_category LIKE 'ACATS%'
     OR type = 'CORPORATE_ACTION'
      )
ORDER BY d
