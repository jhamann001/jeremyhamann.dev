-- CRM relationship snapshot — Cloud SQL definer visibility repair.
--
-- app.reconcile_crm_relationship_snapshot is SECURITY DEFINER so the runtime
-- identity_reconciler role never receives direct access to the dark
-- app.crm_relationship table or its internal helper functions.  In Cloud SQL,
-- the migration owner is intentionally not a superuser.  FORCE RLS therefore
-- applies while the function reads mirror.client.  The original local database
-- integration environment uses a superuser migration owner, which bypassed RLS
-- and hid this production-parity difference.
--
-- Grant only row visibility, only for SELECT, and only to the actual owner of
-- the constrained reconciliation function.  No mirror.client INSERT, UPDATE,
-- or DELETE policy is added, and no human or runtime role is broadened.

BEGIN;

DO $$
DECLARE
  reconciler_function regprocedure :=
    to_regprocedure(
      'app.reconcile_crm_relationship_snapshot(text,boolean,boolean,boolean)'
    );
  definer_role text;
BEGIN
  IF reconciler_function IS NULL THEN
    RAISE EXCEPTION 'CRM relationship reconciliation function is missing';
  END IF;

  SELECT quote_ident(pg_get_userbyid(p.proowner))
    INTO definer_role
    FROM pg_proc p
   WHERE p.oid = reconciler_function;

  IF definer_role IS NULL THEN
    RAISE EXCEPTION 'CRM relationship reconciliation definer is missing';
  END IF;

  DROP POLICY IF EXISTS client_crm_relationship_definer_read ON mirror.client;
  EXECUTE format(
    'CREATE POLICY client_crm_relationship_definer_read '
    'ON mirror.client FOR SELECT TO %s USING (true)',
    definer_role
  );
END $$;

COMMIT;
