-- CRM weak-signal detector: allow the tightly-owned SECURITY DEFINER routine
-- to read household attributes under FORCE RLS.
--
-- The detector already owns the function and has controlled policies for the
-- identity registry, source mappings, clients, account holders, and orphan
-- evidence. Weak household review signals additionally read only
-- mirror.household rows (name/advisor/stage) inside that function. Without an
-- owner-targeted row policy, Cloud SQL correctly hides every household row and
-- the weak detector returns no candidates. No runtime role receives new table
-- access and no source data is mutated here.

BEGIN;

DO $$
DECLARE
  definer_role text := quote_ident(current_user);
BEGIN
  EXECUTE format(
    'CREATE POLICY household_duplicate_definer_read '
    'ON mirror.household FOR SELECT TO %s USING (true)',
    definer_role
  );
END $$;

COMMIT;
