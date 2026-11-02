-- The directory's outer query disables nested loops. Inheriting that setting
-- can cache repeated mapping/household scans inside this scalar resolver.
-- Permit indexed nested-loop plans only within the resolver; PostgreSQL restores
-- the caller's setting on return. Preserve its body, ACL and fixed search_path.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER FUNCTION app.resolve_crm_canonical_household_source_key(text)
  SET enable_nestloop = on;

COMMIT;
