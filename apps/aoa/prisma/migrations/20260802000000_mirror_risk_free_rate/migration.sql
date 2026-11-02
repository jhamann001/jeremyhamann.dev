-- Always-On Advice — Risk-free-rate daily series (performance-report Sharpe input).
--
-- WHY THIS TABLE EXISTS. The Sharpe ratio on both TWR performance reports
-- (account + household) needed an annualized risk-free rate. Until now that rate
-- was a CONSTANT hard-coded at two call sites (`rfAnnual: 0.042` in
-- lib/twr/warehouse.ts and lib/twr/household.ts, backed by `DEFAULT_RF` in
-- lib/twr/engine.ts). Re-basing it meant a code change + redeploy in two places
-- kept in sync BY HAND, and by 2026-07-28 the disclosed 4.2% was ~30bp stale
-- (the actual 3-month Treasury par yield that day was 3.90%). A compliance
-- review flagged it as the ONE manually-maintained assumption inside the
-- calculation path. The fix is to feed it as DATA.
--
-- SOURCE. US Treasury "Daily Treasury Par Yield Curve Rates", the "3 Mo" column
-- (public, no API key, authoritative and citable):
--   https://home.treasury.gov/resource-center/data-chart-center/interest-rates/
--     daily-treasury-rates.csv/<year>/all?type=daily_treasury_yield_curve
--     &field_tdr_date_value=<year>&page&_format=csv
-- One row per business day; header `Date,"1 Mo","1.5 Month","2 Mo","3 Mo",...`.
--
-- AOA NEVER CALLS TREASURY. An n8n workflow fetches the CSV and POSTs it to
-- /api/ingest/risk-free-rate (the house pattern). The report path reads ONLY
-- stored rows, so a generated report is reproducible after the fact — that is
-- the entire point of moving the rate out of code.
--
-- Hand-authored (the mirror_roles_grants_rls idiom: NO Prisma models for the
-- mirror schema — ADR-9). Additive-only: one new table + index + grants + RLS.
--
-- VISIBILITY: this is PUBLIC MARKET DATA, not client data. There is nothing to
-- scope to a book of business, so every authenticated app role reads it
-- (contrast the client-scoped mirrors, whose own-book policies ride through
-- mirror.household). Deliberately includes VIEWER.

-- ---------------------------------------------------------------------------
-- 1. mirror.risk_free_rate — one row per Treasury business day.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.risk_free_rate (
  -- The Treasury business date. PRIMARY KEY ⇒ unique, and it is the upsert
  -- conflict target. NB: the feed stores ONE tenor (see `tenor` below); if we
  -- ever ingest a second tenor this PK must become (tenor, rate_date).
  rate_date  date NOT NULL PRIMARY KEY,
  -- Which yield-curve column the rate came from, e.g. '3M' (the "3 Mo" column).
  -- Stored per row so a reader never has to assume, and so a future tenor change
  -- is visible in the data rather than only in the code that wrote it.
  tenor      text NOT NULL,
  -- The par yield as a PERCENT, exactly as Treasury publishes it: 3.90 means
  -- 3.90% (NOT 0.0390). numeric(5,2), NOT double precision, deliberately:
  --   * Treasury publishes exactly 2 decimals, so numeric(5,2) records the
  --     source value EXACTLY with no false precision and no binary-float drift.
  --     The report DISCLOSES the averaged rate; a float would make the disclosed
  --     figure irreproducible at the last digit.
  --   * 5 total digits ⇒ range −999.99..999.99, which covers every rate the
  --     3-month bill has ever printed (the 1981 peak was ~17%) and leaves room
  --     for the slightly-negative prints the short end has occasionally shown.
  rate_pct   numeric(5,2) NOT NULL,
  -- Provenance: which feed wrote the row, e.g. 'us-treasury-daily-par-yield'.
  source     text NOT NULL,
  -- Provenance: when this row was last written/revised by the feed. Treasury
  -- does occasionally revise a published value; the upsert overwrites rate_pct
  -- and bumps this, so the row records the revision time.
  synced_at  timestamptz NOT NULL DEFAULT now()
);
-- The report reads a contiguous date window for one tenor.
CREATE INDEX risk_free_rate_tenor_date_idx ON mirror.risk_free_rate (tenor, rate_date);

-- ---------------------------------------------------------------------------
-- 2. Grants. NO DELETE for ingest_rw — BY DESIGN, and unlike mirror.appointment
--    (whose feed replaces a snapshot). This is an APPEND/UPSERT-BY-DATE time
--    series: history is immutable, a published business day never "disappears",
--    and a Treasury revision is an UPDATE of an existing rate_date. Nothing in
--    the feed has any legitimate reason to remove a day, and a report generated
--    last quarter must still reproduce, so the ability to erase history is
--    withheld at the DB rather than only in the route. app_rw reads only.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON mirror.risk_free_rate TO ingest_rw;
GRANT SELECT ON mirror.risk_free_rate TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security. GUC predicate current_setting('app.user_role', true);
--    a missing GUC returns NULL, so the app_rw policy fails closed.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.risk_free_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.risk_free_rate FORCE  ROW LEVEL SECURITY;

-- Ingestion reads/writes the whole series (the GUC-less B-migration idiom —
-- see lib/ingest/scope.ts: ingest_rw policies never reference a GUC).
CREATE POLICY risk_free_rate_ingest_all ON mirror.risk_free_rate
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- All authenticated app roles read. Public market data — no book scoping is
-- possible or meaningful, and the rate is printed in the client-facing report
-- disclosure anyway.
CREATE POLICY risk_free_rate_read_all_roles ON mirror.risk_free_rate FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN
    ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
);
