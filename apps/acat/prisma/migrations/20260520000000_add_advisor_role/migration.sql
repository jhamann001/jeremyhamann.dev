-- ticket: Add an ADVISOR role so the AllowedUser table can grant
-- read-only, redacted access to the new /advisor portal without
-- granting ops or admin privileges.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ADVISOR';
