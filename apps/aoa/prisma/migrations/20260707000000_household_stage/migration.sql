-- Always-On Advice — carry the Salesforce Entity_Client_Stage__c lifecycle on
-- mirror.household. The CRM households feed used to pull ONLY
-- Entity_Client_Stage__c = 'Client'; it now pulls ALL stages (Client, Prospect,
-- Lost Client, Lost Prospect) so prospects/lost households land in the mirror,
-- are filterable/sortable in-app, and give incoming deals a household to link to.
--
-- Hand-authored (the mirror_roles_grants_rls idiom: NO Prisma models for the
-- mirror schema — ADR-9). Additive-only (ADR-5): ONE new nullable column plus
-- its index. Nothing is dropped, renamed, or made NOT NULL. The existing
-- free-text `status` column is left untouched.
--
-- No new grant needed: ingest_rw already holds SELECT/INSERT/UPDATE on
-- mirror.household (Phase B mirror_roles_grants_rls), and a table-level GRANT in
-- Postgres covers all present and future columns — so the ingest upsert can
-- write `stage` with no privilege change. RLS is unchanged (stage is not a
-- policy predicate; visibility still rides lead_advisor_email).
ALTER TABLE mirror.household ADD COLUMN stage text;
CREATE INDEX household_stage_idx ON mirror.household (stage);
