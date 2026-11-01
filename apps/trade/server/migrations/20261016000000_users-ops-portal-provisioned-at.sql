-- Up Migration
--
-- Marks inactive "shadow" actor rows created for Ops Portal users who act
-- through the delegated /api/ops-portal surface without a standalone roster record.
-- Shadow rows are inserted with is_active = false, so they cannot sign in to the
-- standalone app and are not on the active trader roster; a trader can
-- reactivate one from the Users view to grant standalone access.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ops_portal_provisioned_at TIMESTAMPTZ;

-- Delegated calls resolve the person by verified email ignoring letter case.
CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (lower(email));

-- Down Migration

DROP INDEX IF EXISTS idx_users_lower_email;

ALTER TABLE users
    DROP COLUMN IF EXISTS ops_portal_provisioned_at;
