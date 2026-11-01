-- CreateTable
CREATE TABLE "DemoOutboxMessage" (
    "id" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoOutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoFeeCreditRow" (
    "id" SERIAL NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientUserId" TEXT,
    "feeType" TEXT NOT NULL,
    "feeAmount" DOUBLE PRECISION NOT NULL,
    "accountNumbers" TEXT NOT NULL,
    "waiverReason" TEXT,
    "submissionDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "apexRequest" TEXT,
    "userRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoFeeCreditRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoOutboxMessage_createdAt_idx" ON "DemoOutboxMessage"("createdAt");

-- CreateIndex
CREATE INDEX "DemoFeeCreditRow_accountNumbers_idx" ON "DemoFeeCreditRow"("accountNumbers");

