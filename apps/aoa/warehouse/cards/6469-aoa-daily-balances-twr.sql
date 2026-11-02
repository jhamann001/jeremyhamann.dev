-- Warehouse card 6469 — AOA Daily Balances (TWR)
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This file exists so the SQL behind every client-facing performance figure
-- is reviewable in version control and so unreviewed edits are detectable
-- (see warehouse/README.md). Editing this file does NOT change the report.
--
-- Role: Daily market value and cash. `total_equity` is the MV each day's TWR is computed from.
-- Parameters: {{account_id}} (text, required), {{as_of}} (text, optional)
-- sha256(normalized): 440eec285b8418df2414bee4f717ccfaa20e4153655651e5887f347b0bee61df

SELECT
  CAST(process_date AS date)  AS d,
  MAX(total_equity)           AS total_equity,
  MAX(position_market_value)  AS position_market_value,
  MAX(net_balance)            AS cash
FROM apex.apex_daily_overnight_balances
WHERE account_id = {{account_id}}
  [[ AND CAST(process_date AS date) <= {{as_of}} ]]
GROUP BY CAST(process_date AS date)
ORDER BY d
