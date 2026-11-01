-- Joint identities, release C: run SQL before its generated clients/consumers.
-- Pause identity writes until every consumer uses the junction. Legacy scalar
-- writes inconsistent with it fail explicitly; no unsafe dual-write fallback.
BEGIN;
-- Drain existing identity writers before touching AcatRecord, and fence any
-- fetch reserved before this upgrade. Both old and new resolvers treat this
-- error as unavailable even while the picker/cutover flag is false. Keep all
-- refresh invocations disabled until every junction-aware consumer is live;
-- only a successful new publication may clear this pause.
DO $acat_joint_upgrade_pause$
BEGIN
    PERFORM "id" FROM "CedarRidgeDirectorySync" WHERE "id" = 'global' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACAT_DIRECTORY_SINGLETON_REQUIRED';
    END IF;
    UPDATE "CedarRidgeDirectorySync"
        SET "attemptGeneration" = "attemptGeneration" + 1,
            "lastErrorCode" = 'JOINT_UPGRADE_PAUSED'
        WHERE "id" = 'global';
END;
$acat_joint_upgrade_pause$;

CREATE TABLE "AcatRecordClient" (
    "acatRecordId" TEXT NOT NULL,
    "cedar_ridge_user_id" TEXT NOT NULL,
    CONSTRAINT "AcatRecordClient_pkey" PRIMARY KEY ("acatRecordId", "cedar_ridge_user_id"),
    CONSTRAINT "AcatRecordClient_acatRecordId_fkey" FOREIGN KEY ("acatRecordId")
        REFERENCES "AcatRecord"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "AcatRecordClient_cedar_ridge_user_id_fkey" FOREIGN KEY ("cedar_ridge_user_id")
        REFERENCES "CedarRidgeClient"("cedar_ridge_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "AcatRecordClient_cedar_ridge_user_id_idx" ON "AcatRecordClient"("cedar_ridge_user_id");
ALTER TABLE "AcatRecord" ADD COLUMN "_identity_set_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Lock and seed before replacing the trigger. Neither the identity version nor
-- any business timestamp changes when an existing singleton is represented.
LOCK TABLE "AcatRecord" IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO "AcatRecordClient" ("acatRecordId", "cedar_ridge_user_id")
    SELECT "id", "cedar_ridge_user_id" FROM "AcatRecord" WHERE "cedar_ridge_user_id" IS NOT NULL;
UPDATE "AcatRecord" SET "_identity_set_ids" = ARRAY["cedar_ridge_user_id"]
    WHERE "cedar_ridge_user_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "acat_identity_version"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actual_ids TEXT[];
    projected_id TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."cedar_ridge_user_id" IS NOT NULL THEN
            RAISE EXCEPTION 'ACAT_LINK_SET_REQUIRED' USING ERRCODE = '23514';
        END IF;
        NEW."_identity_set_ids" := ARRAY[]::TEXT[];
        NEW."identityVersion" := 0;
        RETURN NEW;
    END IF;

    SELECT COALESCE(array_agg("cedar_ridge_user_id" ORDER BY "cedar_ridge_user_id" COLLATE "C"), ARRAY[]::TEXT[])
        INTO actual_ids FROM "AcatRecordClient" WHERE "acatRecordId" = OLD."id";
    projected_id := CASE WHEN cardinality(actual_ids) = 1 THEN actual_ids[1] ELSE NULL END;
    -- An explicit scalar change is permitted only if it already agrees with
    -- the authoritative set. A child refresh need not supply this projection.
    IF NEW."cedar_ridge_user_id" IS DISTINCT FROM OLD."cedar_ridge_user_id"
       AND NEW."cedar_ridge_user_id" IS DISTINCT FROM projected_id THEN
        RAISE EXCEPTION 'ACAT_LINK_SET_REQUIRED' USING ERRCODE = '23514';
    END IF;
    NEW."cedar_ridge_user_id" := projected_id;
    NEW."_identity_set_ids" := actual_ids;
    IF actual_ids IS DISTINCT FROM OLD."_identity_set_ids"
       OR NEW."cedar_ridge_user_id" IS DISTINCT FROM OLD."cedar_ridge_user_id"
       OR NEW."clientName" IS DISTINCT FROM OLD."clientName"
       OR NEW."apexAccountId" IS DISTINCT FROM OLD."apexAccountId"
       OR NEW."acatTransferId" IS DISTINCT FROM OLD."acatTransferId" THEN
        NEW."identityVersion" := OLD."identityVersion" + 1;
    ELSE
        NEW."identityVersion" := OLD."identityVersion";
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION "acat_client_keys_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."acatRecordId" IS DISTINCT FROM OLD."acatRecordId"
       OR NEW."cedar_ridge_user_id" IS DISTINCT FROM OLD."cedar_ridge_user_id" THEN
        RAISE EXCEPTION 'ACAT_LINK_KEYS_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "AcatRecordClient_immutable_keys" BEFORE UPDATE ON "AcatRecordClient"
    FOR EACH ROW EXECUTE FUNCTION "acat_client_keys_immutable"();

-- Both statement triggers use the same transition-table alias. Refresh each
-- affected parent once, in stable order. Its BEFORE trigger compares the real
-- set; no-op statements, ordering and caller-supplied counters cannot bump it.
CREATE FUNCTION "acat_refresh_client_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    record_id TEXT;
BEGIN
    FOR record_id IN SELECT DISTINCT "acatRecordId" FROM changed_client_links ORDER BY "acatRecordId"
    LOOP
        UPDATE "AcatRecord" SET "id" = "id" WHERE "id" = record_id;
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER "AcatRecordClient_after_insert" AFTER INSERT ON "AcatRecordClient"
    REFERENCING NEW TABLE AS changed_client_links
    FOR EACH STATEMENT EXECUTE FUNCTION "acat_refresh_client_parent"();
CREATE TRIGGER "AcatRecordClient_after_delete" AFTER DELETE ON "AcatRecordClient"
    REFERENCING OLD TABLE AS changed_client_links
    FOR EACH STATEMENT EXECUTE FUNCTION "acat_refresh_client_parent"();

-- TRUNCATE has no row transition table and would bypass parent versions.
-- Use ordinary DELETE (including parent CASCADE) for supported removals.
CREATE FUNCTION "acat_client_truncate_forbidden"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ACAT_LINK_TRUNCATE_FORBIDDEN' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "AcatRecordClient_no_truncate" BEFORE TRUNCATE ON "AcatRecordClient"
    FOR EACH STATEMENT EXECUTE FUNCTION "acat_client_truncate_forbidden"();
COMMIT;
