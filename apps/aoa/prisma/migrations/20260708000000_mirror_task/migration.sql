-- Always-On Advice — CRM Tasks → household, surfaced on the Client Portrait
-- (TKT, tkt-crm-tasks). Adds mirror.task: the Salesforce Task feed mirror.
--
-- HOUSEHOLD-LEVEL LINKAGE. A Salesforce Task carries a polymorphic WhatId
-- (Task.AccountId here) and a WhoId (the person). The AccountId maps to
-- mirror.household.sf_id, so every task links to a HOUSEHOLD. The per-person
-- WhoId is FLS-blocked in the source pull, so tasks are household-scoped for now
-- (a later slice can add a per-contact column when the field opens up).
-- NO FK on household_sf_id: mirror tolerates orphans by design (the ingest run
-- for the household may not have landed yet), exactly like mirror.account_holder.
--
-- Hand-authored (the mirror_roles_grants_rls idiom: NO Prisma models for the
-- mirror schema — ADR-9). Additive-only (ADR-5): one new table + one index +
-- grants + RLS. Nothing is dropped, renamed, or made NOT NULL. Mirror is
-- upsert-only — NO DELETE grant/policy and NO owner policy for anyone
-- (ADR-7: staleness, not deletes; the Phase B/D mirror posture).

-- ---------------------------------------------------------------------------
-- 1. mirror.task — the Salesforce Task feed, household-scoped.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.task (
  sf_id            text PRIMARY KEY,            -- Salesforce Task Id (00T...)
  household_sf_id  text NOT NULL,               -- Salesforce Task.AccountId = mirror.household.sf_id; NO FK (mirror tolerates orphans, like account_holder)
  subject          text,
  status           text,
  priority         text,
  description      text,
  source_modified_at timestamptz,               -- Salesforce LastModifiedDate
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_household_idx ON mirror.task (household_sf_id);

-- ---------------------------------------------------------------------------
-- 2. Grants — ingest writes, app reads; NEVER DELETE for anyone in mirror
--    (ADR-7: staleness, not deletes).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON mirror.task TO ingest_rw;
GRANT SELECT ON mirror.task TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security — the mirror_roles_grants_rls idiom, mirroring the
--    mirror.account policies exactly. GUC predicate is
--    current_setting('app.user_role', true); a missing GUC returns NULL, so
--    every app_rw policy fails closed. NO owner (aoa) policy and NO DELETE
--    policy for anyone (the Phase B/D mirror posture: the feed writes mirror.*
--    as ingest_rw).
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.task FORCE  ROW LEVEL SECURITY;

-- Ingestion writes the whole firm (the B-migration idiom).
CREATE POLICY task_ingest_all ON mirror.task FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Ops/Admin/HoA read all (firm view).
CREATE POLICY task_ops_all ON mirror.task FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
);

-- Advisors/Client Service: tasks for a household in their book. The EXISTS
-- rides through mirror.household, whose own RLS policies apply inside the
-- subquery — which is exactly the intended scoping (an advisor sees tasks only
-- for households visible to them, and it fails closed while an ingested
-- household row has a null lead_advisor_email, ADR-5).
CREATE POLICY task_own_book ON mirror.task FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
  AND EXISTS (
    SELECT 1
    FROM mirror.household h
    WHERE h.sf_id = task.household_sf_id
  )
);
