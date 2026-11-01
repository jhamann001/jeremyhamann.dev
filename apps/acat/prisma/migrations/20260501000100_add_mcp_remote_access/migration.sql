-- Add default-off MCP access controls to existing app users.
ALTER TABLE "AllowedUser" ADD COLUMN "mcpEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "McpSettings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT,
    "clientName" TEXT,
    "redirectUris" TEXT[],
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpOAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[],
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpOAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpConnection" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpRefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedToId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "reusedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAccessToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToolAuditLog" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT,
    "connectionId" TEXT,
    "requestId" TEXT,
    "toolName" TEXT NOT NULL,
    "argumentSummary" TEXT,
    "argumentHash" TEXT,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToolAuditLog_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton MCP settings row in the default-off state.
INSERT INTO "McpSettings" ("id", "enabled", "updatedAt")
VALUES ('global', false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- CreateIndex
CREATE INDEX "AllowedUser_mcpEnabled_idx" ON "AllowedUser"("mcpEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthClient_clientId_key" ON "McpOAuthClient"("clientId");
CREATE INDEX "McpOAuthClient_revokedAt_idx" ON "McpOAuthClient"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpOAuthAuthorizationCode_codeHash_key" ON "McpOAuthAuthorizationCode"("codeHash");
CREATE INDEX "McpOAuthAuthorizationCode_clientId_idx" ON "McpOAuthAuthorizationCode"("clientId");
CREATE INDEX "McpOAuthAuthorizationCode_userEmail_idx" ON "McpOAuthAuthorizationCode"("userEmail");
CREATE INDEX "McpOAuthAuthorizationCode_expiresAt_idx" ON "McpOAuthAuthorizationCode"("expiresAt");
CREATE INDEX "McpOAuthAuthorizationCode_consumedAt_idx" ON "McpOAuthAuthorizationCode"("consumedAt");

-- CreateIndex
CREATE INDEX "McpConnection_userEmail_idx" ON "McpConnection"("userEmail");
CREATE INDEX "McpConnection_clientId_idx" ON "McpConnection"("clientId");
CREATE INDEX "McpConnection_expiresAt_idx" ON "McpConnection"("expiresAt");
CREATE INDEX "McpConnection_revokedAt_idx" ON "McpConnection"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpRefreshToken_tokenHash_key" ON "McpRefreshToken"("tokenHash");
CREATE INDEX "McpRefreshToken_connectionId_idx" ON "McpRefreshToken"("connectionId");
CREATE INDEX "McpRefreshToken_expiresAt_idx" ON "McpRefreshToken"("expiresAt");
CREATE INDEX "McpRefreshToken_revokedAt_idx" ON "McpRefreshToken"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpAccessToken_tokenHash_key" ON "McpAccessToken"("tokenHash");
CREATE INDEX "McpAccessToken_connectionId_idx" ON "McpAccessToken"("connectionId");
CREATE INDEX "McpAccessToken_expiresAt_idx" ON "McpAccessToken"("expiresAt");
CREATE INDEX "McpAccessToken_revokedAt_idx" ON "McpAccessToken"("revokedAt");

-- CreateIndex
CREATE INDEX "McpToolAuditLog_userEmail_idx" ON "McpToolAuditLog"("userEmail");
CREATE INDEX "McpToolAuditLog_connectionId_idx" ON "McpToolAuditLog"("connectionId");
CREATE INDEX "McpToolAuditLog_toolName_idx" ON "McpToolAuditLog"("toolName");
CREATE INDEX "McpToolAuditLog_status_idx" ON "McpToolAuditLog"("status");
CREATE INDEX "McpToolAuditLog_createdAt_idx" ON "McpToolAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "McpOAuthAuthorizationCode" ADD CONSTRAINT "McpOAuthAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpOAuthAuthorizationCode" ADD CONSTRAINT "McpOAuthAuthorizationCode_userEmail_fkey" FOREIGN KEY ("userEmail") REFERENCES "AllowedUser"("email") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_userEmail_fkey" FOREIGN KEY ("userEmail") REFERENCES "AllowedUser"("email") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpConnection" ADD CONSTRAINT "McpConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpRefreshToken" ADD CONSTRAINT "McpRefreshToken_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAccessToken" ADD CONSTRAINT "McpAccessToken_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpToolAuditLog" ADD CONSTRAINT "McpToolAuditLog_userEmail_fkey" FOREIGN KEY ("userEmail") REFERENCES "AllowedUser"("email") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "McpToolAuditLog" ADD CONSTRAINT "McpToolAuditLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "McpConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
