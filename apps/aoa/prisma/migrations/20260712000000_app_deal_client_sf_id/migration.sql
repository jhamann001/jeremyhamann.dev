-- Always-On Advice — link app.deal to the individual CLIENT (tkt-deals-client-link).
--
-- The CRM deals report already carries the client key ("Person: Contact
-- ID", the 18-char 003 Salesforce Contact id) — the SAME width/value as
-- `mirror.client.sf_id` (populated by the CRM Client Pull). Persisting it
-- on the deal lets the Client Portrait show a client's own deals via a direct
-- 18-char equality (unlike the household 15/18 case — no prefix normalization).
--
-- Additive-only (ADR-5): NO drops, NO renames — one nullable column + its index.
-- NO new grants: app.deal's table DML for `app_rw` (20260702011108_app_deal)
-- and `ingest_rw` (20260711000000_app_deal_ingest) is granted at the TABLE
-- level, and RLS admits by role/`deal_ingest_all` — both cover new columns with
-- no re-grant. The existing FORCE-RLS policies are UNAFFECTED.

-- AddColumn
ALTER TABLE "app"."deal" ADD COLUMN "client_sf_id" text;

-- CreateIndex
CREATE INDEX "deal_client_sf_id_idx" ON "app"."deal" ("client_sf_id");
