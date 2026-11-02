-- ACAT record-id linking: enforce the 1:1 ACAT-RECORD <-> transfer invariant
-- at the DATABASE as the true backstop for the application-layer duplicate
-- guard, exactly as 20260716000000 does for acat_transfer_id.
--
-- The app guard (lib/data/acat-link.ts: findFirst-then-create/update, now
-- record-id-primary) has a TOCTOU window: two concurrent link/attach requests
-- for the same tracker record can both pass the read, then both write. This
-- PARTIAL UNIQUE INDEX closes that window — the second writer loses with a
-- unique-violation (Prisma P2002), which the actions map to the friendly
-- "already linked" message (acat-tracking/actions.ts classifyWriteError).
--
-- PARTIAL (WHERE acat_record_id IS NOT NULL): the vast majority of transfers
-- legitimately carry a NULL acat_record_id (no ACAT yet) and must remain
-- unconstrained. Prisma's schema DSL cannot express a filtered/partial unique
-- index (no WHERE on @@unique), so this is a hand-authored raw SQL migration and
-- schema.prisma intentionally does NOT declare an @@unique for this column (a
-- plain @@unique would generate a non-partial index — functionally similar under
-- Postgres NULL semantics, but we keep the explicit partial form, matching
-- transfer_acat_transfer_id_key). NOTE: `prisma migrate dev` will report this
-- index as drift; the repo deploys via `prisma migrate deploy`, which does not
-- diff — do not "fix" the drift by dropping the index.

-- (a) De-duplicate FIRST so CREATE UNIQUE INDEX cannot fail on pre-existing
--     data. For any acat_record_id shared by more than one row, keep the
--     EARLIEST by created_at (id as the deterministic tie-break) and NULL out
--     acat_record_id on the rest. This un-links the accidental duplicates
--     rather than deleting any transfer; the surviving row keeps the link.
--     A NO-OP today — acat_record_id has no writer yet (the only setter is the
--     synthetic seed), so every prod row is NULL — kept as the idiom's
--     defensive guarantee that the index creation below cannot fail.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY acat_record_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM "app"."transfer"
  WHERE acat_record_id IS NOT NULL
)
UPDATE "app"."transfer" AS t
SET acat_record_id = NULL
FROM ranked
WHERE t.id = ranked.id
  AND ranked.rn > 1;

-- (b) The partial unique index — the enforced 1:1 backstop.
CREATE UNIQUE INDEX "transfer_acat_record_id_key"
  ON "app"."transfer" ("acat_record_id")
  WHERE "acat_record_id" IS NOT NULL;
