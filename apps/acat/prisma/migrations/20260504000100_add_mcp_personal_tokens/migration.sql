CREATE TABLE "McpPersonalToken" (
    "id"         TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "prefix"     TEXT NOT NULL,
    "lastFour"   TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "userEmail"  TEXT NOT NULL,
    "scopes"     TEXT[],
    "revokedAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpPersonalToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpPersonalToken_tokenHash_key" ON "McpPersonalToken"("tokenHash");
CREATE INDEX "McpPersonalToken_userEmail_idx" ON "McpPersonalToken"("userEmail");
CREATE INDEX "McpPersonalToken_tokenHash_idx" ON "McpPersonalToken"("tokenHash");
CREATE INDEX "McpPersonalToken_revokedAt_idx" ON "McpPersonalToken"("revokedAt");

ALTER TABLE "McpPersonalToken"
    ADD CONSTRAINT "McpPersonalToken_userEmail_fkey"
    FOREIGN KEY ("userEmail") REFERENCES "AllowedUser"("email")
    ON DELETE CASCADE ON UPDATE CASCADE;
