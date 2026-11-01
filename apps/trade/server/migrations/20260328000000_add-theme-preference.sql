-- Up Migration

ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference VARCHAR(10) NOT NULL DEFAULT 'system';

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_theme CHECK (theme_preference IN ('light', 'dark', 'system'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Down Migration

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_theme;
ALTER TABLE users DROP COLUMN IF EXISTS theme_preference;
