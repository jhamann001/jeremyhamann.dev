-- Presence: track when each AllowedUser was last active in the app.
-- The /api/presence/heartbeat route updates this column ~every 30s while
-- the user has a focused tab and is interacting; /api/presence reads it
-- to populate the team-online indicator in the nav rail.
ALTER TABLE "AllowedUser" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

CREATE INDEX "AllowedUser_lastSeenAt_idx" ON "AllowedUser"("lastSeenAt");
