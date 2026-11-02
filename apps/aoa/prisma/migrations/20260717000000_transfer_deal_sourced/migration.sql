-- Always-On Advice — ticket Slice 2: deal-sourced asset-transfer schema
-- additions (the columns the Decision-stage readiness card writes today, and
-- the deal→transfer sync + hard gate consume in later slices).
--
-- Additive-only (ADR-5), following the 20260714120000_transfer_acat_id idiom
-- (new nullable columns) and the 20260711000000_app_deal_ingest idiom (ingest_rw
-- grants + *_ingest_all RLS policies). Nothing is dropped, renamed, or made NOT
-- NULL on an existing column; the four workflow booleans are NOT NULL DEFAULT
-- false, so the existing rows backfill to a safe inert state.
--
-- The new columns inherit app.transfer's FORCE-RLS app_rw role-gated policies +
-- table grant (the transfer_acat_id migration proved a nullable add needs no
-- per-column re-grant), and writes are captured automatically by the
-- app.transfer DB-trigger audit (audit.row_change, 20260713000000).

-- ---------------------------------------------------------------------------
-- 1. New enum — funding rail for a transfer. CHECK/WIRE/ACH are cash rails;
--    ACAT is the security-transfer rail (the only rail that reads the tracker's
--    redacted asset map, S5). Values are legal string literals; `CHECK` is a
--    Postgres keyword but is unambiguous as an enum label.
-- ---------------------------------------------------------------------------
CREATE TYPE "FundingType" AS ENUM ('ACAT', 'CHECK', 'WIRE', 'ACH');

-- ---------------------------------------------------------------------------
-- 2. Additive columns. The three checklist booleans + cash_in_flight are the
--    first-class typed gate inputs (§1.5d — NOT free-text TransferTask rows, so
--    the S3 hard gate can query them reliably); they are NOT NULL DEFAULT false.
--    The rest are nullable: funding_type (rail, set by the card / sync),
--    deal_id/deal_sf_id (the sync's idempotent + display linkage),
--    transferring_firm (seeded from the deal), archived_* (the deal D7
--    soft-archive pattern, written by the S4 sync on LOST/uncommitted),
--    sync_flag (the §1.5b uncommitted_review marker), and acat_record_id
--    (owner-approved: keys ACAT linking/gate/asset-map on the tracker's record
--    PK — robust to acatTransferId="N/A"; threaded through types/seam/seed here,
--    consumed by S3/S5).
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."transfer"
  ADD COLUMN "funding_type"            "FundingType",
  ADD COLUMN "accounts_opened_at_apex" boolean NOT NULL DEFAULT false,
  ADD COLUMN "funding_plan_complete"   boolean NOT NULL DEFAULT false,
  ADD COLUMN "funding_initiated"       boolean NOT NULL DEFAULT false,
  ADD COLUMN "cash_in_flight"          boolean NOT NULL DEFAULT false,
  ADD COLUMN "deal_id"                 text,
  ADD COLUMN "deal_sf_id"              text,
  ADD COLUMN "transferring_firm"       text,
  ADD COLUMN "archived_at"             timestamptz(6),
  ADD COLUMN "archived_by"             text,
  ADD COLUMN "archived_reason"         text,
  ADD COLUMN "sync_flag"               text,
  ADD COLUMN "acat_record_id"          text;

-- ---------------------------------------------------------------------------
-- 3. Stage-model remap is NOT repeated here. The DISCOVERY/ACCOUNTS_OPEN →
--    DECISION UPDATE and the `ALTER COLUMN stage SET DEFAULT 'DECISION'` are
--    owned by Slice 1's migration 20260716120000_transfer_stage_collapse, which
--    already shipped both. Re-running them here would be redundant.
--
--    The blueprint's §3 Slice 2 listed a
--    `SET accounts_opened_at_apex = true WHERE stage = 'ACCOUNTS_OPEN'`
--    backfill — but 20260716120000 already collapsed every ACCOUNTS_OPEN row to
--    DECISION in a prior deploy, so by the time THIS migration runs there are
--    ZERO ACCOUNTS_OPEN rows and that UPDATE would match nothing. It is
--    deliberately omitted rather than shipped as a dead line: ex-ACCOUNTS_OPEN
--    rows conservatively keep accounts_opened_at_apex = false. That is safe —
--    the DECISION→IN_TRANSFER hard gate that reads this column is behind the S3
--    flag (OFF until the owner flips it), and the checkbox is re-confirmable by
--    Client Service on the Decision checklist card.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. deal_id is the sync's idempotent key: PARTIAL UNIQUE (one transfer per
--    deal; NULL for hand-created/legacy APP transfers, which must stay
--    unconstrained). This mirrors the 20260716000000 acat_transfer_id partial-
--    unique idiom exactly — Prisma's DSL cannot express a partial @@unique, so
--    schema.prisma intentionally declares NO @@unique here and `prisma migrate
--    dev` will report this index as drift; the repo deploys via `prisma migrate
--    deploy`, which does not diff — do NOT "fix" the drift by dropping it.
--    deal_sf_id is a plain lookup index (display + rollup joins).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "transfer_deal_id_key"
  ON "app"."transfer" ("deal_id")
  WHERE "deal_id" IS NOT NULL;
CREATE INDEX "transfer_deal_sf_id_idx" ON "app"."transfer" ("deal_sf_id");

-- ---------------------------------------------------------------------------
-- 5. ingest_rw write path for the S4 deal→transfer sync (mirrors
--    20260711000000_app_deal_ingest exactly). USAGE ON SCHEMA app was already
--    granted by that migration (idempotent no-op if present). The sync reads
--    the stored stage/workflow state before reconciling and upserts deal-owned
--    fields → SELECT, INSERT, UPDATE (NEVER DELETE — the transfer domain has no
--    DELETE grant for any role; rollback is soft-archive). FORCE ROW LEVEL
--    SECURITY is on both tables, so ingest_rw needs its own GUC-less
--    *_ingest_all policy; the app_rw role-gated policies stay fail-closed and
--    never evaluate for ingest_rw.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."transfer"      TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."transfer_task" TO ingest_rw;
CREATE POLICY transfer_ingest_all ON "app"."transfer"
  FOR ALL TO ingest_rw
  USING (true)
  WITH CHECK (true);
CREATE POLICY transfer_task_ingest_all ON "app"."transfer_task"
  FOR ALL TO ingest_rw
  USING (true)
  WITH CHECK (true);
