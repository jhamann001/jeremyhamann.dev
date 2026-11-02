-- Warehouse card 6502 — AOA Realized G/L YTD
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This file exists so the SQL behind every client-facing performance figure
-- is reviewable in version control and so unreviewed edits are detectable
-- (see warehouse/README.md). Editing this file does NOT change the report.
--
-- Role: Closed tax lots at the latest snapshot, ONE row per closed_lot_id. The dedup happens INSIDE this card - never re-dedupe application-side.
-- Parameters: {{account_id}} (text, required), {{as_of}} (text, optional)
-- sha256(normalized): e1421781c64d8cf967c3c548cdb50b75b9ed2111d76e8313236daf0b52864b0b

WITH latest AS (
  SELECT MAX(CAST(process_date AS date)) AS pd
  FROM apex.apex_cost_basis_closed_lot_full_refresh
  WHERE account_id = {{account_id}}
),
dedup AS (
  SELECT c.*,
         ROW_NUMBER() OVER (PARTITION BY c.closed_lot_id
                            ORDER BY c.snapshot_timestamp DESC) AS rn
  FROM apex.apex_cost_basis_closed_lot_full_refresh c, latest
  WHERE c.account_id = {{account_id}}
    AND CAST(c.process_date AS date) = latest.pd
)
SELECT CAST(disposal_trade_date AS date) AS disposal_date,
       term, symbol, gain_loss, wash_sale_adjustment, disallowed_loss
FROM dedup
WHERE rn = 1
  [[ AND CAST(disposal_trade_date AS date) <= {{as_of}} ]]
ORDER BY disposal_date
