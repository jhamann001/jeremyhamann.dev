-- Migration: wave_a_foundation
-- Purpose: the schema delta every Wave A slice codes against — channel/identity/idempotency columns on
-- Ticket, requester-authored comments, the compliance flags, the Ops Portal pointer columns, Cedar Ridge's real
-- intake categories, and the six new tables (IngestReceipt, SuspendedIntake, MessageDelivery,
-- Attachment, SlaAlert, JobCursor).
--
-- Widening only: `Ticket.requesterEmail` and `Comment.authorId` become nullable, every new column has a
-- default that makes existing rows correct (brand CEDAR_RIDGE_WEALTH, source STAFF_FORM, authorKind STAFF),
-- and every enum change is an append. No column is dropped, no value is renamed, nothing is reordered.
--
-- The CHECK constraints, the append-only triggers on the two ledger tables, the privilege floor and the
-- updated "ClientVisibleComment" view live in the next migration (20260919000200_wave_a_constraints),
-- deliberately outside Prisma's model so `prisma migrate dev` never drops them.

-- CreateEnum
CREATE TYPE "CommentAuthorKind" AS ENUM ('STAFF', 'REQUESTER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TicketBrand" AS ENUM ('CEDAR_RIDGE_WEALTH', 'CEDAR_RIDGE_DIRECT');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('STAFF_FORM', 'EMAIL', 'CLIENT_APP', 'PHONE', 'VOICEMAIL', 'SLACK', 'SYSTEM', 'IMPORT', 'API');

-- CreateEnum
CREATE TYPE "EscalationTarget" AS ENUM ('NONE', 'COMPLIANCE', 'FRAUD', 'OPERATIONS', 'ADVISOR');

-- CreateEnum
CREATE TYPE "SuspendedIntakeReason" AS ENUM ('UNAUTHENTICATED', 'AUTO_REPLY', 'BOUNCE', 'SYSTEM_SENDER', 'SPAM', 'UNKNOWN_MAILBOX', 'LOOP_DETECTED', 'PARSE_FAILED', 'OVERSIZE');

-- CreateEnum
CREATE TYPE "SuspendedIntakeStatus" AS ENUM ('NEW', 'RELEASED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('QUEUED', 'LEASED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('UPLOAD', 'EMAIL_PART', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AttachmentState" AS ENUM ('PENDING', 'READY', 'REMOVED');

-- CreateEnum
CREATE TYPE "AttachmentVisibility" AS ENUM ('INTERNAL');

-- CreateEnum
CREATE TYPE "SlaAlertPhase" AS ENUM ('FIRST_RESPONSE', 'RESOLUTION');

-- CreateEnum
CREATE TYPE "SlaAlertKind" AS ENUM ('WARNING', 'BREACHED');

-- CreateEnum
CREATE TYPE "ClientContactChannel" AS ENUM ('PHONE', 'VOICEMAIL_RETURNED', 'IN_PERSON', 'SMS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'COMMENT_ADDED_REQUESTER';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_REOPENED_BY_REQUESTER';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_INGESTED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_LINKED';
ALTER TYPE "AuditAction" ADD VALUE 'INTAKE_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE 'INTAKE_RELEASED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_QUEUED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_LEASED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'ATTACHMENT_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'ATTACHMENT_VIEWED';
ALTER TYPE "AuditAction" ADD VALUE 'ATTACHMENT_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'SLA_ALERT';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_LIST_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_EXPORT_READ';
ALTER TYPE "AuditAction" ADD VALUE 'CLIENT_CONTACT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_REACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'MACRO_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'MACRO_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'MACRO_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'MACRO_REACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'AUTHZ_DENIED_COALESCED';
ALTER TYPE "AuditAction" ADD VALUE 'JOB_RUN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'ATTACHMENT';
ALTER TYPE "AuditEntityType" ADD VALUE 'MESSAGE_DELIVERY';
ALTER TYPE "AuditEntityType" ADD VALUE 'SUSPENDED_INTAKE';
ALTER TYPE "AuditEntityType" ADD VALUE 'JOB';
ALTER TYPE "AuditEntityType" ADD VALUE 'ENDPOINT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TicketCategory" ADD VALUE 'ACCOUNT_CLOSURE';
ALTER TYPE "TicketCategory" ADD VALUE 'BENEFICIARY_TOD';
ALTER TYPE "TicketCategory" ADD VALUE 'RETURNED_CHECK';
ALTER TYPE "TicketCategory" ADD VALUE 'RETURNED_MAIL';
ALTER TYPE "TicketCategory" ADD VALUE 'PASSKEY_LOGIN';
ALTER TYPE "TicketCategory" ADD VALUE 'IDENTITY_VERIFICATION';
ALTER TYPE "TicketCategory" ADD VALUE 'COMPLAINT';
ALTER TYPE "TicketCategory" ADD VALUE 'RETIREMENT_DISTRIBUTION';
ALTER TYPE "TicketCategory" ADD VALUE 'COST_BASIS';
ALTER TYPE "TicketCategory" ADD VALUE 'VOICEMAIL_CALLBACK';
ALTER TYPE "TicketCategory" ADD VALUE 'STATEMENT_REQUEST';

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "authorKind" "CommentAuthorKind" NOT NULL DEFAULT 'STAFF',
ALTER COLUMN "authorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Macro" ADD COLUMN     "updatedById" TEXT;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "brand" "TicketBrand" NOT NULL DEFAULT 'CEDAR_RIDGE_WEALTH',
ADD COLUMN     "complaintFiledAt" TIMESTAMP(3),
ADD COLUMN     "escalationTarget" "EscalationTarget" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "followUpAt" TIMESTAMP(3),
ADD COLUMN     "householdId" TEXT,
ADD COLUMN     "isComplaint" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "linkedFromTicketId" TEXT,
ADD COLUMN     "requesterExternalId" TEXT,
ADD COLUMN     "requesterPhone" TEXT,
ADD COLUMN     "source" "TicketSource" NOT NULL DEFAULT 'STAFF_FORM',
ALTER COLUMN "requesterEmail" DROP NOT NULL;

-- CreateTable
CREATE TABLE "IngestReceipt" (
    "id" TEXT NOT NULL,
    "source" "TicketSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "ticketId" TEXT,
    "commentId" TEXT,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuspendedIntake" (
    "id" TEXT NOT NULL,
    "reason" "SuspendedIntakeReason" NOT NULL,
    "status" "SuspendedIntakeStatus" NOT NULL DEFAULT 'NEW',
    "mailbox" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "messageId" TEXT,
    "rawRef" TEXT,
    "headers" JSONB,
    "snippet" TEXT,
    "ticketId" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuspendedIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "brand" "TicketBrand" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "replyTo" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "leasedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "commentId" TEXT,
    "uploaderId" TEXT,
    "kind" "AttachmentKind" NOT NULL DEFAULT 'UPLOAD',
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT,
    "objectKey" TEXT NOT NULL,
    "state" "AttachmentState" NOT NULL DEFAULT 'PENDING',
    "visibility" "AttachmentVisibility" NOT NULL DEFAULT 'INTERNAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaAlert" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "phase" "SlaAlertPhase" NOT NULL,
    "kind" "SlaAlertKind" NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "minutesOver" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SlaAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCursor" (
    "name" TEXT NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobCursor_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "IngestReceipt_ticketId_idx" ON "IngestReceipt"("ticketId");

-- CreateIndex
CREATE INDEX "IngestReceipt_receivedAt_idx" ON "IngestReceipt"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IngestReceipt_source_externalId_key" ON "IngestReceipt"("source", "externalId");

-- CreateIndex
CREATE INDEX "SuspendedIntake_status_createdAt_idx" ON "SuspendedIntake"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SuspendedIntake_mailbox_createdAt_idx" ON "SuspendedIntake"("mailbox", "createdAt");

-- CreateIndex
CREATE INDEX "SuspendedIntake_messageId_idx" ON "SuspendedIntake"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_commentId_key" ON "MessageDelivery"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_messageId_key" ON "MessageDelivery"("messageId");

-- CreateIndex
CREATE INDEX "MessageDelivery_status_createdAt_idx" ON "MessageDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MessageDelivery_ticketId_idx" ON "MessageDelivery"("ticketId");

-- CreateIndex
CREATE INDEX "MessageDelivery_status_leaseExpiresAt_idx" ON "MessageDelivery"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");

-- CreateIndex
CREATE INDEX "Attachment_ticketId_state_createdAt_idx" ON "Attachment"("ticketId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "Attachment_commentId_idx" ON "Attachment"("commentId");

-- CreateIndex
CREATE INDEX "Attachment_uploaderId_idx" ON "Attachment"("uploaderId");

-- CreateIndex
CREATE INDEX "Attachment_removedById_idx" ON "Attachment"("removedById");

-- CreateIndex
CREATE INDEX "SlaAlert_firedAt_idx" ON "SlaAlert"("firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlaAlert_ticketId_phase_kind_key" ON "SlaAlert"("ticketId", "phase", "kind");

-- CreateIndex
CREATE INDEX "Comment_ticketId_authorKind_createdAt_idx" ON "Comment"("ticketId", "authorKind", "createdAt");

-- CreateIndex
CREATE INDEX "Macro_updatedById_idx" ON "Macro"("updatedById");

-- CreateIndex
CREATE INDEX "Ticket_requesterPhone_idx" ON "Ticket"("requesterPhone");

-- CreateIndex
CREATE INDEX "Ticket_householdId_idx" ON "Ticket"("householdId");

-- CreateIndex
CREATE INDEX "Ticket_requesterExternalId_idx" ON "Ticket"("requesterExternalId");

-- CreateIndex
CREATE INDEX "Ticket_isComplaint_createdAt_idx" ON "Ticket"("isComplaint", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_status_followUpAt_idx" ON "Ticket"("status", "followUpAt");

-- CreateIndex
CREATE INDEX "Ticket_updatedAt_id_idx" ON "Ticket"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "Ticket_linkedFromTicketId_idx" ON "Ticket"("linkedFromTicketId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_source_externalId_key" ON "Ticket"("source", "externalId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_linkedFromTicketId_fkey" FOREIGN KEY ("linkedFromTicketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestReceipt" ADD CONSTRAINT "IngestReceipt_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestReceipt" ADD CONSTRAINT "IngestReceipt_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspendedIntake" ADD CONSTRAINT "SuspendedIntake_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspendedIntake" ADD CONSTRAINT "SuspendedIntake_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlaAlert" ADD CONSTRAINT "SlaAlert_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

