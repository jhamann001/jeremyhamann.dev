-- Warehouse card 6634 — New Funding (ACH/Check/Wire) - AOA v2 (Rebook-safe)
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This file exists so the SQL behind the client portrait's funding figures is
-- reviewable in version control and unreviewed edits are detectable.
--
-- Role: External cash funding with Apex rebook lineages collapsed to the newest CURRENT generation.
-- Parameters: {{account_id}} (text, required), {{start_date}} (text, optional)
-- sha256(normalized): 0470248f5b0c5a0906cbc779d9eefb625aff4c01ae37200f11ac7e1f08c0cd74

WITH funding_rows AS (
  SELECT
    a.account_id,
    a.client_id,
    a.activity_date,
    a.settle_date,
    a.net_amount,
    CASE
      WHEN a.activity_description ILIKE 'ACH Deposit%'   THEN 'ACH'
      WHEN a.activity_description ILIKE 'Check Deposit%' THEN 'Check'
      WHEN a.activity_description ILIKE 'Wire Deposit%'  THEN 'Wire'
    END AS funding_method,
    a.activity_description,
    a.activity_id,
    a.source_application_id,
    a.generation,
    ROW_NUMBER() OVER (
      PARTITION BY
        a.account_id,
        COALESCE(NULLIF(a.source_application_id, ''), a.activity_id)
      ORDER BY
        a.generation DESC,
        a.process_date DESC,
        a.creation_time DESC,
        a.activity_id DESC
    ) AS lineage_rank
  FROM apex.apex_daily_activities a
  WHERE a.state = 'CURRENT'
    AND a.sub_type = 'DEPOSIT'
    AND a.net_amount > 0
    AND (
         a.activity_description ILIKE 'ACH Deposit%'
      OR a.activity_description ILIKE 'Check Deposit%'
      OR a.activity_description ILIKE 'Wire Deposit%'
    )
    [[AND a.account_id = {{account_id}}]]
    [[AND a.activity_date >= {{start_date}}]]
)
SELECT
  account_id,
  client_id,
  activity_date,
  settle_date,
  net_amount,
  funding_method,
  activity_description,
  activity_id,
  source_application_id,
  generation
FROM funding_rows
WHERE lineage_rank = 1
ORDER BY activity_date DESC, activity_id DESC
