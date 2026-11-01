-- Up Migration
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id);

-- Down Migration
DROP INDEX IF EXISTS idx_audit_user_id;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS user_id;
