-- Up Migration
--
-- Per-request pre-approval checklist state. A trader works through a fixed set
-- of items (exclusions applied, templates created, asset location done,
-- transition used, legacy/ACAT positions liquidated, residual cash placed,
-- advisor-instructed tickers traded) before approving & executing.
--
-- Stored as JSONB keyed by item: { "<item_key>": { checked, value, by, at } }.
-- `by` / `at` capture who checked each item and when (the audit value — you can
-- show the checklist was completed before approval). NULL until first touched.

ALTER TABLE trade_requests
    ADD COLUMN IF NOT EXISTS preapproval_checklist JSONB;

-- Down Migration

ALTER TABLE trade_requests
    DROP COLUMN IF EXISTS preapproval_checklist;
