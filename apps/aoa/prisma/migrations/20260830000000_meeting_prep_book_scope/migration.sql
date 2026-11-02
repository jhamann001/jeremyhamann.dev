-- Close cross-book access to the dense PII stored in app.meeting_prep.
--
-- mirror.appointment intentionally remains firm-wide because the Command Center
-- shows the shared meeting schedule. A generated brief is a different data
-- class: ADMIN/OPERATIONS may access it firm-wide, while ADVISOR and
-- CLIENT_SERVICE may access it only when its client_sf_id resolves through the
-- caller-scoped mirror.client RLS policy. NULL/unmatched clients therefore fail
-- closed for book-scoped roles.
--
-- The EXISTS subquery is SECURITY INVOKER behavior: it runs as app_rw with the
-- same app.user_role/app.user_email GUCs, so mirror.client's own-book policy is
-- the authoritative visibility decision. No PII is copied into a new access
-- table and no additional grants are introduced.

DROP POLICY meeting_prep_read_write_roles ON "app"."meeting_prep";
DROP POLICY meeting_prep_insert_write_roles ON "app"."meeting_prep";
DROP POLICY meeting_prep_update_write_roles ON "app"."meeting_prep";

CREATE POLICY meeting_prep_read_book_scope ON "app"."meeting_prep"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    OR (
      current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
      AND client_sf_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM mirror.client visible_client
         WHERE visible_client.sf_id = client_sf_id
      )
    )
  );

CREATE POLICY meeting_prep_insert_book_scope ON "app"."meeting_prep"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    OR (
      current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
      AND client_sf_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM mirror.client visible_client
         WHERE visible_client.sf_id = client_sf_id
      )
    )
  );

CREATE POLICY meeting_prep_update_book_scope ON "app"."meeting_prep"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    OR (
      current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
      AND client_sf_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM mirror.client visible_client
         WHERE visible_client.sf_id = client_sf_id
      )
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    OR (
      current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
      AND client_sf_id IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM mirror.client visible_client
         WHERE visible_client.sf_id = client_sf_id
      )
    )
  );

-- The existing meeting_prep_owner_all policy remains unchanged for migrations
-- and seeds executed by aoa/aoa_admin. DELETE remains both ungranted and without
-- a policy.
