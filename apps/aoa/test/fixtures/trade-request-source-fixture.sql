-- ticket: synthetic Trade Request source rows (standalone schema, public), one or more for every record kind.
-- No real client data: example.com emails, invented names and account numbers. security_sector rows come
-- from the standalone migrations' own seed.
INSERT INTO users (id, google_id, email, name, picture, role, slack_user_id, is_active, last_login, created_at, theme_preference, aoa_provisioned_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'google-synthetic-1', 'trader.one@example.com', 'Trader One', 'https://example.com/p/1.png', 'trader', 'U0SYNTH01', true, '2026-10-01 14:00:00+00', '2026-01-02 09:00:00+00', 'dark', '2026-10-16 12:00:00+00'),
  ('00000000-0000-4000-8000-000000000002', NULL, 'advisor.two@example.com', 'Advisor Two', NULL, 'advisor', NULL, true, NULL, '2026-01-03 09:00:00+00', 'system', NULL);

INSERT INTO clients (id, name) VALUES
  ('CLI-SYN-001', 'Synthetic Household A'),
  ('CLI-SYN-002', 'Synthetic Household B');

INSERT INTO accounts (id, client_id, account_number, account_type, balance, cash_holding, fixed_holding, equity_holding) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'CLI-SYN-001', 'SYN000001', 'Taxable', 100000.00, 5000.00, 25000.00, 70000.00),
  ('00000000-0000-4000-8000-0000000000a2', 'CLI-SYN-002', 'SYN000002', 'Roth IRA', 50000.25, 1000.25, 9000.00, 40000.00);

INSERT INTO trade_requests (id, client_id, advisor_id, trade_type, trade_amount, status, total_value, selected_accounts, priority, advisor_notes, risk_profile, base_allocation, execution_plan, created_at, updated_at, client_name, client_ids, client_names, idempotency_key, household_id, household_name) VALUES
  ('REQ-SYN0001', 'CLI-SYN-001', '00000000-0000-4000-8000-000000000002', 'Rebalance', NULL, 'Pending Review', 100000.00, '{SYN000001}', 'Standard', 'Synthetic rebalance', 5,
   '{"cash": 5, "fixed": 25, "equity": 70}',
   '{"orders": [{"symbol": "VTI", "shares": 12345678901234567890, "price": 1.0000000001}]}',
   '2026-10-01 10:00:00+00', '2026-10-01 10:00:00+00', 'Synthetic Household A', '["CLI-SYN-001"]', '["Synthetic Household A"]', '00000000-0000-4000-8000-0000000000c1', 9001, 'Synthetic Household A'),
  ('REQ-SYN0002', 'CLI-SYN-002', '00000000-0000-4000-8000-000000000002', 'Cash Deposit', '2500', 'Approved', 50000.25, '{SYN000002}', 'Urgent', NULL, NULL, NULL, NULL,
   '2026-10-02 10:00:00+00', '2026-10-03 10:00:00+00', 'Synthetic Household B', '["CLI-SYN-002"]', '["Synthetic Household B"]', NULL, NULL, NULL),
  ('REQ-SYN0003', 'CLI-SYN-001', NULL, 'Raise Cash', '1000', 'Completed', NULL, '{}', 'Low', NULL, NULL, NULL, NULL,
   '2026-10-04 10:00:00+00', '2026-10-05 10:00:00+00', 'Synthetic Household A', NULL, NULL, NULL, NULL, NULL);

INSERT INTO audit_logs (id, request_id, user_name, action, notes, created_at, user_id, channel) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'REQ-SYN0001', 'Advisor Two', 'Created', NULL, '2026-10-01 10:00:00+00', '00000000-0000-4000-8000-000000000002', 'standalone'),
  ('00000000-0000-4000-8000-0000000000b2', 'REQ-SYN0002', 'Trader One', 'Approved', 'Synthetic note', '2026-10-03 10:00:00+00', '00000000-0000-4000-8000-000000000001', 'aoa'),
  ('00000000-0000-4000-8000-0000000000b3', 'REQ-SYN0003', 'Trader One', 'Completed', NULL, '2026-10-05 10:00:00+00', '00000000-0000-4000-8000-000000000001', 'standalone');

INSERT INTO notifications (id, user_id, body, request_id, read_at, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000002', 'Synthetic request approved', 'REQ-SYN0002', NULL, '2026-10-03 10:00:01+00'),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', 'Synthetic request created', 'REQ-SYN0001', '2026-10-01 11:00:00+00', '2026-10-01 10:00:01+00');

INSERT INTO client_exclusions (id, client_id, ticker, kind, reason, created_by, created_by_name, created_at, no_buy, no_sell) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'CLI-SYN-001', 'XOM', 'client', 'Synthetic preference', '00000000-0000-4000-8000-000000000002', 'Advisor Two', '2026-09-01 10:00:00+00', true, true),
  ('00000000-0000-4000-8000-0000000000e2', 'CLI-SYN-002', 'TSLA', 'advisor', '', NULL, 'Advisor Two', '2026-09-02 10:00:00+00', true, false);

INSERT INTO account_exclusions (id, account_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000f1', 'SYN000001', 'AAPL', 'client', 'Synthetic concentrated position', false, true, '00000000-0000-4000-8000-000000000002', 'Advisor Two', '2026-09-03 10:00:00+00');

INSERT INTO digest_runs (run_date, posted_at, summary) VALUES
  ('2026-10-05', '2026-10-05 13:00:00+00', '{"pending": 1, "needsInfo": 0}');

INSERT INTO registry_drift_runs (id, run_date_local, run_started_at, household_name, account_count, max_delta_pct, breach, coverage_status, schema_version, snapshot_source, snapshot_as_of, details) VALUES
  ('00000000-0000-4000-8000-000000000101', '2026-10-05', '2026-10-05 12:00:00+00', 'Synthetic Household A', 1, 3.2500, false, 'full', 1, 'synthetic', '2026-10-05 11:00:00+00', '{"accounts": []}');

INSERT INTO position_drift_accounts (id, run_date_local, run_started_at, account_id, account_title, household_name, coverage, status, total_value_usd, position_cash_pct, position_fixed_pct, position_equity_pct, template_cash_pct, template_fixed_pct, template_equity_pct, max_bucket_delta_pct, worst_bucket, symbol_breach_count, schema_version, snapshot_source, snapshot_as_of, details) VALUES
  ('00000000-0000-4000-8000-000000000111', '2026-10-05', '2026-10-05 12:00:00+00', 'SYN000001', 'Synthetic Taxable', 'Synthetic Household A', 'both', 'in', 100000.00, 5.0000, 25.0000, 70.0000, 5.0000, 25.0000, 70.0000, 0.0000, NULL, 0, 1, 'synthetic', '2026-10-05 11:00:00+00', '{"symbols": []}'),
  ('00000000-0000-4000-8000-000000000112', '2026-10-05', '2026-10-05 12:00:00+00', 'SYN000002', 'Synthetic Roth', 'Synthetic Household B', 'both', 'out', 50000.25, 2.0000, 18.0000, 80.0000, 5.0000, 25.0000, 70.0000, 10.0000, 'equity', 1, 1, 'synthetic', '2026-10-05 11:00:00+00', '{"symbols": [{"symbol": "VTI"}]}');

INSERT INTO drift_alert_sends (run_date_local, sent_at) VALUES
  ('2026-10-05', '2026-10-05 14:00:00+00');

INSERT INTO drift_status_overrides (account_id, reason, note, expires_on, set_by, set_by_name, created_at, updated_at, recheck_notified_at) VALUES
  ('SYN000002', 'active_transition', 'Synthetic override', '2026-12-31', '00000000-0000-4000-8000-000000000001', 'Trader One', '2026-10-05 15:00:00+00', '2026-10-05 15:00:00+00', NULL);
