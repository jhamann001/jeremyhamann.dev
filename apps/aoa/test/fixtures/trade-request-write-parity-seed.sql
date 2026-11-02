-- Synthetic write-parity seed (ticket). Unqualified table names: the standalone capture loads it into public,
-- the AOA test into trade_request (PGOPTIONS='-c search_path=trade_request'). No real names, emails or accounts.
INSERT INTO users (id, email, name, role, is_active, slack_user_id) VALUES
  ('00000000-0000-4000-8000-000000000a01', 'parity.advisor@example.test', 'Avery Parity', 'advisor', true, NULL),
  ('00000000-0000-4000-8000-000000000a02', 'parity.advisor2@example.test', 'Blake Parity', 'advisor', true, NULL),
  ('00000000-0000-4000-8000-000000000a03', 'parity.ops@example.test', 'Orin Parity', 'trader', true, 'U0RRIIUZ4');

INSERT INTO clients (id, name) VALUES ('PARITY-C1', 'Parity Client One'), ('PARITY-C2', 'Parity Client Two');

INSERT INTO accounts (id, client_id, account_number, account_type, balance, cash_holding, fixed_holding, equity_holding)
VALUES ('00000000-0000-4000-8000-000000000b01', 'PARITY-C1', 'PAR-ACCT-1', 'Taxable', 250000.50, 250000.50, 0, 0);

INSERT INTO trade_requests
  (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, trade_amount, status, total_value,
   selected_accounts, priority, advisor_notes, liquidate_option, risk_profile, base_allocation, equity_strategies,
   created_at, updated_at)
VALUES
  ('REQ-PARNI001', 'PARITY-C1', 'Parity Client One', '["PARITY-C1"]', '["Parity Client One"]',
   '00000000-0000-4000-8000-000000000a01', 'Liquidate', NULL, 'Needs Info', 1000, ARRAY['PAR-ACCT-1'], 'Standard',
   'original notes', 'Entire Account', NULL, NULL, NULL, '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'),
  ('REQ-PARNI002', 'PARITY-C1', 'Parity Client One', '["PARITY-C1"]', '["Parity Client One"]',
   '00000000-0000-4000-8000-000000000a01', 'Liquidate', NULL, 'Needs Info', 1000, ARRAY['PAR-ACCT-1'], 'Standard',
   'original notes', 'Entire Account', NULL, NULL, NULL, '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'),
  ('REQ-PARNI003', 'PARITY-C1', 'Parity Client One', '["PARITY-C1"]', '["Parity Client One"]',
   '00000000-0000-4000-8000-000000000a02', 'Liquidate', NULL, 'Needs Info', 1000, ARRAY['PAR-ACCT-1'], 'Standard',
   'original notes', 'Entire Account', NULL, NULL, NULL, '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'),
  ('REQ-PARPR001', 'PARITY-C1', 'Parity Client One', '["PARITY-C1"]', '["Parity Client One"]',
   '00000000-0000-4000-8000-000000000a01', 'Raise Cash', '5000', 'Pending Review', 1000, ARRAY['PAR-ACCT-1'], 'Urgent',
   NULL, NULL, NULL, NULL, NULL, '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'),
  ('REQ-PARAP001', 'PARITY-C2', 'Parity Client Two', '["PARITY-C2"]', '["Parity Client Two"]',
   '00000000-0000-4000-8000-000000000a01', 'Rebalance', NULL, 'Approved', 50000, ARRAY['PAR-ACCT-2'], 'Standard',
   NULL, NULL, 12, '{"equity": 61, "fixed": 34.5, "cash": 4.5}',
   '[{"id": 1, "benchmark": "SPY", "allocation": 100, "rationale": "core"}]', '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z');

INSERT INTO audit_logs (id, request_id, user_name, user_id, action, notes, channel, created_at) VALUES
  ('00000000-0000-4000-8000-000000000f01', 'REQ-PARNI001', 'Avery Parity', '00000000-0000-4000-8000-000000000a01',
   'Created Request', 'Liquidation requested.', 'standalone', '2026-10-01T11:00:00Z');

INSERT INTO client_exclusions (id, client_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) VALUES
  ('00000000-0000-4000-8000-000000000c01', 'PARITY-C1', 'TSLA', 'client', 'Values', true, false,
   '00000000-0000-4000-8000-000000000a01', 'Avery Parity', '2026-10-01T11:00:00Z'),
  ('00000000-0000-4000-8000-000000000c02', 'PARITY-C1', 'XOM', 'advisor', '', true, true,
   '00000000-0000-4000-8000-000000000a01', 'Avery Parity', '2026-10-01T11:00:00Z');

INSERT INTO account_exclusions (id, account_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) VALUES
  ('00000000-0000-4000-8000-000000000d01', 'PAR-ULID-1', 'AAPL', 'client', '', true, false,
   '00000000-0000-4000-8000-000000000a01', 'Avery Parity', '2026-10-01T11:00:00Z');

INSERT INTO notifications (id, user_id, body, request_id, read_at, created_at) VALUES
  ('00000000-0000-4000-8000-000000000e01', '00000000-0000-4000-8000-000000000a01', 'seed one', 'REQ-PARPR001', NULL, '2026-10-01T11:00:00Z'),
  ('00000000-0000-4000-8000-000000000e02', '00000000-0000-4000-8000-000000000a01', 'seed two', NULL, NULL, '2026-10-01T11:01:00Z'),
  ('00000000-0000-4000-8000-000000000e03', '00000000-0000-4000-8000-000000000a03', 'seed three', NULL, NULL, '2026-10-01T11:02:00Z');
