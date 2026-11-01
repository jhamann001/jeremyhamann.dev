-- Add optional CRM status metadata without changing identities or membership.
-- Existing clients remain NULL until the next complete directory publication.
ALTER TABLE "CedarRidgeClient" ADD COLUMN "crmStage" TEXT;
