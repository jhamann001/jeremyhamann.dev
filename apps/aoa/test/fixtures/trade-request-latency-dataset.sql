-- Synthetic production-sized dataset for the native read-latency check (ticket), loaded straight into AOA's
-- trade_request records. Sizes: 200 identities, 3,000 clients, 6,000 requests (over the 5,000 export cap),
-- 60,000 audit entries, 30,000 notifications (2,000 for the heaviest reader). No real data.
BEGIN;
INSERT INTO trade_request.users (id, email, name, role, is_active, created_at)
SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid,
       CASE WHEN g = 1 THEN 'heavy.reader@example.test' ELSE 'latency' || g || '@example.test' END,
       'Latency Person ' || g, CASE WHEN g % 10 = 0 THEN 'trader' ELSE 'advisor' END, true,
       TIMESTAMPTZ '2024-01-01T00:00:00Z' + make_interval(days => g)
  FROM generate_series(1, 200) AS g;
INSERT INTO trade_request.clients (id, name)
SELECT 'user-20000000-0000-4000-8000-' || lpad(g::text, 12, '0'), 'Latency Client ' || lpad(g::text, 4, '0')
  FROM generate_series(1, 3000) AS g;
INSERT INTO trade_request.trade_requests (
  id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, trade_amount, status, created_at,
  updated_at, selected_accounts, total_value, priority, advisor_notes, risk_profile, base_allocation,
  equity_strategies, esg_filters, account_metadata)
SELECT 'REQ-L' || lpad(g::text, 7, '0'),
       'user-20000000-0000-4000-8000-' || lpad((1 + g % 3000)::text, 12, '0'), 'Latency Client ' || lpad((1 + g % 3000)::text, 4, '0'),
       jsonb_build_array('user-20000000-0000-4000-8000-' || lpad((1 + g % 3000)::text, 12, '0')),
       jsonb_build_array('Latency Client ' || lpad((1 + g % 3000)::text, 4, '0')),
       ('00000000-0000-4000-9000-' || lpad((1 + g % 200)::text, 12, '0'))::uuid,
       (ARRAY['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate'])[1 + g % 5], '1000',
       (ARRAY['Pending Review', 'Needs Info', 'Approved', 'Rejected', 'Completed'])[1 + g % 5],
       TIMESTAMPTZ '2024-01-01T00:00:00Z' + make_interval(mins => g * 97),
       TIMESTAMPTZ '2024-01-01T00:30:00Z' + make_interval(mins => g * 97),
       ARRAY['LAT' || g, 'LATB' || g], 250000.5, 'Standard', repeat('synthetic note ', 20), 12,
       '{"equity":60,"fixed":35,"cash":5}',
       '[{"id":1,"benchmark":"S&P 500","allocation":100,"rationale":"synthetic"}]',
       '{"fossilFuels":false,"tobacco":false,"weapons":false,"alcohol":false,"gambling":false,"other":false,"otherDescription":"","none":true}',
       jsonb_build_array(jsonb_build_object('accountNumber', 'LAT' || g, 'accountType', 'Taxable', 'balance', 125000.25))
  FROM generate_series(1, 6000) AS g;
INSERT INTO trade_request.audit_logs (request_id, user_name, action, notes, created_at, channel)
SELECT 'REQ-L' || lpad((1 + (g - 1) / 10)::text, 7, '0'), 'Latency Person ' || (1 + g % 200),
       'Status changed to Pending Review', 'synthetic audit note', TIMESTAMPTZ '2024-01-01T00:00:00Z' + make_interval(mins => g * 10), 'standalone'
  FROM generate_series(1, 60000) AS g;
INSERT INTO trade_request.notifications (user_id, body, request_id, read_at, created_at)
SELECT ('00000000-0000-4000-9000-' || lpad((CASE WHEN g <= 2000 THEN 1 ELSE 2 + g % 199 END)::text, 12, '0'))::uuid,
       'Trade request REQ-L' || lpad((1 + g % 6000)::text, 7, '0') || ' status updated to: Approved',
       'REQ-L' || lpad((1 + g % 6000)::text, 7, '0'), CASE WHEN g % 3 = 0 THEN NULL ELSE TIMESTAMPTZ '2025-01-01T00:00:00Z' END,
       TIMESTAMPTZ '2024-01-01T00:00:00Z' + make_interval(mins => g * 17)
  FROM generate_series(1, 30000) AS g;
INSERT INTO app."User" (id, name, email, role) VALUES
  ('latency-ops', 'Latency Ops', 'ops.reader@example.test', 'OPERATIONS'),
  ('latency-heavy', 'Heavy Reader', 'heavy.reader@example.test', 'ADVISOR');
UPDATE trade_request.serving_state SET serving_source = 'aoa', updated_by = 'latency-test';
COMMIT;
ANALYZE;
