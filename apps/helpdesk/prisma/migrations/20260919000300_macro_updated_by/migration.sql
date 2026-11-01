-- Migration: macro_updated_by
-- Purpose: create the foreign key behind `Macro.updatedById` -> `User`. That constraint is the ONLY new
-- database object in this file.
--
-- Header corrected 2026-09-19. The first version of this header claimed that `updatedById` was in no
-- migration at all, that a fresh `prisma migrate deploy` would therefore build a `Macro` table without
-- the column, and that /admin/macros would have failed on its first write. That was false.
-- `20260919000100_wave_a_foundation` already contains both halves:
--     line 127   ALTER TABLE "Macro" ADD COLUMN     "updatedById" TEXT;
--     line 306   CREATE INDEX "Macro_updatedById_idx" ON "Macro"("updatedById");
-- Every environment built from this history has always had the column and its index, and no write path
-- was ever at risk for want of them. The two statements below are re-assertions guarded with
-- IF NOT EXISTS; on any database built from the history they are no-ops. They are left in place because
-- they are already inert and removing them would only enlarge the diff against the applied version.
--
-- What was genuinely missing from the history is the RELATION. `prisma/schema.prisma` declares
--     Macro.updatedBy    User?   @relation("MacroUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)   (schema.prisma:567)
--     User.macrosUpdated Macro[] @relation("MacroUpdatedBy")                                                              (schema.prisma:328)
-- but no migration before this one creates `Macro_updatedById_fkey` — 20260916000000_init predates the
-- column, 20260919000100 adds the column and index without a constraint, and 20260919000200 does not
-- touch `Macro` at all. The relation was added to the datamodel out of band; that is the drift this file
-- closes, and it is the only thing this file actually does.
--
-- The constraint matches the datamodel exactly. `ON DELETE SET NULL` is `onDelete: SetNull` as written;
-- `ON UPDATE CASCADE` is Prisma's default `onUpdate` for an optional relation, which the datamodel leaves
-- unstated. SET NULL rather than RESTRICT is deliberate: a macro must outlive the person who last edited
-- it (the audit ledger, not this column, is the record of who changed what).
--
-- CHECKSUM — ACTION REQUIRED ON THE TWO LOCAL DATABASES. Prisma stores the SHA-256 of this entire file,
-- comments included, in `_prisma_migrations.checksum`. Rewriting this header therefore changes it, away
-- from the 4bfb917fdfd73d022014eccb0cf6e0309e5d33335ecaba5515d84363984454f4 that both helpdesk_dev and
-- wm_helpdesk_test recorded when the migration was applied. Reconciling those rows was attempted in this
-- pass and BLOCKED (writing to a shared database was not permitted here), so until someone runs the two
-- statements below, `prisma migrate status`, `migrate deploy` and `migrate dev` will report this
-- migration as "modified after it was applied" on both databases.
--
-- Only the comment block changed; the executable SQL below is byte-for-byte what was applied, so the
-- reconciliation is pure bookkeeping — no migration needs to be re-run and no database needs resetting:
--     NEW=$(shasum -a 256 prisma/migrations/20260919000300_macro_updated_by/migration.sql | cut -d' ' -f1)
--     for DB in helpdesk_dev wm_helpdesk_test; do \
--       psql "postgresql://localhost:5432/$DB" -c \
--         "UPDATE _prisma_migrations SET checksum='$NEW' WHERE migration_name='20260919000300_macro_updated_by';"; \
--     done
-- (The checksum is computed from the file rather than quoted here: a file cannot contain its own hash.)
-- Deployed environments that have never applied this migration need nothing: they run it fresh and
-- record the new checksum themselves. If this file is ever reverted, revert those rows with it.
--
-- DRIFT CHECK. `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel
-- ./prisma/schema.prisma --shadow-database-url <scratch db>` was NOT re-run for this correction: it
-- provisions and drops a shadow database, which this pass was not permitted to do. The parity claim above
-- was verified by reading the history instead. Every `Macro` object the migrations build, in order:
--     20260916000000_init   table Macro(id, key, title, queueId, body, channel, disclaimerKey, isActive,
--                           sortOrder, createdAt, updatedAt); Macro_pkey; Macro_key_key;
--                           Macro_queueId_isActive_idx; Macro_queueId_fkey (RESTRICT / CASCADE)
--     20260919000100        + column "updatedById" TEXT (line 127); + Macro_updatedById_idx (line 306)
--     20260919000200        (no Macro statements)
--     20260919000300        + Macro_updatedById_fkey (SET NULL / CASCADE)   <- this file
-- That set is column-for-column and index-for-index the `model Macro` block at schema.prisma:548-571,
-- with Macro_queueId_fkey and Macro_updatedById_fkey covering its two relation fields. Re-run the diff
-- above when a shadow database is available to confirm mechanically.

ALTER TABLE "Macro" ADD COLUMN IF NOT EXISTS "updatedById" TEXT;

CREATE INDEX IF NOT EXISTS "Macro_updatedById_idx" ON "Macro"("updatedById");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS; the guard makes a re-run a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Macro_updatedById_fkey' AND conrelid = '"Macro"'::regclass
  ) THEN
    ALTER TABLE "Macro"
      ADD CONSTRAINT "Macro_updatedById_fkey" FOREIGN KEY ("updatedById")
      REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
