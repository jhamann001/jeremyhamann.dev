-- Warehouse card 6472 — AOA Account Number UULID Resolver
-- Collection: Operations (2047)   Database: 4
--
-- MIRROR, NOT THE SOURCE OF TRUTH. The executing copy lives in Warehouse.
-- This file exists so the SQL behind every client-facing performance figure
-- is reviewable in version control and so unreviewed edits are detectable
-- (see warehouse/README.md). Editing this file does NOT change the report.
--
-- Role: Maps the route's custodian account NUMBER to the ULID the data cards key on, plus client identity. NOTE: lib/twr/warehouse.ts and the methodology document both call this 'AOA Account Resolver (TWR)'; the live card name is the one recorded here.
-- Parameters: {{account_number}} (text, required)
-- sha256(normalized): 40299312b407752e88847a72163bb396316bea2ed1f19b0eb0ebc555c5947444

SELECT
  aci.custodian_account_id     AS account_id,
  aci.custodian_account_number AS apex_acct,
  aci.account_type             AS account_type,
  aci.account_nickname         AS account_nickname,
  pc.name                      AS client_name
FROM views_for_reporting.apex_client_investments aci
LEFT JOIN crm.crm_contacts pc
  ON CAST(pc.cedar_ridge_user_id__c AS varchar) = CAST(aci.user_id AS varchar)
WHERE aci.custodian_account_number = {{account_number}}
ORDER BY pc.name NULLS LAST
LIMIT 1
