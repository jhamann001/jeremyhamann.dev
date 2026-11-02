-- Synthetic seed for the Trade Request read-parity cases (ticket). Loaded into a scratch database migrated
-- with the standalone service's migrations (trade-request d41b6c9). Every timestamp is fixed so captured
-- results are reproducible. No real names, emails, accounts or data.
BEGIN;

INSERT INTO users (id, email, name, role, is_active, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'Avery.Advisor@Example.test', 'Avery A. (Trade Request)', 'advisor', true,  '2025-01-02T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000a2', 'blake.advisor@example.test', 'Blake B. (Trade Request)', 'advisor', true,  '2025-01-03T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000a3', 'orin.ops@example.test',      'Orin O. (Trade Request)',  'advisor', true,  '2025-01-04T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000a4', 'tia.former@example.test',    'Tia Trader',               'trader',  false, '2025-01-05T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000a5', 'lee.legacy@example.test',    'Neil Legacy',               'advisor', false, '2025-01-06T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000a6', 'avery.advisor@example.test', 'Avery Duplicate',          'advisor', false, '2025-06-01T10:00:00Z');

INSERT INTO clients (id, name) VALUES
  ('user-10000000-0000-4000-8000-000000000001', 'Alder Family'),
  ('user-10000000-0000-4000-8000-000000000002', 'Birch Trust'),
  ('user-10000000-0000-4000-8000-000000000003', 'Cedar Holdings');

INSERT INTO accounts (id, client_id, account_number, account_type, balance, cash_holding, fixed_holding, equity_holding) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'user-10000000-0000-4000-8000-000000000001', 'VOV4750', 'Taxable',         850000.25, 42500.25, 127500, 680000),
  ('00000000-0000-4000-8000-0000000000c2', 'user-10000000-0000-4000-8000-000000000001', 'ZYP1058', 'Roth IRA',        120000,    600,      0,      119400),
  ('00000000-0000-4000-8000-0000000000c3', 'user-10000000-0000-4000-8000-000000000002', 'JGV9114', 'Joint',           50000,     50000,    0,      0),
  ('00000000-0000-4000-8000-0000000000c4', 'user-10000000-0000-4000-8000-000000000003', 'HNO0026', 'Traditional IRA', 0,         0,        0,      0);

INSERT INTO trade_requests (
  id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, trade_amount, deposit_account,
  rebalance_all, status, created_at, updated_at, selected_accounts, total_value, priority, advisor_notes, residence,
  liquidation_approval, advisor_exclusions, client_exclusions, esg_filters, risk_profile, base_allocation,
  equity_strategies, raise_cash_reason, liquidity_deadline, liquidate_option, liquidate_positions, execution_plan,
  account_metadata, asset_location_mode, household_id, household_name, preapproval_checklist
) VALUES
  ('REQ-P0000001', 'user-10000000-0000-4000-8000-000000000001', 'Alder Family', '["user-10000000-0000-4000-8000-000000000001"]', '["Alder Family"]', '00000000-0000-4000-8000-0000000000a1',
   'Initial Funding', '', '', false, 'Approved', '2025-03-01T14:00:00Z', '2025-03-02T15:30:00Z',
   ARRAY['VOV4750', 'ZYP1058'], 970000.25, 'Standard', 'Synthetic funding notes', 'CA', true, 'XOM', '',
   '{"fossilFuels":true,"tobacco":false,"weapons":true,"alcohol":false,"gambling":false,"other":true,"otherDescription":"Synthetic screen","none":false}',
   12, '{"equity":60,"fixed":35,"cash":5}',
   '[{"id":1,"benchmark":"S&P 500","allocation":70,"rationale":"core"},{"id":2,"benchmark":"MSCI EAFE","allocation":30,"rationale":"intl"}]',
   '', NULL, '', '',
   '[{"accountNumber":"VOV4750","accountType":"Taxable","accountValue":850000.25,"templateName":"Synthetic","modelName":"Synthetic","postTradeHoldings":{"cash":42500.25,"fixed":297500,"equity":510000},"trades":[]}]',
   '[{"accountNumber":"VOV4750","accountType":"Taxable","balance":850000.25,"accountId":"01PARITY000000000000000001"},{"accountNumber":"ZYP1058","accountType":"Roth IRA","balance":120000}]',
   'priority', 9001, 'Alder Household', NULL),
  ('REQ-P0000002', 'user-10000000-0000-4000-8000-000000000001', 'Alder Family', '["user-10000000-0000-4000-8000-000000000001","user-10000000-0000-4000-8000-000000000002"]', '["Alder Family","Birch Trust"]', '00000000-0000-4000-8000-0000000000a1',
   'Rebalance', '', '', true, 'Completed', '2025-05-10T14:00:00Z', '2025-06-01T09:00:00Z',
   ARRAY['VOV4750', 'JGV9114'], 900000.25, 'Low', '', 'NY', false, '', 'TSLA',
   NULL, 9, '{"equity":40,"fixed":55,"cash":5}', '[{"id":3,"benchmark":"Russell 1000","allocation":100,"rationale":"broad"}]',
   '', NULL, '', '', NULL, NULL, 'mirror', 9001, 'Alder Household', NULL),
  ('REQ-P0000003', 'user-10000000-0000-4000-8000-000000000001', 'Alder Family', '["user-10000000-0000-4000-8000-000000000001","user-10000000-0000-4000-8000-000000000002"]', '["Alder Family","Birch Trust"]', '00000000-0000-4000-8000-0000000000a1',
   'Cash Deposit', '180000', 'CHECKING ($180,000.00)', false, 'Pending Review', '2025-07-01T14:00:00Z', '2025-07-01T14:00:00Z',
   ARRAY['CHECKING ($180,000.00)'], 180000, 'Urgent', '', 'Other', NULL, '', '',
   NULL, 15, '{"equity":70,"fixed":25,"cash":5}', '[]', '', NULL, '', '', NULL, NULL, 'priority', NULL, NULL, NULL),
  ('REQ-P0000004', 'user-10000000-0000-4000-8000-000000000002', 'Birch Trust', '["user-10000000-0000-4000-8000-000000000002"]', '["Birch Trust"]', '00000000-0000-4000-8000-0000000000a1',
   'Raise Cash', '25000', '', false, 'Needs Info', '2025-08-01T14:00:00Z', '2025-08-02T14:00:00Z',
   ARRAY['JGV9114'], 50000, 'Standard', '', 'Other', NULL, '', '',
   NULL, NULL, NULL, NULL, 'Synthetic tuition', '2025-09-15', '', '', NULL, NULL, 'priority', NULL, NULL,
   '{"asset_location":{"checked":true,"value":"","by":"Tia Trader","at":"2025-08-02T13:00:00.000Z"},"cash_available":{"checked":false,"value":"Synthetic note","by":"Orin O. (Trade Request)","at":"2025-08-02T13:30:00.000Z"}}'),
  ('REQ-P0000005', 'user-10000000-0000-4000-8000-000000000003', 'Cedar Holdings', '["user-10000000-0000-4000-8000-000000000003"]', '["Cedar Holdings"]', '00000000-0000-4000-8000-0000000000a2',
   'Liquidate', '', '', false, 'Rejected', '2025-09-01T14:00:00Z', '2025-09-03T14:00:00Z',
   ARRAY['HNO0026'], 0, 'Standard', '', 'Other', false, '', '',
   NULL, NULL, NULL, NULL, '', NULL, 'Liquidate_Entire_Account', '', NULL, NULL, 'priority', NULL, NULL, NULL),
  ('REQ-P0000006', 'user-10000000-0000-4000-8000-000000000003', 'Cedar Holdings', NULL, NULL, '00000000-0000-4000-8000-0000000000a5',
   'Initial Funding', '', '', false, 'Pending Review', '2025-10-01T14:00:00Z', '2025-10-01T14:00:00Z',
   '{}', 0, NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, 5, NULL, NULL, NULL, NULL, 'nan', NULL, NULL, NULL, 'priority', NULL, NULL, NULL),
  ('REQ-P0000007', 'user-10000000-0000-4000-8000-000000000002', 'Percent 50% Trust', '["user-10000000-0000-4000-8000-000000000002"]', '["Percent 50% Trust"]', '00000000-0000-4000-8000-0000000000a2',
   'Raise Cash', '1000', '', false, 'Pending Current Asset Liquidation', '2025-11-01T14:00:00Z', '2025-11-02T14:00:00Z',
   ARRAY['JGV9114'], 1000.5, 'Urgent', 'under_score note', 'Other', NULL, '', '',
   NULL, NULL, NULL, NULL, 'Synthetic reason', NULL, 'Specific Positions', 'AAPL 10', NULL, NULL, 'priority', NULL, NULL, NULL);

-- 54 filler requests so the default page (50) has a next page.
INSERT INTO trade_requests (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, trade_amount,
  status, created_at, updated_at, selected_accounts, total_value, priority)
SELECT 'REQ-PF' || lpad(g::text, 6, '0'), 'user-10000000-0000-4000-8000-000000000003', 'Cedar Holdings', '["user-10000000-0000-4000-8000-000000000003"]', '["Cedar Holdings"]',
  '00000000-0000-4000-8000-0000000000a2', 'Raise Cash', '500', 'Pending Review',
  TIMESTAMPTZ '2026-01-01T00:00:00Z' + make_interval(hours => g), TIMESTAMPTZ '2026-01-01T00:30:00Z' + make_interval(hours => g),
  ARRAY['HNO0026'], 500, 'Standard'
FROM generate_series(1, 54) AS g;

INSERT INTO audit_logs (id, request_id, user_name, action, notes, created_at, user_id, channel) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'REQ-P0000001', 'Avery A. (Trade Request)', 'Request submitted', '', '2025-03-01T14:00:00Z', '00000000-0000-4000-8000-0000000000a1', 'standalone'),
  ('00000000-0000-4000-8000-0000000000e2', 'REQ-P0000001', 'Tia Trader', 'Status changed to Approved', 'Synthetic approval', '2025-03-02T15:30:00Z', '00000000-0000-4000-8000-0000000000a4', 'standalone'),
  ('00000000-0000-4000-8000-0000000000e3', 'REQ-P0000001', 'Orin O. (Trade Request)', 'Status changed to Pending Review', '', '2025-03-01T18:00:00Z', NULL, 'aoa'),
  ('00000000-0000-4000-8000-0000000000e4', 'REQ-P0000002', 'Tia Trader', 'Status changed to Completed', NULL, '2025-06-01T09:00:00Z', NULL, 'standalone'),
  ('00000000-0000-4000-8000-0000000000e5', 'REQ-P0000006', 'Neil Legacy', 'Request submitted', '', '2025-10-01T14:00:00Z', '00000000-0000-4000-8000-0000000000a5', 'standalone');

INSERT INTO notifications (id, user_id, body, request_id, read_at, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', 'Trade request REQ-P0000001 status updated to: Approved', 'REQ-P0000001', NULL, '2025-03-02T15:30:01Z'),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000a1', 'Trade request REQ-P0000004 status updated to: Needs Info', 'REQ-P0000004', '2025-08-03T09:00:00Z', '2025-08-02T14:00:01Z'),
  ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000a1', 'Alder Family: 2 exclusions added', NULL, NULL, '2025-08-05T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000a2', 'Trade request REQ-P0000005 status updated to: Rejected', 'REQ-P0000005', NULL, '2025-09-03T14:00:01Z'),
  ('00000000-0000-4000-8000-0000000000f5', '00000000-0000-4000-8000-0000000000a3', 'New trade request REQ-P0000003 submitted for Alder Family', 'REQ-P0000003', NULL, '2025-07-01T14:00:01Z'),
  ('00000000-0000-4000-8000-0000000000f6', '00000000-0000-4000-8000-0000000000a6', 'Never shown: belongs to the later duplicate identity', NULL, NULL, '2025-06-02T10:00:00Z');

INSERT INTO client_exclusions (id, client_id, ticker, kind, reason, created_by, created_by_name, created_at, no_buy, no_sell) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'user-10000000-0000-4000-8000-000000000001', 'XOM',  'advisor', 'Synthetic ESG',  '00000000-0000-4000-8000-0000000000a1', 'Avery A. (Trade Request)', '2025-04-01T10:00:00Z', true,  false),
  ('00000000-0000-4000-8000-0000000000d2', 'user-10000000-0000-4000-8000-000000000001', 'AAPL', 'client',  '',               NULL,                                   'Tia Trader',               '2025-04-02T10:00:00Z', true,  true),
  ('00000000-0000-4000-8000-0000000000d3', 'user-10000000-0000-4000-8000-000000000001', 'MSFT', 'client',  'Client request', '00000000-0000-4000-8000-0000000000a3', 'Orin O. (Trade Request)',  '2025-04-03T10:00:00Z', false, true),
  ('00000000-0000-4000-8000-0000000000d4', 'user-10000000-0000-4000-8000-000000000002', 'TSLA', 'client',  '',               NULL,                                   'Tia Trader',               '2025-04-04T10:00:00Z', true,  true);

INSERT INTO account_exclusions (id, account_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '01PARITY000000000000000001', 'NVDA', 'advisor', 'Concentration', true, false, NULL, 'Tia Trader',               '2025-04-05T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000b2', '01PARITY000000000000000001', 'GOOG', 'client',  '',              true, true,  NULL, 'Avery A. (Trade Request)', '2025-04-06T10:00:00Z'),
  ('00000000-0000-4000-8000-0000000000b3', '01PARITY000000000000000003', 'AMZN', 'client',  '',              false, true, NULL, 'Tia Trader',               '2025-04-07T10:00:00Z');

COMMIT;
