-- Funding-plan approvals are an independent release. Track their version
-- when present, but support the production transfer schema before that column
-- is introduced. Preserve earlier migration checksums and all other fencing.
CREATE OR REPLACE FUNCTION app.advance_acat_link_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF ROW(NEW.client_sf_id,NEW.household_sf_id,NEW.deal_id,NEW.deal_sf_id,NEW.stage,
         NEW.funding_type,(to_jsonb(NEW)->'funding_plan_version'),NEW.archived_at,NEW.source,
         NEW.acat_record_id,NEW.acat_transfer_id,NEW.acat_auto_link_hold,
         NEW.acat_link_provenance,NEW.acat_link_decision_id,
         NEW.asset_map_folder_id,NEW.asset_map_custodian,NEW.asset_map_account_number,NEW.asset_map_account_type)
     IS DISTINCT FROM
     ROW(OLD.client_sf_id,OLD.household_sf_id,OLD.deal_id,OLD.deal_sf_id,OLD.stage,
         OLD.funding_type,(to_jsonb(OLD)->'funding_plan_version'),OLD.archived_at,OLD.source,
         OLD.acat_record_id,OLD.acat_transfer_id,OLD.acat_auto_link_hold,
         OLD.acat_link_provenance,OLD.acat_link_decision_id,
         OLD.asset_map_folder_id,OLD.asset_map_custodian,OLD.asset_map_account_number,OLD.asset_map_account_type) THEN
    NEW.acat_link_version := OLD.acat_link_version + 1;
    -- A legacy clear must suppress automatic reattachment too.
    IF (OLD.acat_record_id IS NOT NULL OR OLD.acat_transfer_id IS NOT NULL)
       AND NEW.acat_record_id IS NULL AND NEW.acat_transfer_id IS NULL THEN
      NEW.acat_auto_link_hold := true;
    END IF;
  ELSE
    NEW.acat_link_version := OLD.acat_link_version;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.advance_acat_link_version() FROM PUBLIC;
