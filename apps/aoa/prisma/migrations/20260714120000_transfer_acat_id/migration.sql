-- Always-On Advice — link app.transfer to the Transfer Tracker's acat_transfer
-- record (ticket). Persisting the tracker's acatTransferId on the transfer
-- lets the detail page read a REDACTED, live ACAT-status projection from the
-- tracker's OIDC-gated machine endpoint (lib/data/acat-status.ts) — AOA reads,
-- never copies, the ACAT data.
--
-- Additive-only (ADR-5): ONE new nullable column. Nothing is dropped, renamed,
-- or made NOT NULL. NO index — the column is a per-record scalar read by the
-- transfer's own id (getTransfer), never a lookup/join key.
--
-- NO new grant, NO new RLS policy: app.transfer's table-level DML grant for
-- app_rw (20260702141028_app_transfer) covers all present and future columns,
-- and the existing FORCE-RLS read/write policies admit by role — both cover a
-- new column with no re-grant and no policy change. Writes to this column are
-- automatically captured by the app.transfer DB-trigger audit
-- (audit.row_change, 20260713000000_audit_row_change).

-- AddColumn
ALTER TABLE "app"."transfer" ADD COLUMN "acat_transfer_id" text;
