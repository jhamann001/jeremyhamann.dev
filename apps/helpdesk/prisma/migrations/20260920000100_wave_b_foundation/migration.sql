-- Migration: wave_b_foundation
--
-- Columns, enums, tables and indexes only. Everything Prisma's model cannot express — CHECK
-- constraints, append-only triggers, the privilege floor and the rebuilt "ClientVisibleComment" view —
-- is in 20260920000200_wave_b_constraints, which runs in its own transaction. That split is load
-- bearing: PostgreSQL will not let a value added by `ALTER TYPE … ADD VALUE` be USED in the same
-- transaction, and the next migration's CHECK constraints name 'VOIDED'.
--
-- Generated with `prisma migrate diff --from-url <dev> --to-schema-datamodel prisma/schema.prisma
-- --script` (`migrate dev` refuses to run non-interactively here), then extended by hand with the
-- SuspendedIntake de-duplication that has to precede its new unique index.
--
-- CARRIED FROM WAVE A: the three borrowed audit
-- actions get their own enum values (TICKET_REQUESTER_EMAIL_CHANGED, INTAKE_DISCARDED,
-- ATTACHMENT_INTENT_CREATED); SuspendedIntake gains @@unique([messageId]) and senderVerified;
-- Comment gains inboundMessageId; MessageDelivery gains inReplyTo / references and the three new
-- statuses; Ticket gains the (status, createdAt DESC, id DESC) index.

-- CreateEnum
CREATE TYPE "TicketResolution" AS ENUM ('NONE', 'ANSWERED', 'COMPLETED', 'DUPLICATE', 'WITHDRAWN', 'NO_RESPONSE', 'ENTERED_IN_ERROR');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('MENTION', 'ASSIGNED', 'FOLLOWED_UPDATE', 'REQUESTER_REPLY', 'SLA_WARNING', 'SLA_BREACH', 'REVIEW_REQUESTED', 'FOLLOW_UP_DUE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'SLACK_DM', 'WEB_PUSH');

-- CreateEnum
CREATE TYPE "FollowerSource" AS ENUM ('MANUAL', 'MENTION', 'ASSIGNEE', 'AUTHOR');

-- CreateEnum
CREATE TYPE "TicketLinkKind" AS ENUM ('RELATED', 'DUPLICATE_OF', 'BLOCKS');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "ApiTokenScope" AS ENUM ('CLIENT_READ', 'CLIENT_WRITE', 'INTEGRATION_INGEST', 'INTEGRATION_OUTBOX', 'EXPORT_READ', 'MCP');

-- CreateEnum
CREATE TYPE "IdentityVerificationMethod" AS ENUM ('CALLBACK_KNOWN_NUMBER', 'IN_PERSON', 'VIDEO', 'DOCUMENT', 'KBA', 'ADVISOR_CONFIRMED', 'OTHER');

-- CreateEnum
CREATE TYPE "IdentityVerificationResult" AS ENUM ('VERIFIED', 'FAILED', 'OVERRIDDEN');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('APPROVED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'MANUAL', 'UNSUBSCRIBE_REQUEST', 'LOOP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TICKET_REQUESTER_EMAIL_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'INTAKE_DISCARDED';
ALTER TYPE "AuditAction" ADD VALUE 'ATTACHMENT_INTENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_PREFS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_FOLLOWED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_UNFOLLOWED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_LINK_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_LINK_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_MERGED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE 'BULK_ACTION_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'COMMENT_RETRACTED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'MESSAGE_BOUNCED';
ALTER TYPE "AuditAction" ADD VALUE 'MACRO_ACTIONS_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'AI_DRAFT_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'SLA_POLICY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_ENDPOINT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_ENDPOINT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_ENDPOINT_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_DELIVERY_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_DELIVERY_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_DELIVERY_DEAD';
ALTER TYPE "AuditAction" ADD VALUE 'REVIEW_STAMPED';
ALTER TYPE "AuditAction" ADD VALUE 'IDENTITY_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE 'IDENTITY_GATE_OVERRIDDEN';
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE 'API_TOKEN_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'API_TOKEN_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'API_TOKEN_ROTATED';
ALTER TYPE "AuditAction" ADD VALUE 'PUSH_SUBSCRIBED';
ALTER TYPE "AuditAction" ADD VALUE 'PUSH_UNSUBSCRIBED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPRESSION_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPRESSION_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE 'TICKET_IMPORTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'NOTIFICATION';
ALTER TYPE "AuditEntityType" ADD VALUE 'TICKET_LINK';
ALTER TYPE "AuditEntityType" ADD VALUE 'WEBHOOK_ENDPOINT';
ALTER TYPE "AuditEntityType" ADD VALUE 'WEBHOOK_DELIVERY';
ALTER TYPE "AuditEntityType" ADD VALUE 'API_TOKEN';
ALTER TYPE "AuditEntityType" ADD VALUE 'REVIEW_STAMP';
ALTER TYPE "AuditEntityType" ADD VALUE 'IDENTITY_VERIFICATION';
ALTER TYPE "AuditEntityType" ADD VALUE 'PUSH_SUBSCRIPTION';
ALTER TYPE "AuditEntityType" ADD VALUE 'SUPPRESSION';
ALTER TYPE "AuditEntityType" ADD VALUE 'SLA_POLICY';
ALTER TYPE "AuditEntityType" ADD VALUE 'REPORT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageDeliveryStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "MessageDeliveryStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "MessageDeliveryStatus" ADD VALUE 'FAILED_SUPPRESSED';

-- AlterEnum
ALTER TYPE "SuspendedIntakeReason" ADD VALUE 'FORWARDED';

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'VOIDED';

-- DropIndex
DROP INDEX "SuspendedIntake_messageId_idx";

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "inboundMessageId" TEXT;

-- AlterTable
ALTER TABLE "Macro" ADD COLUMN     "actions" JSONB;

-- AlterTable
ALTER TABLE "MessageDelivery" ADD COLUMN     "bounceType" TEXT,
ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "inReplyTo" TEXT,
ADD COLUMN     "references" TEXT;

-- AlterTable
ALTER TABLE "Queue" ADD COLUMN     "autoAssign" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SLA" ADD COLUMN     "warningMinutes" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "SuspendedIntake" ADD COLUMN     "candidateRequesterEmail" TEXT,
ADD COLUMN     "discardedAt" TIMESTAMP(3),
ADD COLUMN     "discardedById" TEXT,
ADD COLUMN     "senderVerified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "resolution" "TicketResolution" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "voidReason" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "backupUserId" TEXT,
ADD COLUMN     "notificationPrefs" JSONB,
ADD COLUMN     "outOfOfficeUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "actorId" TEXT,
    "ticketId" TEXT,
    "commentId" TEXT,
    "preview" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "channels" "NotificationChannel"[] DEFAULT ARRAY[]::"NotificationChannel"[],

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketFollower" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "FollowerSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "TicketFollower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComposerDraft" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "CommentVisibility" NOT NULL,
    "body" TEXT NOT NULL,
    "macroId" TEXT,
    "disclaimerKey" "DisclaimerKey" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposerDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentRetraction" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "retractedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentRetraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLink" (
    "id" TEXT NOT NULL,
    "fromTicketId" TEXT NOT NULL,
    "toTicketId" TEXT NOT NULL,
    "kind" "TicketLinkKind" NOT NULL DEFAULT 'RELATED',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "TicketLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "events" "AuditAction"[] DEFAULT ARRAY[]::"AuditAction"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "auditSeq" BIGINT NOT NULL,
    "eventAction" "AuditAction" NOT NULL,
    "entityId" TEXT,
    "ticketId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientApiToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" "ApiTokenScope"[] DEFAULT ARRAY[]::"ApiTokenScope"[],
    "requesterEmail" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "ClientApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityVerification" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "verifiedById" TEXT NOT NULL,
    "method" "IdentityVerificationMethod" NOT NULL,
    "result" "IdentityVerificationResult" NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewStamp" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "verdict" "ReviewVerdict" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewStamp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequesterSuppression" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "RequesterSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpNudge" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "dueOn" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUpNudge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_ticketId_idx" ON "Notification"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "TicketFollower_userId_removedAt_idx" ON "TicketFollower"("userId", "removedAt");

-- CreateIndex
CREATE INDEX "TicketFollower_ticketId_removedAt_idx" ON "TicketFollower"("ticketId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketFollower_ticketId_userId_key" ON "TicketFollower"("ticketId", "userId");

-- CreateIndex
CREATE INDEX "ComposerDraft_userId_updatedAt_idx" ON "ComposerDraft"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComposerDraft_ticketId_userId_channel_key" ON "ComposerDraft"("ticketId", "userId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "CommentRetraction_commentId_key" ON "CommentRetraction"("commentId");

-- CreateIndex
CREATE INDEX "CommentRetraction_createdAt_idx" ON "CommentRetraction"("createdAt");

-- CreateIndex
CREATE INDEX "CommentRetraction_retractedById_idx" ON "CommentRetraction"("retractedById");

-- CreateIndex
CREATE INDEX "TicketLink_toTicketId_removedAt_idx" ON "TicketLink"("toTicketId", "removedAt");

-- CreateIndex
CREATE INDEX "TicketLink_fromTicketId_removedAt_idx" ON "TicketLink"("fromTicketId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLink_fromTicketId_toTicketId_kind_key" ON "TicketLink"("fromTicketId", "toTicketId", "kind");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_isActive_revokedAt_idx" ON "WebhookEndpoint"("isActive", "revokedAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_auditSeq_key" ON "WebhookDelivery"("endpointId", "auditSeq");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientApiToken_prefix_key" ON "ClientApiToken"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ClientApiToken_tokenHash_key" ON "ClientApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ClientApiToken_revokedAt_expiresAt_idx" ON "ClientApiToken"("revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "IdentityVerification_ticketId_createdAt_idx" ON "IdentityVerification"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "IdentityVerification_result_createdAt_idx" ON "IdentityVerification"("result", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewStamp_createdAt_idx" ON "ReviewStamp"("createdAt");

-- CreateIndex
CREATE INDEX "ReviewStamp_verdict_createdAt_idx" ON "ReviewStamp"("verdict", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewStamp_commentId_reviewerId_key" ON "ReviewStamp"("commentId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "RequesterSuppression_email_key" ON "RequesterSuppression"("email");

-- CreateIndex
CREATE INDEX "RequesterSuppression_removedAt_idx" ON "RequesterSuppression"("removedAt");

-- CreateIndex
CREATE INDEX "FollowUpNudge_firedAt_idx" ON "FollowUpNudge"("firedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpNudge_ticketId_dueOn_key" ON "FollowUpNudge"("ticketId", "dueOn");

-- CreateIndex
CREATE INDEX "Comment_inboundMessageId_idx" ON "Comment"("inboundMessageId");

-- CreateIndex
CREATE INDEX "MessageDelivery_toAddress_createdAt_idx" ON "MessageDelivery"("toAddress", "createdAt");

-- ---------------------------------------------------------------------------
-- SuspendedIntake.@@unique([messageId]) — carried from Wave A CONTRACT §14.
--
-- `suspendIntake` already carries the P2002-recover-and-return-the-winner pattern, but that recovery
-- is INERT until this index exists: two overlapping deliveries of one inbound message (an n8n retry on
-- a slow webhook) both insert today. The index makes the recovery live.
--
-- Any duplicate already stored has to go first, and the table carries a BEFORE DELETE guard
-- (20260919000200). The trigger is disabled for exactly this statement and re-enabled immediately.
-- The rule keeps the FIRST row for each Message-ID — the one whose id the API already returned —
-- ordering by (createdAt, id) so the choice is deterministic when two rows share a timestamp.
-- On every environment checked this is a no-op; it is here so it stays one.
-- ---------------------------------------------------------------------------
ALTER TABLE "SuspendedIntake" DISABLE TRIGGER "suspended_intake_no_delete";
DELETE FROM "SuspendedIntake" a
 USING "SuspendedIntake" b
 WHERE a."messageId" IS NOT NULL
   AND a."messageId" = b."messageId"
   AND (a."createdAt", a."id") > (b."createdAt", b."id");
ALTER TABLE "SuspendedIntake" ENABLE TRIGGER "suspended_intake_no_delete";

-- CreateIndex
CREATE UNIQUE INDEX "SuspendedIntake_messageId_key" ON "SuspendedIntake"("messageId");

-- CreateIndex
CREATE INDEX "Ticket_status_createdAt_id_idx" ON "Ticket"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_mergedIntoId_idx" ON "Ticket"("mergedIntoId");

-- CreateIndex
CREATE INDEX "Ticket_status_resolution_idx" ON "Ticket"("status", "resolution");

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_status_updatedAt_idx" ON "Ticket"("assigneeId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "User_backupUserId_idx" ON "User"("backupUserId");

-- CreateIndex
CREATE INDEX "User_outOfOfficeUntil_idx" ON "User"("outOfOfficeUntil");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_backupUserId_fkey" FOREIGN KEY ("backupUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspendedIntake" ADD CONSTRAINT "SuspendedIntake_discardedById_fkey" FOREIGN KEY ("discardedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketFollower" ADD CONSTRAINT "TicketFollower_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketFollower" ADD CONSTRAINT "TicketFollower_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComposerDraft" ADD CONSTRAINT "ComposerDraft_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComposerDraft" ADD CONSTRAINT "ComposerDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentRetraction" ADD CONSTRAINT "CommentRetraction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentRetraction" ADD CONSTRAINT "CommentRetraction_retractedById_fkey" FOREIGN KEY ("retractedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_fromTicketId_fkey" FOREIGN KEY ("fromTicketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_toTicketId_fkey" FOREIGN KEY ("toTicketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientApiToken" ADD CONSTRAINT "ClientApiToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientApiToken" ADD CONSTRAINT "ClientApiToken_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewStamp" ADD CONSTRAINT "ReviewStamp_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewStamp" ADD CONSTRAINT "ReviewStamp_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequesterSuppression" ADD CONSTRAINT "RequesterSuppression_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequesterSuppression" ADD CONSTRAINT "RequesterSuppression_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpNudge" ADD CONSTRAINT "FollowUpNudge_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

