-- Contact duplicate review uses the existing reversible AOA review model.
-- Keep the enum change isolated: PostgreSQL cannot safely consume a newly
-- added enum value in every command shape until the defining transaction ends.

ALTER TYPE app."CrmDuplicateEntityType" ADD VALUE IF NOT EXISTS 'CONTACT';
