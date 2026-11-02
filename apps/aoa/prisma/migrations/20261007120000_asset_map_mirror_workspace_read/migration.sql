-- ticket (owner ruling 2026-10-07): Advisor and Client Service open the
-- /asset-mapping workspace read-only, the old statement-pipeline `advisor` scope
-- (every household, firm-wide, as that app showed them).
--
-- Additive SELECT policies only, on the three tables the workspace reads. Each
-- needs BOTH the role GUC and app.asset_map_scope = 'workspace', which only the
-- workspace read actions set (ASSET_MAP_WORKSPACE_SCOPE in lib/data/asset-map-workspace-scope.ts),
-- so every other reader of these tables (the asset-transfer page, the review
-- queue) keeps its current rows for these roles: none. A missing GUC is NULL
-- and fails closed.
--
-- Unchanged: the *_ops_all and *_ingest_all policies, every grant (app_rw
-- already holds SELECT), every write policy, and mirror.acat_asset_map_link /
-- mirror.acat_asset_map_account_link.

CREATE POLICY acat_asset_map_household_workspace_read ON mirror.acat_asset_map_household
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND current_setting('app.asset_map_scope', true) = 'workspace'
  );
CREATE POLICY acat_asset_map_account_workspace_read ON mirror.acat_asset_map_account
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND current_setting('app.asset_map_scope', true) = 'workspace'
  );
CREATE POLICY acat_asset_map_position_workspace_read ON mirror.acat_asset_map_position
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND current_setting('app.asset_map_scope', true) = 'workspace'
  );
