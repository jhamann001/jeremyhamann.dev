-- Always-On Advice — ticket Slice 1: collapse the asset-transfer stage model
-- from five stages to three (DECISION → IN_TRANSFER → FUNDED). DISCOVERY and
-- ACCOUNTS_OPEN leave the process/board/order/labels/gates.
--
-- Postgres cannot cleanly drop a value from an in-use enum (there is no
-- `ALTER TYPE … DROP VALUE`; a physical drop would require recreating the type
-- and re-casting every dependent column — destructive, high-risk). Per the
-- repo's additive-only enum discipline and the HoA-precedent decision (§1.5a of
-- the blueprint), DISCOVERY and ACCOUNTS_OPEN stay physically present in the
-- `TransferStage` enum but INERT: no TS constant / board / gate produces them.
--
-- This migration is a one-way baseline data remap (NOT flag-gated — a compile-
-- time stage-model change). The accounts_opened_at_apex backfill for the
-- ex-ACCOUNTS_OPEN rows lands in Slice 2, once that column exists.
--
-- NO new grant / NO new RLS policy: this only UPDATEs an existing column and
-- changes its default. The app.transfer FORCE-RLS policies + table grants
-- (20260702141028_app_transfer) already admit by role; writes are captured by
-- the app.transfer DB-trigger audit (audit.row_change, 20260713000000).

-- Remap the two removed stages onto DECISION (the collapsed pre-transfer lane).
UPDATE "app"."transfer" SET "stage" = 'DECISION'
 WHERE "stage" IN ('DISCOVERY', 'ACCOUNTS_OPEN');

-- New rows default to DECISION (was DISCOVERY, now inert).
ALTER TABLE "app"."transfer" ALTER COLUMN "stage" SET DEFAULT 'DECISION';
