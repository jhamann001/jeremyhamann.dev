-- Release A: SQL only. Deploy this before the Prisma schema/new app or MCP client.
-- All existing transfer fields and business timestamps remain untouched.
CREATE TABLE "CedarRidgeClient" (
    "cedar_ridge_user_id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "lastSeenSnapshotId" TEXT NOT NULL,
    CONSTRAINT "CedarRidgeClient_pkey" PRIMARY KEY ("cedar_ridge_user_id"),
    CONSTRAINT "CedarRidgeClient_eligibility_check" CHECK ("eligibility" IN ('ACTIVE', 'INACTIVE', 'UNKNOWN'))
);
CREATE INDEX "CedarRidgeClient_normalizedName_idx" ON "CedarRidgeClient"("normalizedName");

CREATE TABLE "CedarRidgeAccount" (
    "investmentAccountId" TEXT NOT NULL,
    "custodian" TEXT NOT NULL,
    "custodianAccountId" TEXT,
    "accountNumber" TEXT,
    "normalizedAccountNumber" TEXT,
    "status" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenSnapshotId" TEXT NOT NULL,
    CONSTRAINT "CedarRidgeAccount_pkey" PRIMARY KEY ("investmentAccountId")
);
CREATE UNIQUE INDEX "CedarRidgeAccount_custodian_normalizedAccountNumber_key"
    ON "CedarRidgeAccount"("custodian", "normalizedAccountNumber");

CREATE TABLE "CedarRidgeAccountMember" (
    "investmentAccountId" TEXT NOT NULL,
    "cedar_ridge_user_id" TEXT NOT NULL,
    "relationshipType" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenSnapshotId" TEXT NOT NULL,
    CONSTRAINT "CedarRidgeAccountMember_pkey" PRIMARY KEY ("investmentAccountId", "cedar_ridge_user_id"),
    CONSTRAINT "CedarRidgeAccountMember_account_fkey" FOREIGN KEY ("investmentAccountId")
        REFERENCES "CedarRidgeAccount"("investmentAccountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CedarRidgeAccountMember_client_fkey" FOREIGN KEY ("cedar_ridge_user_id")
        REFERENCES "CedarRidgeClient"("cedar_ridge_user_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "CedarRidgeAccountMember_cedar_ridge_user_id_idx" ON "CedarRidgeAccountMember"("cedar_ridge_user_id");

-- This permanent singleton is also the publication lock. Identity writers take
-- FOR SHARE before reading directory rows, then lock transfer rows. Publishers
-- take FOR UPDATE before modifying directory rows, in that same lock order.
CREATE TABLE "CedarRidgeDirectorySync" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "installationId" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attemptGeneration" INTEGER NOT NULL DEFAULT 0,
    "publishedGeneration" INTEGER NOT NULL DEFAULT 0,
    "activeSnapshotId" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "sourceAsOf" TIMESTAMP(3),
    "sourceHealth" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT,
    "sourceFingerprint" TEXT,
    "clientCount" INTEGER NOT NULL DEFAULT 0,
    "accountCount" INTEGER NOT NULL DEFAULT 0,
    "membershipCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    CONSTRAINT "CedarRidgeDirectorySync_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CedarRidgeDirectorySync_singleton_check" CHECK ("id" = 'global'),
    CONSTRAINT "CedarRidgeDirectorySync_sourceHealth_check" CHECK ("sourceHealth" IN ('FRESH', 'STALE', 'UNKNOWN'))
);
INSERT INTO "CedarRidgeDirectorySync" ("id") VALUES ('global');

ALTER TABLE "AcatRecord" ADD COLUMN "cedar_ridge_user_id" TEXT;
ALTER TABLE "AcatRecord" ADD COLUMN "identityVersion" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "AcatRecord_cedar_ridge_user_id_idx" ON "AcatRecord"("cedar_ridge_user_id");
ALTER TABLE "AcatRecord" ADD CONSTRAINT "AcatRecord_cedar_ridge_user_id_fkey"
    FOREIGN KEY ("cedar_ridge_user_id") REFERENCES "CedarRidgeClient"("cedar_ridge_user_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Database-owned versioning covers direct SQL/older binaries too. It is not an
-- authorization or membership check: those remain mandatory in every writer.
CREATE FUNCTION "acat_identity_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."identityVersion" := 0;
    ELSIF NEW."cedar_ridge_user_id" IS DISTINCT FROM OLD."cedar_ridge_user_id"
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
CREATE TRIGGER "AcatRecord_identity_version"
    BEFORE INSERT OR UPDATE ON "AcatRecord"
    FOR EACH ROW EXECUTE FUNCTION "acat_identity_version"();
