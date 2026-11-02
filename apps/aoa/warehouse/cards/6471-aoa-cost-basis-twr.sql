-- Warehouse card 6471 — AOA Cost Basis (TWR)
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This file exists so the SQL behind every client-facing performance figure
-- is reviewable in version control and so unreviewed edits are detectable
-- (see warehouse/README.md). Editing this file does NOT change the report.
--
-- Role: Open tax lots at the latest weekly snapshot at or before the as-of date. Source of cost basis and the unrealized figure.
-- Parameters: {{account_id}} (text, required), {{as_of}} (text, optional)
-- sha256(normalized): e68ce19e956d0ee10287c9e11336e36698aee98e05da761574fb5c1ac10d717a

WITH snaps AS (
  SELECT DISTINCT CAST(process_date AS date) AS snap
  FROM apex.apex_cost_basis_open_lot_full_refresh
  WHERE account_id = {{account_id}}
    [[ AND CAST(process_date AS date) <= {{as_of}} ]]
),
pick AS ( SELECT MAX(snap) AS snap FROM snaps )
SELECT
  CAST(c.process_date AS date)   AS snapshot_date,
  c.symbol,
  c.cusip,
  c.quantity,
  c.acquisition_adjusted_net     AS cost_basis,
  c.term
FROM apex.apex_cost_basis_open_lot_full_refresh c
JOIN pick ON CAST(c.process_date AS date) = pick.snap
WHERE c.account_id = {{account_id}}
  AND c.open_closed_indicator = 'OPEN'
ORDER BY c.symbol
