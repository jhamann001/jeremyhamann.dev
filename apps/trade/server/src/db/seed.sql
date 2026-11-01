-- Seed data for development and staging environments
-- Run with: psql -f server/src/db/seed.sql

INSERT INTO clients (id, name) VALUES
  ('HH-001', 'The Richardson Family'),
  ('HH-002', 'Martin & Lisa Goldberg'),
  ('HH-003', 'David Park')
ON CONFLICT (id) DO NOTHING;

INSERT INTO accounts (client_id, account_number, account_type, balance, cash_holding, fixed_holding, equity_holding) VALUES
  ('HH-001', 'ACCT-1001', 'Taxable',         850000, 42500, 127500, 680000),
  ('HH-001', 'ACCT-1002', 'Traditional IRA',  420000,  2100, 147000, 270900),
  ('HH-001', 'ACCT-1003', 'Roth IRA',         180000,   900,      0, 179100),
  ('HH-002', 'ACCT-2001', 'Taxable',        1200000, 60000, 180000, 960000),
  ('HH-002', 'ACCT-2002', 'Roth IRA',         350000,  1750,      0, 348250),
  ('HH-003', 'ACCT-3001', 'Taxable',          500000, 25000,  75000, 400000),
  ('HH-003', 'ACCT-3002', 'Traditional IRA',  275000,  1375,  96250, 177375)
ON CONFLICT (account_number) DO NOTHING;

-- ─── Drift v2 (per-account) demo run — cost-basis tax layer ──────────────────
-- One run dated today so it's the "latest run" the v2 dashboard shows. The
-- `details.tax` + `details.costBasisFreshness` blobs exercise the full UI:
-- staleness banner, unrealized-gain column (+/−), transfer-in % chip,
-- taxable-only transition-candidate chip, the Tax & cost basis panel, and the
-- tax-adjusted sort. Idempotent on (run_date_local, account_id).
INSERT INTO position_drift_accounts (
    run_date_local, account_id, account_title, household_name, coverage, status,
    total_value_usd, position_cash_pct, position_fixed_pct, position_equity_pct,
    template_cash_pct, template_fixed_pct, template_equity_pct,
    max_bucket_delta_pct, worst_bucket, symbol_breach_count,
    schema_version, snapshot_source, snapshot_as_of, details
) VALUES
  -- Tax-LOCKED: big long-term gains + transfer-in, but HAS a template → not a
  -- transition candidate. Sorts to the top of "Unrealized gain (highest first)".
  (CURRENT_DATE, '01HQ8ZDEMOVANGSBRKRG000001', 'Victor Lang - Brokerage', 'Lang Family', 'both', 'out',
   241000, 0.20, 3.40, 96.40, 2.00, 18.00, 80.00, 16.40, 'equity', 2, 1, 'seed', NULL,
   '{"buckets":{"cash":{"positionPct":0.20,"templatePct":2.00,"deltaPct":1.80},"fixed":{"positionPct":3.40,"templatePct":18.00,"deltaPct":14.60},"equity":{"positionPct":96.40,"templatePct":80.00,"deltaPct":16.40}},"symbolsWithTargets":[],"equityHoldings":[{"symbol":"NVDA","positionPct":15.77},{"symbol":"WDC","positionPct":2.44}],"positionOnlySymbols":[],"suspectedCashEquivMisclassified":[],"tax":{"investableValueUsd":241000,"basisCoveragePct":97,"unrealizedGainUsd":44767,"unrealizedShortTermGainUsd":5249,"unrealizedLongTermGainUsd":39518,"transferInValueUsd":171000,"transferInPct":71,"hasMissingBasis":false,"transitionCandidate":false,"realizedGainYtdUsd":41000,"realizedShortTermYtdUsd":5000,"realizedLongTermYtdUsd":36000,"symbols":[{"symbol":"NVDA","marketValueUsd":38000,"costBasisUsd":5482,"unrealizedGainUsd":32518,"unrealizedShortTermGainUsd":0,"unrealizedLongTermGainUsd":32518,"transferInPct":60,"hasMissingBasis":false},{"symbol":"WDC","marketValueUsd":5875,"costBasisUsd":626,"unrealizedGainUsd":5249,"unrealizedShortTermGainUsd":5249,"unrealizedLongTermGainUsd":0,"transferInPct":100,"hasMissingBasis":false},{"symbol":"TSM","marketValueUsd":6300,"costBasisUsd":4814,"unrealizedGainUsd":1486,"unrealizedShortTermGainUsd":0,"unrealizedLongTermGainUsd":1486,"transferInPct":100,"hasMissingBasis":false}]},"costBasisFreshness":{"level":"warn","fullProcessDate":"2026-05-22","fullAgeDays":9,"dailyProcessDate":"2026-06-02","dailyAgeDays":2,"pipelineLatest":"2026-06-02T11:02:00-04:00","pipelineAgeDays":2,"message":"Cost-basis data stale (warn) - full 9d, daily 2d, pipeline 2d"}}'::jsonb),

  -- TRANSITION CANDIDATE: taxable, no template, 88% transfer-in → flagged.
  (CURRENT_DATE, '01HQ8ZDEMOMARQUEZTRUST0002', 'Marquez Family Trust - Brokerage', 'Marquez Family', 'positions_only', 'no_template',
   320000, 1.00, 0.00, 99.00, 0.00, 0.00, 0.00, NULL, NULL, 0, 1, 'seed', NULL,
   '{"buckets":{"cash":{"positionPct":1.00,"templatePct":0.00,"deltaPct":1.00},"fixed":{"positionPct":0.00,"templatePct":0.00,"deltaPct":0.00},"equity":{"positionPct":99.00,"templatePct":0.00,"deltaPct":99.00}},"symbolsWithTargets":[],"equityHoldings":[{"symbol":"AAPL","positionPct":22.10},{"symbol":"MSFT","positionPct":18.40}],"positionOnlySymbols":[],"suspectedCashEquivMisclassified":[],"tax":{"investableValueUsd":320000,"basisCoveragePct":95,"unrealizedGainUsd":88250,"unrealizedShortTermGainUsd":12000,"unrealizedLongTermGainUsd":76250,"transferInValueUsd":281600,"transferInPct":88,"hasMissingBasis":true,"transitionCandidate":true,"realizedGainYtdUsd":0,"realizedShortTermYtdUsd":0,"realizedLongTermYtdUsd":0,"symbols":[{"symbol":"AAPL","marketValueUsd":70720,"costBasisUsd":18200,"unrealizedGainUsd":52520,"unrealizedShortTermGainUsd":0,"unrealizedLongTermGainUsd":52520,"transferInPct":100,"hasMissingBasis":false},{"symbol":"MSFT","marketValueUsd":58880,"costBasisUsd":31150,"unrealizedGainUsd":27730,"unrealizedShortTermGainUsd":4000,"unrealizedLongTermGainUsd":23730,"transferInPct":100,"hasMissingBasis":false},{"symbol":"BRK.B","marketValueUsd":24000,"costBasisUsd":16000,"unrealizedGainUsd":8000,"unrealizedShortTermGainUsd":8000,"unrealizedLongTermGainUsd":0,"transferInPct":100,"hasMissingBasis":true}]},"costBasisFreshness":{"level":"warn","fullProcessDate":"2026-05-22","fullAgeDays":9,"dailyProcessDate":"2026-06-02","dailyAgeDays":2,"pipelineLatest":"2026-06-02T11:02:00-04:00","pipelineAgeDays":2,"message":"Cost-basis data stale (warn) - full 9d, daily 2d, pipeline 2d"}}'::jsonb),

  -- CHEAP TO FIX: out of tolerance but sitting on losses → sorts to top of
  -- "Unrealized gain (lowest first)". A free rebalance / loss-harvest.
  (CURRENT_DATE, '01HQ8ZDEMOGOLDBERGBRK00003', 'Goldberg Joint - Brokerage', 'Goldberg Family', 'both', 'out',
   1200000, 1.00, 26.30, 72.70, 2.00, 18.00, 80.00, 8.30, 'fixed', 1, 1, 'seed', NULL,
   '{"buckets":{"cash":{"positionPct":1.00,"templatePct":2.00,"deltaPct":1.00},"fixed":{"positionPct":26.30,"templatePct":18.00,"deltaPct":8.30},"equity":{"positionPct":72.70,"templatePct":80.00,"deltaPct":7.30}},"symbolsWithTargets":[],"equityHoldings":[],"positionOnlySymbols":[],"suspectedCashEquivMisclassified":[],"tax":{"investableValueUsd":1188000,"basisCoveragePct":99,"unrealizedGainUsd":-9800,"unrealizedShortTermGainUsd":-9800,"unrealizedLongTermGainUsd":0,"transferInValueUsd":0,"transferInPct":0,"hasMissingBasis":false,"transitionCandidate":false,"realizedGainYtdUsd":18500,"realizedShortTermYtdUsd":2000,"realizedLongTermYtdUsd":16500,"symbols":[{"symbol":"BNDX","marketValueUsd":21750,"costBasisUsd":26999,"unrealizedGainUsd":-5249,"unrealizedShortTermGainUsd":-5249,"unrealizedLongTermGainUsd":0,"transferInPct":0,"hasMissingBasis":false},{"symbol":"VCSH","marketValueUsd":18000,"costBasisUsd":22551,"unrealizedGainUsd":-4551,"unrealizedShortTermGainUsd":-4551,"unrealizedLongTermGainUsd":0,"transferInPct":0,"hasMissingBasis":false}]},"costBasisFreshness":{"level":"warn","fullProcessDate":"2026-05-22","fullAgeDays":9,"dailyProcessDate":"2026-06-02","dailyAgeDays":2,"pipelineLatest":"2026-06-02T11:02:00-04:00","pipelineAgeDays":2,"message":"Cost-basis data stale (warn) - full 9d, daily 2d, pipeline 2d"}}'::jsonb),

  -- NO TAX DATA: uninvested cash account → gain column shows an em-dash.
  (CURRENT_DATE, '01HQ8ZDEMOPARKROTH00000004', 'David Park - Roth IRA', 'Park Family', 'both', 'uninvested',
   50000, 99.80, 0.00, 0.20, 2.00, 18.00, 80.00, 79.80, 'equity', 0, 1, 'seed', NULL,
   '{"buckets":{"cash":{"positionPct":99.80,"templatePct":2.00,"deltaPct":97.80},"fixed":{"positionPct":0.00,"templatePct":18.00,"deltaPct":18.00},"equity":{"positionPct":0.20,"templatePct":80.00,"deltaPct":79.80}},"symbolsWithTargets":[],"equityHoldings":[],"positionOnlySymbols":[],"suspectedCashEquivMisclassified":[],"costBasisFreshness":{"level":"warn","fullProcessDate":"2026-05-22","fullAgeDays":9,"dailyProcessDate":"2026-06-02","dailyAgeDays":2,"pipelineLatest":"2026-06-02T11:02:00-04:00","pipelineAgeDays":2,"message":"Cost-basis data stale (warn) - full 9d, daily 2d, pipeline 2d"}}'::jsonb)
ON CONFLICT (run_date_local, account_id) DO NOTHING;
