-- CRM relationship layer — Phase 4D Operations-only read seam.
--
-- This migration exposes active relationship rows to the existing app runtime
-- only when its transaction-local RLS role is ADMIN or OPERATIONS. It adds no
-- data, write grant, traversal function, source-key access, or authorization
-- behavior. The application owns the bounded recursive query so every request
-- still passes through withUserScope and the default-off CRM_RELATIONSHIPS flag.

BEGIN;

GRANT SELECT (
  "id", "relationship_type", "from_identity_id", "to_identity_id",
  "relationship_state"
) ON "app"."crm_relationship" TO app_rw;
REVOKE INSERT, UPDATE, DELETE ON "app"."crm_relationship" FROM app_rw;

CREATE POLICY crm_relationship_ops_read
  ON "app"."crm_relationship"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND "relationship_state" = 'ACTIVE'
  );

COMMIT;
