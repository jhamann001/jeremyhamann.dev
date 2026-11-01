ALTER TABLE "Custodian" ADD COLUMN "projectionRevision" INTEGER;

CREATE TABLE "CustodianProjectionState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "appliedRevision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustodianProjectionState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustodianProjectionState_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "CustodianProjectionState_appliedRevision_check" CHECK ("appliedRevision" >= 0)
);

INSERT INTO "CustodianProjectionState" ("id", "appliedRevision", "updatedAt")
VALUES (1, 0, CURRENT_TIMESTAMP);

CREATE TABLE "CustodianProjectionReceipt" (
    "revision" INTEGER NOT NULL,
    "bodySha256" TEXT NOT NULL,
    CONSTRAINT "CustodianProjectionReceipt_pkey" PRIMARY KEY ("revision"),
    CONSTRAINT "CustodianProjectionReceipt_revision_check" CHECK ("revision" >= 1),
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
